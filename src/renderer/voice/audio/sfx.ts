/**
 * Odla's UI sounds — short, tasteful tones synthesized with the Web Audio API (no asset files, no
 * download, works offline everywhere). Sine partials with soft exponential envelopes so they read as
 * a calm, modern assistant rather than a system beep. Volume is intentionally restrained.
 */

let ctx: AudioContext | null = null

function getCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AC) return null
  if (!ctx) {
    try {
      ctx = new AC()
    } catch {
      return null
    }
  }
  if (ctx.state === 'suspended') void ctx.resume()
  return ctx
}

/** Resume the audio context from a user gesture (call when voice is enabled / on first key press). */
export function primeSfx(): void {
  getCtx()
}

function tone(ac: AudioContext, freq: number, start: number, dur: number, peak: number, type: OscillatorType = 'sine'): void {
  const osc = ac.createOscillator()
  const gain = ac.createGain()
  osc.type = type
  osc.frequency.setValueAtTime(freq, start)
  gain.gain.setValueAtTime(0.0001, start)
  gain.gain.exponentialRampToValueAtTime(peak, start + 0.012)
  gain.gain.exponentialRampToValueAtTime(0.0001, start + dur)
  osc.connect(gain).connect(ac.destination)
  osc.start(start)
  osc.stop(start + dur + 0.02)
}

/** Listening started — a soft rising two-note "I'm here". */
export function sfxStart(): void {
  const ac = getCtx()
  if (!ac) return
  const t = ac.currentTime
  tone(ac, 523.25, t, 0.12, 0.1)
  tone(ac, 783.99, t + 0.08, 0.16, 0.12)
}

/** Listening ended (before transcription) — a quiet downward tick. */
export function sfxStop(): void {
  const ac = getCtx()
  if (!ac) return
  tone(ac, 587.33, ac.currentTime, 0.09, 0.07)
}

/** Command ran successfully — a bright ascending triad. */
export function sfxDone(): void {
  const ac = getCtx()
  if (!ac) return
  const t = ac.currentTime
  ;[659.25, 830.61, 1046.5].forEach((f, i) => tone(ac, f, t + i * 0.07, 0.22, 0.11))
}

/** Something went wrong — a low, short descending pair. */
export function sfxError(): void {
  const ac = getCtx()
  if (!ac) return
  const t = ac.currentTime
  tone(ac, 311.13, t, 0.16, 0.1, 'triangle')
  tone(ac, 233.08, t + 0.12, 0.22, 0.1, 'triangle')
}
