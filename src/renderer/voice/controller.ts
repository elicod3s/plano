/**
 * The voice controller — a module singleton that wires the push-to-talk key, the mic, the reactive
 * aura energy, and the transcribe → orchestrate pipeline. It's not a React hook so the command
 * palette / dock can drive it imperatively too (voiceController.toggle()).
 *
 * Flow: hold the push-to-talk combo (or tap the puck) → capture → release → transcribe on the local
 * Parakeet model → run the command → show (and optionally speak) the result. The live mic level is
 * pushed to the `--voice-energy` CSS variable every frame so the aura breathes with your voice
 * without ever re-rendering React.
 */
import { parseCombo, matchesCombo, eventKey, type ParsedCombo } from '@/lib/keymap'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { ensureMic, startCapture, stopCapture, readEnergy, readBands, micLevel, releaseMic } from './audio/mic'
import { primeSfx, sfxStart, sfxStop, sfxDone, sfxError } from './audio/sfx'
import { runCommand } from './orchestrator'
import { useVoiceStore } from './voiceStore'

const BANDS = 5

// ── Capture timing ──
/** Ignore an utterance shorter than this (accidental taps / chopped PTT releases decode as filler). */
const MIN_UTTERANCE_SECONDS = 0.75

// ── Auto-send (end-of-speech detection) — run the command the moment you stop talking, no release ──
const AUTOSEND_SILENCE_MS = 700 // quiet this long after speech → fire
const AUTOSEND_MIN_MS = 500 //     never fire before this (ignore the click/keypress transient)
const AUTOSEND_MAX_MS = 12000 //   safety: never listen forever
const VOICE_ON = 0.025 //          raw RMS above this = speaking
const VOICE_OFF = 0.012 //         hysteresis floor below which we count silence

type Source = 'ptt' | 'tap'

class VoiceController {
  private enabled = false
  private combo: ParsedCombo = parseCombo('Ctrl+Shift+Space')
  private listening = false
  private source: Source = 'ptt'
  private pttHeld = false
  private raf = 0
  private resultTimer: ReturnType<typeof setTimeout> | undefined
  private partialTimer: ReturnType<typeof setInterval> | undefined
  // Auto-send (end-of-speech) tracking — set when listening starts.
  private listenStartMs = 0
  private lastVoiceMs = 0
  private speechSeen = false
  private endpointed = false

  enable(): void {
    if (this.enabled) return
    this.enabled = true
    window.addEventListener('keydown', this.onKeyDown, { capture: true })
    window.addEventListener('keyup', this.onKeyUp, { capture: true })
    window.addEventListener('blur', this.onBlur)
    primeSfx()
    // Probe availability and warm the model in the background so the first utterance is instant.
    void this.warm()
  }

  disable(): void {
    if (!this.enabled) return
    this.enabled = false
    window.removeEventListener('keydown', this.onKeyDown, { capture: true } as EventListenerOptions)
    window.removeEventListener('keyup', this.onKeyUp, { capture: true } as EventListenerOptions)
    window.removeEventListener('blur', this.onBlur)
    cancelAnimationFrame(this.raf)
    this.raf = 0
    this.listening = false
    this.pttHeld = false
    this.stopPartials()
    releaseMic()
    const root = document.documentElement.style
    root.setProperty('--voice-energy', '0')
    for (let i = 0; i < BANDS; i++) root.setProperty(`--voice-b${i}`, '0')
    useVoiceStore.getState().set({ phase: 'idle' })
  }

  setPushToTalkKey(combo: string): void {
    this.combo = parseCombo(combo || 'Ctrl+Shift+Space')
  }

  /** Tap behavior (mic button / palette command): start, or stop-and-transcribe a tap session. */
  toggle(): void {
    if (!this.enabled) return
    if (this.listening) {
      if (this.source === 'tap') void this.stopAndTranscribe()
      return // a push-to-talk hold owns the session; ignore taps mid-hold
    }
    void this.startListening('tap')
  }

  /** Run a TYPED command (the command-bar input) through the exact same engine as voice. */
  async runTyped(text: string): Promise<void> {
    const t = text.trim()
    if (!t || !this.enabled) return
    if (this.listening) this.cancel()
    clearTimeout(this.resultTimer)
    await this.executeText(t)
  }

  /** Shared tail for voice + typed: run the orchestrator and reflect the outcome in the HUD. */
  private async executeText(text: string): Promise<void> {
    const store = useVoiceStore.getState()
    store.set({ phase: 'executing', transcript: text, summary: '', errorMsg: '' })
    try {
      const action = await runCommand(text)
      store.set({
        phase: action.ok ? 'result' : 'error',
        summary: action.summary,
        errorMsg: action.ok ? '' : action.summary,
      })
      if (action.ok) sfxDone()
      else sfxError()
      if (action.ok && useSettingsStore.getState().settings.voice.speakResponses) {
        speak(action.spoken ?? action.summary)
      }
    } catch (err) {
      sfxError()
      store.set({ phase: 'error', errorMsg: err instanceof Error ? err.message : 'Voice error', summary: '' })
    }
    this.scheduleIdle()
  }

  private async warm(): Promise<void> {
    try {
      let status = await window.plano.voice.status()
      useVoiceStore.getState().set({ engine: status })
      if (status.state === 'idle') {
        status = await window.plano.voice.prepare()
        useVoiceStore.getState().set({ engine: status })
      }
    } catch {
      /* engine unavailable — status stays null; transcribe will report it */
    }
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (!this.enabled) return
    if (matchesCombo(e, this.combo)) {
      e.preventDefault()
      e.stopPropagation()
      if (!this.listening) {
        this.pttHeld = true
        void this.startListening('ptt')
      }
      return
    }
    if (e.key === 'Escape' && this.listening) {
      e.preventDefault()
      this.cancel()
    }
  }

  private onKeyUp = (e: KeyboardEvent): void => {
    if (!this.pttHeld) return
    // End push-to-talk on the main key release only. Releasing Ctrl/Shift a split-second early must
    // not chop the utterance into a sub-second fragment.
    const k = eventKey(e)
    if (k === this.combo.key) {
      this.pttHeld = false
      if (this.listening && this.source === 'ptt') void this.stopAndTranscribe()
    }
  }

  private onBlur = (): void => {
    if (!this.pttHeld || !this.listening || this.source !== 'ptt') return
    this.pttHeld = false
    void this.stopAndTranscribe()
  }

  private async startListening(source: Source): Promise<void> {
    const engine = useVoiceStore.getState().engine
    if (engine && engine.state === 'missing') {
      this.flashError(engine.message ?? 'Voice model unavailable')
      return
    }
    try {
      await ensureMic()
    } catch {
      useVoiceStore.getState().set({ micDenied: true })
      this.flashError('Microphone access denied')
      return
    }
    clearTimeout(this.resultTimer)
    this.source = source
    this.listening = true
    const t0 = Date.now()
    this.listenStartMs = t0
    this.lastVoiceMs = t0
    this.speechSeen = false
    this.endpointed = false
    startCapture()
    primeSfx()
    sfxStart()
    this.startLoop()
    // No live partial transcription on purpose: the HUD shows only "Listening…" → "Done". The model's
    // mid-utterance guesses were noisy/misleading, so we skip the per-interval partial decodes entirely
    // (also lighter — the final decode no longer queues behind partials).
    useVoiceStore.getState().set({ phase: 'listening', transcript: '', summary: '', errorMsg: '', micDenied: false })
  }

  private stopPartials(): void {
    clearInterval(this.partialTimer)
    this.partialTimer = undefined
  }

  private cancel(): void {
    if (!this.listening) return
    this.listening = false
    this.stopLoop()
    this.stopPartials()
    stopCapture()
    useVoiceStore.getState().set({ phase: 'idle', transcript: '', summary: '' })
  }

  private async stopAndTranscribe(): Promise<void> {
    if (!this.listening) return
    this.listening = false
    this.stopLoop()
    this.stopPartials()
    sfxStop()
    const { samples, sampleRate, deviceId, label, auto, candidates } = stopCapture()
    // Ignore accidental taps / chopped push-to-talk releases. Short fragments decode as filler words.
    if (samples.length < sampleRate * MIN_UTTERANCE_SECONDS) {
      useVoiceStore.getState().set({ phase: 'idle' })
      return
    }
    const store = useVoiceStore.getState()
    store.set({ phase: 'transcribing' })
    try {
      const res = await window.plano.voice.transcribe({
        pcm: samples.buffer,
        sampleRate,
        final: true,
        inputDeviceId: deviceId,
        inputDeviceLabel: label,
        inputDeviceAuto: auto,
        inputDeviceCandidates: candidates,
      })
      if (!res.ok) {
        this.flashError(res.error ?? 'Transcription failed')
        return
      }
      const text = res.text.trim()
      if (!text) {
        this.flashError('Didn’t catch that')
        return
      }
      await this.executeText(text)
    } catch (err) {
      this.flashError(err instanceof Error ? err.message : 'Voice error')
    }
  }

  private flashError(msg: string): void {
    sfxError()
    useVoiceStore.getState().set({ phase: 'error', errorMsg: msg, summary: msg })
    this.scheduleIdle(3200)
  }

  private scheduleIdle(ms = 2600): void {
    clearTimeout(this.resultTimer)
    this.resultTimer = setTimeout(() => {
      useVoiceStore.getState().set({ phase: 'idle', transcript: '', summary: '', errorMsg: '' })
    }, ms)
  }

  private startLoop(): void {
    if (this.raf) return
    // The live voice level is functional feedback (you must SEE that Odla hears you), so it always
    // animates while listening — even under reduced-motion (the big decorative motion is elsewhere).
    this.raf = requestAnimationFrame(this.loop)
  }

  private stopLoop(): void {
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = 0
    this.resetVars()
  }

  private resetVars(): void {
    const root = document.documentElement.style
    root.setProperty('--voice-energy', '0')
    for (let i = 0; i < BANDS; i++) root.setProperty(`--voice-b${i}`, '0')
  }

  /** Per-frame WHILE LISTENING: push live mic energy + frequency bands into CSS vars. Only `opacity`
   *  / `transform` read these, so the UI moves with your voice with zero React re-renders and no
   *  expensive repaints. Stops as soon as listening ends. */
  private loop = (): void => {
    if (!this.enabled || !this.listening) {
      this.raf = 0
      return
    }
    const root = document.documentElement.style
    root.setProperty('--voice-energy', readEnergy().toFixed(3))
    const bands = readBands(BANDS)
    for (let i = 0; i < BANDS; i++) root.setProperty(`--voice-b${i}`, (bands[i] ?? 0).toFixed(3))

    // Auto-send: detect end-of-speech and fire WITHOUT needing a key release.
    if (!this.endpointed && useSettingsStore.getState().settings.voice.autoSend) {
      const lvl = micLevel()
      const now = Date.now()
      if (lvl > VOICE_ON) {
        this.speechSeen = true
        this.lastVoiceMs = now
      } else if (lvl > VOICE_OFF) {
        this.lastVoiceMs = now
      }
      const elapsed = now - this.listenStartMs
      const silence = now - this.lastVoiceMs
      if ((this.speechSeen && elapsed > AUTOSEND_MIN_MS && silence > AUTOSEND_SILENCE_MS) || elapsed > AUTOSEND_MAX_MS) {
        this.endpointed = true
        void this.stopAndTranscribe() // sets listening=false + stops this loop
        return
      }
    }
    this.raf = requestAnimationFrame(this.loop)
  }
}

function speak(text: string): void {
  try {
    const u = new SpeechSynthesisUtterance(text)
    u.rate = 1.05
    speechSynthesis.cancel()
    speechSynthesis.speak(u)
  } catch {
    /* no speech synthesis available */
  }
}

export const voiceController = new VoiceController()
