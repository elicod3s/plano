/**
 * Privileged platform detection for the renderer.
 *
 * `navigator.platform` / `userAgentData` are synchronous but NOT authoritative — a Linux
 * session reports `Linux x86_64` while a Windows-over-Wayland Electron may report the host
 * OS. The real `process.platform` lives in the main process and reaches the renderer over
 * IPC via `window.plano.app.getInfo()`.
 *
 * Two-tier API:
 *   - `navigatorPlatform()` / `IS_MAC_SYNC` — synchronous, from navigator. Safe for the
 *     first paint (titlebar layout, hotkey glyphs) where we cannot await an IPC round-trip.
 *     Never used for *behavioural* decisions (CLAUDE.md / hotkeys.ts).
 *   - `fetchPlatform()` / `usePlatform()` — the authoritative `process.platform` from main.
 *     Use this when the platform controls *what options to show or how to behave* (e.g. the
 *     Shell picker filtering PowerShell/cmd out on Linux).
 */

const NAVIGATOR = typeof navigator !== 'undefined' ? navigator : null
const uaData = (NAVIGATOR as { userAgentData?: { platform?: string } } | null)?.userAgentData
const navPlatform = uaData?.platform || NAVIGATOR?.platform || NAVIGATOR?.userAgent || ''

/** Synchronous, navigator-based. Use only for layout/labels that must render on first paint. */
export function navigatorPlatform(): string {
  return navPlatform
}

export const IS_MAC_SYNC = /mac/i.test(navPlatform)
export const IS_WIN_SYNC = /win/i.test(navPlatform)
export const IS_LINUX_SYNC = /linux/i.test(navPlatform)

/**
 * The cached authoritative `process.platform` from the main process.
 * `null` until the first `fetchPlatform()` resolves; `'unknown'` if the IPC call failed.
 */
let cachedPlatform: NodeJS.Platform | null = null
let fetchPromise: Promise<NodeJS.Platform> | null = null

/**
 * Fetch (and cache) the real `process.platform` from main over IPC.
 * Safe to call repeatedly — concurrent callers share the same in-flight promise.
 */
export function fetchPlatform(): Promise<NodeJS.Platform> {
  if (cachedPlatform) return Promise.resolve(cachedPlatform)
  if (fetchPromise) return fetchPromise
  fetchPromise = window.plano.app
    .getInfo()
    .then((info) => {
      cachedPlatform = info.platform
      return info.platform
    })
    .catch(() => {
      // IPC not available (preload not ready, dev server not up) — fall back to navigator.
      // Stash 'linux' | 'darwin' | 'win32' if navigator is clear enough, else 'unknown'.
      if (IS_MAC_SYNC) cachedPlatform = 'darwin'
      else if (IS_WIN_SYNC) cachedPlatform = 'win32'
      else if (IS_LINUX_SYNC) cachedPlatform = 'linux'
      return cachedPlatform ?? 'linux'
    })
    .finally(() => {
      fetchPromise = null
    })
  return fetchPromise
}

/** The cached platform, or `null` if `fetchPlatform()` has not resolved yet. */
export function getCachedPlatform(): NodeJS.Platform | null {
  return cachedPlatform
}

/** True once `fetchPlatform()` has resolved with the authoritative value. */
export function isPlatformReady(): boolean {
  return cachedPlatform !== null
}
