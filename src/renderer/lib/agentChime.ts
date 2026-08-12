/**
 * The agent-done cue — two quiet sine tones synthesized live with the Web Audio API.
 * It stays short, low and harmonic so completion is noticeable without sounding metallic.
 */

let ctx: AudioContext | null = null

function getCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null
  const AC =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
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

/** One clean tone: `freq` with a quick (click-free) attack and exponential decay.
 *  The base frequency is set DIRECTLY (not only via an automation event) — a brand-new
 *  AudioContext reports currentTime 0 and a setValueAtTime AT exactly t=0 can be skipped,
 *  leaving the oscillator at its 440 Hz default (measured on Electron/Windows). */
function partial(
  ac: AudioContext,
  output: AudioNode,
  freq: number,
  start: number,
  dur: number,
  peak: number,
  type: OscillatorType = 'sine',
): void {
  const osc = ac.createOscillator()
  const gain = ac.createGain()
  osc.type = type
  osc.frequency.value = freq // intrinsic pitch — applies even when the clock hasn't started
  osc.frequency.setValueAtTime(freq, start)
  gain.gain.setValueAtTime(0.0001, start)
  gain.gain.exponentialRampToValueAtTime(peak, start + 0.008)
  gain.gain.exponentialRampToValueAtTime(0.0001, start + dur)
  osc.connect(gain).connect(output)
  osc.start(start)
  osc.stop(start + dur + 0.05)
}

/**
 * Warm the audio context from a user gesture so the first chime is never blocked by
 * autoplay policy. Call once at app start; listeners unhook after the first gesture.
 */
export function primeAgentChime(): void {
  if (typeof window === 'undefined') return
  const arm = (): void => {
    getCtx()
  }
  window.addEventListener('pointerdown', arm, { once: true })
  window.addEventListener('keydown', arm, { once: true })
}

/**
 * Play one restrained two-note completion cue. A low-pass stage softens laptop speakers;
 * the shared master keeps the combined peak far below the former five-partial bell.
 */
export function playAgentDoneChime(): void {
  const ac = getCtx()
  if (!ac) return
  const t = ac.currentTime
  const filter = ac.createBiquadFilter()
  const master = ac.createGain()
  filter.type = 'lowpass'
  filter.frequency.setValueAtTime(1600, t)
  filter.Q.setValueAtTime(0.35, t)
  master.gain.setValueAtTime(0.52, t)
  filter.connect(master).connect(ac.destination)

  // B4 → E5: a compact, consonant rise. Only two pure tones, no metallic overtones.
  partial(ac, filter, 493.88, t, 0.32, 0.04)
  partial(ac, filter, 659.25, t + 0.065, 0.4, 0.03)
}
