/**
 * WebviewMotionService — keeps pages inside browser panels animating like a normal browser.
 *
 * Two Chromium behaviours otherwise leave embedded pages looking frozen/static:
 *
 * 1. `prefers-reduced-motion` leaks in from the OS/session. Windows with "Animation effects"
 *    off — and ANY Remote Desktop session, where Chromium force-reports reduced motion — make
 *    every embedded page match `(prefers-reduced-motion: reduce)`, so sites that gate their
 *    animations on it (Tailwind `motion-safe:`, Framer Motion, GSAP guards, plain CSS media
 *    queries) render completely static. Browser panels follow PLANO's own Appearance →
 *    "Reduce motion" setting instead: the media feature is overridden per guest through the
 *    built-in CDP debugger, so an intentional reduce-motion user still gets reduced pages.
 *
 * 2. Background throttling: Chromium freezes rAF/timers for guests it considers hidden or
 *    occluded (window covered/minimized, panel panned off the viewport on the infinite
 *    canvas) and doesn't always resume cleanly. Browser panels are live views on a canvas —
 *    keep them unthrottled.
 */

import type { BrowserWindow, WebContents } from 'electron'

export class WebviewMotionService {
  private guests = new Set<WebContents>()

  constructor(private readonly reduceMotion: () => Promise<boolean>) {}

  /** Tune every <webview> guest this window attaches (browser panels are the only users). */
  watch(win: BrowserWindow): void {
    win.webContents.on('did-attach-webview', (_event, guest) => {
      this.guests.add(guest)
      guest.once('destroyed', () => {
        this.guests.delete(guest)
      })
      guest.setBackgroundThrottling(false)
      // Re-assert after every main-frame navigation: a cross-origin navigation can swap the
      // renderer process, and the emulation override must survive it.
      guest.on('did-navigate', () => void this.applyMedia(guest))
      void this.applyMedia(guest)
    })
  }

  /** Re-apply the media override to all live guests — call when settings change. */
  refresh(): void {
    for (const guest of this.guests) void this.applyMedia(guest)
  }

  private async applyMedia(guest: WebContents): Promise<void> {
    try {
      const reduce = await this.reduceMotion()
      if (guest.isDestroyed()) return
      if (!guest.debugger.isAttached()) guest.debugger.attach('1.3')
      await guest.debugger.sendCommand('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-motion', value: reduce ? 'reduce' : 'no-preference' }],
      })
    } catch {
      // Debugger unavailable (e.g. DevTools already attached) — the page keeps OS behaviour.
    }
  }
}
