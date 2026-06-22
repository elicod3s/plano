/**
 * Pomodoro chimes — synthesized with the Web Audio API so we ship no audio assets and
 * stay sandbox-friendly. A short oscillator arpeggio with an exponential decay envelope.
 * The AudioContext is created lazily and resumed on demand; the first sound therefore must
 * be triggered from a user gesture (the Start click) to satisfy the autoplay policy.
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

/** Prime/resume the audio context from a user gesture so later chimes are allowed to play. */
export function primeAudio(): void {
  getCtx()
}

function tone(ac: AudioContext, freq: number, start: number, dur: number, peak: number): void {
  const osc = ac.createOscillator()
  const gain = ac.createGain()
  osc.type = 'sine'
  osc.frequency.setValueAtTime(freq, start)
  gain.gain.setValueAtTime(0.0001, start)
  gain.gain.exponentialRampToValueAtTime(peak, start + 0.015)
  gain.gain.exponentialRampToValueAtTime(0.0001, start + dur)
  osc.connect(gain).connect(ac.destination)
  osc.start(start)
  osc.stop(start + dur + 0.02)
}

/**
 * Play a transition chime. `work` (focus finished → rest) is a bright rising triad;
 * `break` (rest finished → back to work) is a lower two-note "ready" cue.
 */
export function playChime(kind: 'work' | 'break'): void {
  const ac = getCtx()
  if (!ac) return
  const now = ac.currentTime
  const notes = kind === 'work' ? [659.25, 830.61, 987.77] : [587.33, 440.0]
  notes.forEach((freq, i) => tone(ac, freq, now + i * 0.16, 0.45, 0.18))
}

/** A soft tick for start/pause feedback (kept quiet and short). */
export function playTick(): void {
  const ac = getCtx()
  if (!ac) return
  tone(ac, 520, ac.currentTime, 0.06, 0.06)
}
