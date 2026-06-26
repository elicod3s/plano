/**
 * VoiceService — the local ears of "Odla", PLANO's voice orchestrator.
 *
 * Wraps sherpa-onnx's OfflineRecognizer running NVIDIA's Parakeet TDT 0.6B v3 (multilingual,
 * int8) entirely on-device — no network, no API key, no Python. The model is BUNDLED into the
 * installer (extraResources), so it works for anyone the moment they install the app.
 *
 * Resilience mirrors PtyManager: sherpa-onnx is loaded lazily and every failure mode (missing
 * native binary, missing model files, decode error) degrades to a `missing`/`error` status the
 * renderer can show — it must never crash the main process.
 */

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { cpus } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import type {
  VoiceStatus,
  VoiceTranscribeRequest,
  VoiceTranscribeResult,
  VoiceInterpretRequest,
  VoiceInterpretResult,
} from '@shared/ipc/contracts'

/** The bundled model's identity (the line Handy uses; best multilingual Parakeet export today). */
const MODEL_ID = 'parakeet-tdt-0.6b-v3-int8'

// ── Tunables ── values that govern recognition, named + grouped so they live in ONE place instead
// of as magic numbers scattered through the decode path. (Changing one site and missing another
// would silently break recognition.)
/** Rate Parakeet expects; features, resample target, pad base and decode must all agree on it. */
const MODEL_SAMPLE_RATE = 16000
/** Mel feature dimension the model was exported with. */
const FEATURE_DIM = 80
/** Pad very short utterances with trailing silence up to this many seconds — a chunked model decodes
 *  a lone short word more reliably with a little tail. */
const MIN_UTTERANCE_SECONDS = 1.0
/** Auto-gain tuning (hand-calibrated for quiet real mics): skip if already this hot, never amplify
 *  below these silence floors, aim for these peak/rms targets, cap the boost, ignore tiny gains. */
const AGC = { peakAlreadyHot: 0.95, minPeak: 0.002, minRms: 0.00025, peakTarget: 0.9, rmsTarget: 0.12, maxGain: 80, deadzone: 1.01 } as const
/** Gemini cloud-fallback guardrails (voice must never block on the cloud). */
const GEMINI_TIMEOUT_MS = 4500
const DEFAULT_GEMINI_MODEL = 'gemini-3.1-flash-lite'

// Minimal shape of the bits of sherpa-onnx-node we use (the package ships JSDoc, not .d.ts).
interface OfflineStreamLike {
  acceptWaveform(obj: { samples: Float32Array; sampleRate: number }): void
}
interface OfflineRecognizerLike {
  createStream(): OfflineStreamLike
  decodeAsync(stream: OfflineStreamLike): Promise<{ text?: string }>
  getResult(stream: OfflineStreamLike): { text?: string }
}
interface SherpaModule {
  OfflineRecognizer: {
    new (config: unknown): OfflineRecognizerLike
    createAsync(config: unknown): Promise<OfflineRecognizerLike>
  }
}

let sherpa: SherpaModule | null = null
let sherpaLoadError: string | null = null

/** Lazy-require sherpa-onnx-node; tolerate a missing/broken native binary (never throw up the stack). */
function loadSherpa(): SherpaModule | null {
  if (sherpa) return sherpa
  if (sherpaLoadError) return null
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    sherpa = require('sherpa-onnx-node') as SherpaModule
    return sherpa
  } catch (err) {
    sherpaLoadError = err instanceof Error ? err.message : String(err)
    return null
  }
}

/**
 * Locate the bundled Parakeet model directory. Packaged → <resources>/models/parakeet (copied via
 * electron-builder extraResources). Dev → <project>/resources/models/parakeet. We pick the first
 * candidate that actually contains tokens.txt so a half-populated dir is treated as "not there".
 */
function findModelDir(): string | null {
  const candidates = [
    join(process.resourcesPath ?? '', 'models', 'parakeet'),
    join(app.getAppPath(), 'resources', 'models', 'parakeet'),
    join(app.getAppPath(), '..', 'resources', 'models', 'parakeet'),
    join(process.cwd(), 'resources', 'models', 'parakeet'),
  ]
  for (const dir of candidates) {
    if (dir && existsSync(join(dir, 'tokens.txt'))) return dir
  }
  return null
}

/** Resolve the three transducer onnx files in `dir`, preferring the int8 export, else float. */
function resolveModelFiles(dir: string): { encoder: string; decoder: string; joiner: string } | null {
  const pick = (base: string): string | null => {
    for (const name of [`${base}.int8.onnx`, `${base}.onnx`]) {
      const p = join(dir, name)
      if (existsSync(p)) return p
    }
    return null
  }
  const encoder = pick('encoder')
  const decoder = pick('decoder')
  const joiner = pick('joiner')
  if (!encoder || !decoder || !joiner) return null
  return { encoder, decoder, joiner }
}

export class VoiceService {
  private recognizer: OfflineRecognizerLike | null = null
  private state: VoiceStatus['state'] = 'idle'
  private message: string | undefined
  private loading: Promise<VoiceStatus> | null = null
  /** Serializes decode calls (live partials + final) so they never run on the recognizer at once. */
  private decodeChain: Promise<void> = Promise.resolve()

  /** A cheap, synchronous availability read (does NOT load the model). */
  status(): VoiceStatus {
    const engineAvailable = loadSherpa() !== null
    const modelDir = findModelDir()
    const modelAvailable = !!modelDir && !!resolveModelFiles(modelDir)
    let state = this.state
    if (!engineAvailable || !modelAvailable) state = 'missing'
    else if (this.recognizer) state = 'ready'
    const message =
      state === 'missing'
        ? !engineAvailable
          ? sherpaLoadError
            ? `Speech engine failed to load: ${sherpaLoadError}`
            : 'Speech engine (sherpa-onnx) is not available in this build.'
          : 'The bundled voice model was not found. Reinstall PLANO to restore it.'
        : this.message
    return { state, engineAvailable, modelAvailable, message, model: MODEL_ID }
  }

  /**
   * Load the model into memory (idempotent). Returns the resulting status. Heavy (reads ~600 MB),
   * so callers warm it once when voice is enabled rather than on the first utterance.
   */
  async prepare(): Promise<VoiceStatus> {
    if (this.recognizer) return this.status()
    if (this.loading) return this.loading
    this.loading = this.load()
    try {
      return await this.loading
    } finally {
      this.loading = null
    }
  }

  private async load(): Promise<VoiceStatus> {
    const mod = loadSherpa()
    const modelDir = findModelDir()
    const files = modelDir ? resolveModelFiles(modelDir) : null
    if (!mod || !files) {
      this.state = 'missing'
      return this.status()
    }
    this.state = 'loading'
    try {
      const config = {
        featConfig: { sampleRate: MODEL_SAMPLE_RATE, featureDim: FEATURE_DIM },
        modelConfig: {
          transducer: { encoder: files.encoder, decoder: files.decoder, joiner: files.joiner },
          tokens: join(modelDir as string, 'tokens.txt'),
          // Benchmarked on this CPU (Ryzen 8c/16t): ~6 threads decodes fastest (~184ms vs ~261ms at
          // 4, ~391ms at 12 — over-subscription hurts). Cap at 6, scale down on smaller machines.
          numThreads: Math.max(2, Math.min(6, (cpus()?.length ?? 4) - 2)),
          provider: 'cpu',
          debug: 0,
          modelType: 'nemo_transducer',
        },
        decodingMethod: 'greedy_search',
      }
      this.recognizer = await mod.OfflineRecognizer.createAsync(config)
      // Prime the model with one tiny silent decode so the user's FIRST real command isn't slowed by
      // cold weights/caches (this whole load already runs in the background when voice is enabled).
      try {
        const warm = this.recognizer.createStream()
        warm.acceptWaveform({ samples: new Float32Array(Math.floor(MODEL_SAMPLE_RATE * 0.3)), sampleRate: MODEL_SAMPLE_RATE })
        await this.recognizer.decodeAsync(warm)
      } catch {
        /* warm-up is best-effort — never block readiness on it */
      }
      this.state = 'ready'
      this.message = undefined
    } catch (err) {
      this.recognizer = null
      this.state = 'error'
      this.message = err instanceof Error ? err.message : String(err)
    }
    return this.status()
  }

  /**
   * Transcribe one utterance. SERIALIZED — the live-caption partials and the final decode share one
   * recognizer, so we chain calls to guarantee decodes never overlap (no concurrent-decode hazard).
   * The `partialBusy` guard in the renderer keeps at most one partial in flight, so the final waits
   * for at most one short decode.
   */
  transcribe(req: VoiceTranscribeRequest): Promise<VoiceTranscribeResult> {
    const next = this.decodeChain.then(() => this.doTranscribe(req))
    this.decodeChain = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  private async doTranscribe(req: VoiceTranscribeRequest): Promise<VoiceTranscribeResult> {
    if (!this.recognizer) {
      const st = await this.prepare()
      if (st.state !== 'ready') {
        return { ok: false, text: '', error: st.message ?? 'Voice engine not ready.' }
      }
    }
    const rec = this.recognizer
    if (!rec) return { ok: false, text: '', error: 'Voice engine not ready.' }
    try {
      const raw = toFloat32(req.pcm)
      if (raw.length === 0) return { ok: true, text: '' }
      const inputSampleRate = Number.isFinite(req.sampleRate) && req.sampleRate > 0 ? req.sampleRate : MODEL_SAMPLE_RATE
      // Match Handy/transcribe-rs: feed Parakeet mono 16 kHz PCM instead of relying on WebAudio's
      // 48/96 kHz stream and any implicit recognizer resampling.
      const mono16 = resampleLinear(raw, inputSampleRate, MODEL_SAMPLE_RATE)
      const { samples: boosted, gain } = normalizePeak(mono16)
      const samples = padToMin(boosted, MODEL_SAMPLE_RATE, MIN_UTTERANCE_SECONDS)
      const stream = rec.createStream()
      stream.acceptWaveform({ samples, sampleRate: MODEL_SAMPLE_RATE })
      const result = await rec.decodeAsync(stream)
      const text = (result?.text ?? '').trim()
      if (req.final) {
        const dev = {
          deviceId: req.inputDeviceId,
          deviceLabel: req.inputDeviceLabel,
          autoDevice: req.inputDeviceAuto,
          candidates: req.inputDeviceCandidates,
        }
        // Off the hot path: the caller gets its transcript immediately; the diagnostic dump (WAV
        // encode + 3 fs writes) runs after this resolves. Best-effort, already try/caught.
        setImmediate(() => dumpUtterance(raw, inputSampleRate, text, gain, dev))
      }
      return { ok: true, text }
    } catch (err) {
      return { ok: false, text: '', error: err instanceof Error ? err.message : String(err) }
    }
  }

  /**
   * Interpret a transcript into a structured canvas action via Gemini (the cheap+fast flash-lite).
   * Made from MAIN (no CORS, key never touches the DOM). Aborts after a short budget so a slow/failed
   * call falls straight back to the renderer's local fuzzy grammar — voice never blocks on the cloud.
   */
  async interpret(req: VoiceInterpretRequest): Promise<VoiceInterpretResult> {
    const apiKey = (req.apiKey || '').trim()
    const model = (req.model || DEFAULT_GEMINI_MODEL).trim()
    const transcript = (req.transcript || '').trim()
    if (!apiKey || !transcript) return { ok: false, action: null, error: 'No API key / transcript' }

    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), GEMINI_TIMEOUT_MS)
    try {
      const userText = req.context ? `CANVAS STATE:\n${req.context}\n\nCOMMAND: ${transcript}` : transcript
      const fewshot = GEMINI_FEWSHOT.flatMap(([u, m]) => [
        { role: 'user', parts: [{ text: u }] },
        { role: 'model', parts: [{ text: m }] },
      ])
      const res = await fetch(`${GEMINI_BASE}/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        signal: ctrl.signal,
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: GEMINI_SYSTEM }] },
          contents: [...fewshot, { role: 'user', parts: [{ text: userText }] }],
          generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: GEMINI_SCHEMA,
            temperature: 0,
            thinkingConfig: { thinkingBudget: 0 },
          },
        }),
      })
      if (!res.ok) {
        return { ok: false, action: null, error: `Gemini HTTP ${res.status}` }
      }
      const data = (await res.json()) as {
        candidates?: { content?: { parts?: { text?: string }[] } }[]
      }
      const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
      const match = raw.match(/\{[\s\S]*\}/)
      if (!match) return { ok: false, action: null, error: 'No JSON in response' }
      const action = JSON.parse(match[0]) as Record<string, unknown>
      if (!action || typeof action.action !== 'string') {
        return { ok: false, action: null, error: 'Invalid action' }
      }
      return { ok: true, action }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false, action: null, error: msg }
    } finally {
      clearTimeout(timer)
    }
  }
}

// ── Gemini intent parsing (the smart "engine"; the renderer's fuzzy grammar is the fallback) ──────
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta'

const GEMINI_SYSTEM = `You are the command parser for PLANO, an infinite-canvas IDE. Convert ONE spoken command (Spanish or English) into ONE JSON action. Output ONLY the JSON object (a schema is enforced).

Fields per action (OMIT every field not listed for that action):
- create: panel (one of: terminal, editor, browser, agent, git, markdown, todo, pomodoro, sticky, region, label); count (default 1); optionally agent (claude, codex, gemini, kiro, opencode, aider) to launch inside a new terminal; url (only for browser); text (only for sticky/markdown/label/region). "Files"/"archivos" => panel "editor". "abre claude"/"open claude code" => panel "terminal" + agent "claude" + count 1. "abre un navegador con youtube" => panel "browser" + url "https://www.youtube.com".
- close / focus: target.
- prompt: target + text — type free text into that terminal's shell (its running agent picks it up). "terminal 1, crea un componente" => action "prompt", target {kind:"number", n:1}, text:"crea un componente".
- arrange: tidy/organize the canvas. view: value fit|reset|zoomIn|zoomOut. workspace: workspaceAction new|open|save|close. toggle: value minimap|snapping|palette|settings. space: value next|prev. query: value agents|panels. none: nothing actionable.

target.kind ∈ {type, number, agent, all, last, front}. With type also set target.type and target.scope (one|all). With number set target.n. With agent set target.agent.

Rules: put count and agent at the TOP LEVEL (never inside target). "dos"/"two" => count 2, "tres"/"three" => 3, etc. Resolve references using the CANVAS STATE. Be concise; never invent fields you don't need.`

/** A few worked examples — small models obey the schema far more reliably with these. */
const GEMINI_FEWSHOT: ReadonlyArray<readonly [string, string]> = [
  ['abre dos terminales con claude', '{"action":"create","panel":"terminal","count":2,"agent":"claude"}'],
  ['open a browser with youtube', '{"action":"create","panel":"browser","url":"https://www.youtube.com"}'],
  ['cierra la segunda terminal', '{"action":"close","target":{"kind":"number","n":2}}'],
  ['ponle a la terminal de claude que arregle el login', '{"action":"prompt","target":{"kind":"agent","agent":"claude"},"text":"arregle el login"}'],
  ['organiza todo', '{"action":"arrange"}'],
]

const GEMINI_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string' },
    panel: { type: 'string' },
    count: { type: 'integer' },
    agent: { type: 'string' },
    url: { type: 'string' },
    text: { type: 'string' },
    value: { type: 'string' },
    workspaceAction: { type: 'string' },
    target: {
      type: 'object',
      properties: {
        kind: { type: 'string' },
        n: { type: 'integer' },
        type: { type: 'string' },
        agent: { type: 'string' },
        scope: { type: 'string' },
      },
    },
  },
  required: ['action'],
}

/** Coerce whatever crossed the IPC boundary (ArrayBuffer / typed-array view) into a Float32Array. */
function toFloat32(pcm: ArrayBuffer | ArrayBufferView): Float32Array {
  if (pcm instanceof Float32Array) return pcm
  if (ArrayBuffer.isView(pcm)) {
    return new Float32Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 4))
  }
  if (pcm instanceof ArrayBuffer) return new Float32Array(pcm)
  return new Float32Array(0)
}

function resampleLinear(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (!input.length || !Number.isFinite(fromRate) || fromRate <= 0 || fromRate === toRate) return input
  const outLen = Math.max(1, Math.round((input.length * toRate) / fromRate))
  const out = new Float32Array(outLen)
  const ratio = fromRate / toRate
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio
    const left = Math.floor(pos)
    const right = Math.min(input.length - 1, left + 1)
    const frac = pos - left
    out[i] = input[left] * (1 - frac) + input[right] * frac
  }
  return out
}

/**
 * Peak-normalize an utterance so the model gets a well-leveled signal regardless of mic/distance.
 * Only ever BOOSTS (never attenuates loud audio, never amplifies near-silence past a sane cap), so
 * it can't hurt already-good audio — it just rescues quiet capture. Returns the (possibly new) array
 * plus the gain applied (1 = untouched).
 */
function normalizePeak(input: Float32Array): { samples: Float32Array; gain: number } {
  let peak = 0
  let sum = 0
  for (let i = 0; i < input.length; i++) {
    const v = input[i]
    const a = Math.abs(v)
    sum += v * v
    if (a > peak) peak = a
  }
  const rms = input.length ? Math.sqrt(sum / input.length) : 0
  if (peak >= AGC.peakAlreadyHot) return { samples: input, gain: 1 }
  // Real speech on a quiet mic can sit far below the old 0.01 peak cutoff. Still avoid boosting
  // digital silence/noise from a dead or wrong device.
  if (peak < AGC.minPeak || rms < AGC.minRms) return { samples: input, gain: 1 }

  const peakGain = AGC.peakTarget / peak
  const rmsGain = AGC.rmsTarget / Math.max(rms, AGC.minRms)
  const gain = Math.min(Math.max(peakGain, rmsGain), AGC.maxGain)
  if (gain <= AGC.deadzone) return { samples: input, gain: 1 }
  const out = new Float32Array(input.length)
  for (let i = 0; i < input.length; i++) {
    const v = input[i] * gain
    out[i] = v > 1 ? 1 : v < -1 ? -1 : v
  }
  return { samples: out, gain }
}

/** Pad with trailing silence to a minimum duration so very short utterances decode reliably. */
function padToMin(input: Float32Array, sampleRate: number, minSeconds: number): Float32Array {
  const min = Math.floor((sampleRate || 16000) * minSeconds)
  if (input.length >= min) return input
  const out = new Float32Array(min)
  out.set(input, 0)
  return out
}

// ── Diagnostic dump ───────────────────────────────────────────────────────────────────────────
// Writes the last END-OF-UTTERANCE audio + transcript to userData/voice-debug so we can verify what
// the model actually receives (level/clipping) vs what it heard — turning "it didn't understand"
// into inspectable data. Cheap, overwrites in place, never throws into the decode path.

/** Encode mono Float32 [-1,1] PCM into a 16-bit WAV file buffer. */
function encodeWav(samples: Float32Array, sampleRate: number): Buffer {
  const n = samples.length
  const buf = Buffer.alloc(44 + n * 2)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + n * 2, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16) // fmt chunk size
  buf.writeUInt16LE(1, 20) // PCM
  buf.writeUInt16LE(1, 22) // mono
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * 2, 28) // byte rate
  buf.writeUInt16LE(2, 32) // block align
  buf.writeUInt16LE(16, 34) // bits per sample
  buf.write('data', 36)
  buf.writeUInt32LE(n * 2, 40)
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]))
    buf.writeInt16LE((v < 0 ? v * 0x8000 : v * 0x7fff) | 0, 44 + i * 2)
  }
  return buf
}

function dumpUtterance(
  samples: Float32Array,
  sampleRate: number,
  text: string,
  gain: number,
  device?: { deviceId?: string; deviceLabel?: string; autoDevice?: boolean; candidates?: string[] },
): void {
  try {
    const dir = join(app.getPath('userData'), 'voice-debug')
    mkdirSync(dir, { recursive: true })
    let sum = 0
    let peak = 0
    for (let i = 0; i < samples.length; i++) {
      const a = Math.abs(samples[i])
      sum += samples[i] * samples[i]
      if (a > peak) peak = a
    }
    const rms = samples.length ? Math.sqrt(sum / samples.length) : 0
    const seconds = samples.length / (sampleRate || 1)
    writeFileSync(join(dir, 'last.wav'), encodeWav(samples, sampleRate))
    const meta =
      `transcript: ${text || '(empty)'}\n` +
      `samples: ${samples.length}\n` +
      `sampleRate: ${sampleRate}\n` +
      `seconds: ${seconds.toFixed(2)}\n` +
      `rms: ${rms.toFixed(4)} (raw mic level — healthy speech ≈ 0.05–0.3)\n` +
      `peak: ${peak.toFixed(4)}\n` +
      `gainApplied: ${gain.toFixed(2)}x\n` +
      `inputDevice: ${device?.deviceLabel || '(unknown)'}${device?.autoDevice ? ' (auto)' : ''}\n` +
      `inputDeviceId: ${device?.deviceId || '(unknown)'}\n` +
      `inputCandidates:\n${(device?.candidates || []).map((d) => `  ${d}`).join('\n') || '  (not enumerated)'}\n`
    writeFileSync(join(dir, 'last.txt'), meta)
    const stamp = new Date().toISOString()
    appendFileSync(
      join(dir, 'transcripts.log'),
      `${stamp} | ${seconds.toFixed(2)}s rms=${rms.toFixed(4)} peak=${peak.toFixed(4)} gain=${gain.toFixed(2)}x | "${text || '(empty)'}"\n`,
    )
  } catch {
    /* diagnostics are best-effort — never disturb transcription */
  }
}
