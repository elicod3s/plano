import { useSettingsStore } from '@/stores/useSettingsStore'

/**
 * Does the user want damped motion? The APP setting (Settings → Appearance → Reduce motion)
 * is the source of truth — never the OS media query. Windows flips
 * `(prefers-reduced-motion: reduce)` for "Animation effects" off / RDP / VM sessions, which
 * would silently kill every canvas animation (see the data-motion gate in theme.css). Use
 * this for any JS-side duration decision (close timers, …) so it agrees with the CSS gate.
 */
export function prefersReducedMotion(): boolean {
  return useSettingsStore.getState().settings.appearance.reduceMotion
}
