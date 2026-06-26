/**
 * Microphone capture for Odla. Deliberately SIMPLE and standard — the way normal web voice apps do
 * it — because clever variations (forcing 16 kHz, disabling gain/noise, AudioWorklets) only hurt
 * recognition on real-world mics. We:
 *   • keep the browser's voice enhancements ON (echo cancel + noise suppression + AUTO GAIN) — these
 *     normalize a quiet/typical mic so the model gets a clean, well-leveled signal (turning them OFF
 *     made speech too quiet/noisy and the model misheard),
 *   • capture mono at the device's native rate and let sherpa-onnx resample to the model's 16 kHz
 *     (its resampler is excellent — the diagnostic proved this path is flawless),
 *   • use a plain ScriptProcessorNode (rock-solid; an utterance is only a few seconds, so main-thread
 *     capture is a non-issue), with a zero-gain sink so it pumps without echoing to the speakers.
 */

import { useSettingsStore } from '@/stores/useSettingsStore'

const FALLBACK_RATE = 16000

/**
 * Devices that are NOT real microphones but software routers / mixers / AI-noise-gates. Their
 * processing (e.g. SteelSeries Sonar's ClearCast, VoiceMeeter, Krisp) frequently gates speech down to
 * digital silence before it ever reaches us — so in AUTO mode we skip them and prefer a physical mic.
 */
const VIRTUAL_MIC_RE = /virtual|sonar|steelseries|voicemeeter|vb[-\s]?audio|vb[-\s]?cable|cable output|stereo mix|mezcla est|wave\s?link|wavelink|nvidia broadcast|krisp|loopback|aggregate|what u hear/i
const NON_SPEECH_INPUT_RE = /line in|entrada de linea|digital audio|spdif|monitor|output|salida/i
const DEDICATED_MIC_RE = /hyperx|solocast|blue|yeti|rode|shure|samson|fifine|elgato|wave:?\s?3|wave:?\s?x|usb (?:audio|pnp|microphone|mic)|micr.fono usb/i
const MIC_WORD_RE = /microphone|mic\b|microfono|micr.fono|headset|auricular|array/i

interface MicGraph {
  ctx: AudioContext
  stream: MediaStream
  source: MediaStreamAudioSourceNode
  analyser: AnalyserNode
  processor: ScriptProcessorNode
  sink: GainNode
  timeBuf: Float32Array<ArrayBuffer>
  freqBuf: Uint8Array<ArrayBuffer>
}

let graph: MicGraph | null = null
let recording = false
let chunks: Float32Array[] = []
let smoothEnergy = 0
const smoothBands: number[] = []
let activeDevice: { deviceId?: string; label?: string; auto: boolean; candidates?: string[] } = { auto: true }
let lastInputCandidates: string[] = []

const BASE_AUDIO: MediaTrackConstraints = {
  channelCount: 1,
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
}

/** getUserMedia for a concrete device id, or the browser default when no id is provided. */
async function getStream(deviceId?: string): Promise<MediaStream> {
  if (deviceId) return navigator.mediaDevices.getUserMedia({ audio: { ...BASE_AUDIO, deviceId: { exact: deviceId } } })
  return navigator.mediaDevices.getUserMedia({ audio: { ...BASE_AUDIO } })
}

function scoreInputLabel(label: string): number {
  const l = label.trim()
  if (!l) return 0
  if (VIRTUAL_MIC_RE.test(l) || NON_SPEECH_INPUT_RE.test(l)) return -1000
  let score = 0
  if (DEDICATED_MIC_RE.test(l)) score += 140
  if (MIC_WORD_RE.test(l)) score += 60
  if (/headset|auricular/i.test(l)) score += 25
  if (/array|matriz/i.test(l)) score += 10
  if (/camera|webcam|camara|c.mara/i.test(l)) score -= 15
  if (/default|predeterminado/i.test(l)) score += 20
  return score
}

function scoreInputDevice(d: MediaDeviceInfo): number {
  if (d.kind !== 'audioinput' || !d.deviceId || d.deviceId === 'default' || d.deviceId === 'communications') return -1000
  return scoreInputLabel(d.label)
}

function describeStream(stream: MediaStream, auto: boolean): { deviceId?: string; label?: string; auto: boolean; candidates?: string[] } {
  const track = stream.getAudioTracks()[0]
  const settings = track?.getSettings?.()
  return {
    deviceId: settings?.deviceId,
    label: track?.label || undefined,
    auto,
    candidates: lastInputCandidates,
  }
}

/** List selectable input devices for the Settings picker (acquires permission so labels populate). */
export async function listInputDevices(): Promise<{ deviceId: string; label: string }[]> {
  try {
    if (!graph) {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true })
      s.getTracks().forEach((t) => t.stop())
    }
    const devs = await navigator.mediaDevices.enumerateDevices()
    // Show EVERY real input (including "virtual" ones like SteelSeries Sonar — the user may genuinely
    // speak through it); just sort likely-physical mics first. The 'default'/'communications' aliases
    // are hidden because "Auto" already means the system default.
    return devs
      .filter((d) => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications')
      .sort((a, b) => scoreInputDevice(b) - scoreInputDevice(a))
      .map((d) => ({ deviceId: d.deviceId, label: d.label || 'Microphone' }))
  } catch {
    return []
  }
}

/** Acquire the mic + build the graph once. Throws if permission is denied / no device. */
export async function ensureMic(): Promise<void> {
  // Self-heal: if the cached track has died/muted (device unplugged, router gated it), rebuild fresh.
  if (graph) {
    const t = graph.stream.getAudioTracks()[0]
    if (t && t.readyState === 'live' && !t.muted) {
      // The cached context may have been auto-suspended since the last capture — re-resume it so the
      // ScriptProcessor will actually fire on the next startCapture().
      if (graph.ctx.state !== 'running') await graph.ctx.resume().catch(() => undefined)
      return
    }
    releaseMic()
  }
  lastInputCandidates = []
  // Use the device the user explicitly chose in Settings → Odla; otherwise the SYSTEM DEFAULT — the
  // very mic Windows is configured to use. THIS is what "auto-detected the mic" meant and what worked
  // before. We deliberately do NOT second-guess the default with a heuristically-"better" physical
  // device, and we NEVER overwrite the user's saved choice: forcing an unused physical mic (or
  // rejecting the chosen one as "virtual") captured faint/empty audio — the regression we're undoing.
  const pref = useSettingsStore.getState().settings.voice.inputDeviceId || ''
  let stream: MediaStream
  try {
    stream = await getStream(pref || undefined)
  } catch {
    // The saved device vanished — fall back to the system default rather than failing outright.
    stream = await getStream()
  }
  const autoMode = !pref
  // Enumerate inputs for the diagnostic dump ONLY (not to override the selection).
  try {
    lastInputCandidates = (await navigator.mediaDevices.enumerateDevices())
      .filter((d) => d.kind === 'audioinput')
      .map((d) => `${d.label || '(unlabeled)'} | ${d.deviceId.slice(0, 12)}`)
  } catch {
    lastInputCandidates = []
  }
  try {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    const ctx = new Ctor()
    if (ctx.state === 'suspended') await ctx.resume().catch(() => undefined)

    const source = ctx.createMediaStreamSource(stream)
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 1024
    analyser.smoothingTimeConstant = 0.6
    const sink = ctx.createGain()
    sink.gain.value = 0 // silent — only there so the capture branch is pulled by the graph
    const processor = ctx.createScriptProcessor(4096, 1, 1)
    processor.onaudioprocess = (e: AudioProcessingEvent): void => {
      if (!recording) return
      const input = e.inputBuffer.getChannelData(0)
      // Copy (the engine reuses the event buffer) + clamp to [-1,1].
      const out = new Float32Array(input.length)
      for (let i = 0; i < input.length; i++) {
        const v = input[i]
        out[i] = v > 1 ? 1 : v < -1 ? -1 : v
      }
      chunks.push(out)
    }

    source.connect(analyser)
    source.connect(processor)
    processor.connect(sink)
    sink.connect(ctx.destination)

    activeDevice = describeStream(stream, autoMode)
    graph = {
      ctx,
      stream,
      source,
      analyser,
      processor,
      sink,
      timeBuf: new Float32Array(analyser.fftSize),
      freqBuf: new Uint8Array(analyser.frequencyBinCount),
    }
  } catch (err) {
    stream.getTracks().forEach((t) => t.stop())
    throw err
  }
}

/** Begin buffering samples for the next transcription. Resumes the AudioContext first — a context
 *  created without an active user-gesture (or auto-suspended by Chromium) stays 'suspended', and then
 *  the ScriptProcessor's onaudioprocess NEVER fires, so we'd capture pure silence (chunks[] empty →
 *  no live transcription, nothing understood, no error). `recording` is set synchronously so an
 *  un-awaited caller still records; the resume is awaited so a slow resume can't drop the onset. */
export async function startCapture(): Promise<void> {
  chunks = []
  recording = true
  const g = graph
  if (g && g.ctx.state !== 'running') {
    try {
      await g.ctx.resume()
    } catch {
      /* best-effort — still try to capture */
    }
  }
}

function concat(): Float32Array<ArrayBuffer> {
  let total = 0
  for (const c of chunks) total += c.length
  const samples = new Float32Array(total)
  let off = 0
  for (const c of chunks) {
    samples.set(c, off)
    off += c.length
  }
  return samples
}

/** Stop buffering and return the full mono utterance + the context's (real) sample rate. */
export function stopCapture(): { samples: Float32Array<ArrayBuffer>; sampleRate: number; deviceId?: string; label?: string; auto: boolean; candidates?: string[] } {
  recording = false
  const sampleRate = graph?.ctx.sampleRate ?? FALLBACK_RATE
  const samples = concat()
  chunks = []
  return { samples, sampleRate, ...activeDevice }
}

/** A COPY of the audio captured so far WITHOUT stopping ? for live partial transcription. */
export function peekSamples(): { samples: Float32Array<ArrayBuffer>; sampleRate: number; deviceId?: string; label?: string; auto: boolean; candidates?: string[] } {
  return { samples: concat(), sampleRate: graph?.ctx.sampleRate ?? FALLBACK_RATE, ...activeDevice }
}

/** Current smoothed input loudness in 0..1, for the reactive aura. */
export function readEnergy(): number {
  const g = graph
  if (!g) return 0
  g.analyser.getFloatTimeDomainData(g.timeBuf)
  let sum = 0
  for (let i = 0; i < g.timeBuf.length; i++) sum += g.timeBuf[i] * g.timeBuf[i]
  const rms = Math.sqrt(sum / g.timeBuf.length)
  const target = recording ? Math.min(1, Math.pow(rms * 5.5, 0.62)) : 0
  // Gentle, near-symmetric smoothing so the aura SWELLS and settles smoothly — no flicker/strobe on
  // individual syllables (this value only drives the aura's --voice-energy, not the snappy EQ bars).
  smoothEnergy += (target - smoothEnergy) * (target > smoothEnergy ? 0.16 : 0.07)
  return smoothEnergy
}

/** RAW instantaneous input level (RMS, ~0..1), UN-smoothed — for silence/end-of-speech detection
 *  (auto-send). Read-only; does not change capture or the device in any way. */
export function micLevel(): number {
  const g = graph
  if (!g || !recording) return 0
  g.analyser.getFloatTimeDomainData(g.timeBuf)
  let sum = 0
  for (let i = 0; i < g.timeBuf.length; i++) sum += g.timeBuf[i] * g.timeBuf[i]
  return Math.sqrt(sum / g.timeBuf.length)
}

/** Per-band loudness (0..1) for the HUD equalizer. */
export function readBands(n = 5): number[] {
  const g = graph
  if (!g) return new Array(n).fill(0)
  g.analyser.getByteFrequencyData(g.freqBuf)
  const usable = Math.floor(g.freqBuf.length * 0.66)
  const per = Math.max(1, Math.floor(usable / n))
  for (let b = 0; b < n; b++) {
    let sum = 0
    for (let i = 0; i < per; i++) sum += g.freqBuf[b * per + i] ?? 0
    const avg = sum / per / 255
    const target = recording ? Math.min(1, Math.pow(avg * 1.9, 0.8)) : 0
    const prev = smoothBands[b] ?? 0
    smoothBands[b] = prev + (target - prev) * (target > prev ? 0.6 : 0.2)
  }
  return smoothBands.slice(0, n)
}

/** Tear down the mic + graph (e.g. when voice is disabled in Settings). */
export function releaseMic(): void {
  recording = false
  chunks = []
  smoothEnergy = 0
  if (!graph) return
  try {
    graph.processor.onaudioprocess = null
    graph.processor.disconnect()
    graph.analyser.disconnect()
    graph.source.disconnect()
    graph.sink.disconnect()
    graph.stream.getTracks().forEach((t) => t.stop())
    void graph.ctx.close().catch(() => undefined)
  } catch {
    /* best-effort teardown */
  }
  graph = null
  activeDevice = { auto: true }
  lastInputCandidates = []
}

/** Whether the mic graph is currently live (permission granted, graph built). */
export function micReady(): boolean {
  return graph !== null
}
