import type { TerminalSettings } from '@shared/domain/settings'
import type { TerminalProps } from '@shared/domain/panel'

/**
 * Pure, DOM-free helpers shared by the terminal engine. Nothing here touches React, a store, or a
 * live xterm/DOM node — it's all math + string parsing so it can be reasoned about in isolation.
 */

// ── Render-scale model (ported from Deska) ───────────────────────────────────────────────────────
// The infinite canvas applies ONE scale(zoom) transform to the world layer. A terminal opened
// straight into that layer has its pre-rasterized glyph atlas CSS-UPSCALED when zoom > 1, and the
// overflow:hidden clip edge — after scaling — shaves the last column's glyphs. That clip lives in
// SCALED-PIXEL space, so layout-px math (clientWidth/cellWidth) can never see or prevent it.
// Fix: open xterm into a "render box" sized 100×renderScale % and counter-scaled by 1/renderScale,
// with fontSize = base × renderScale. xterm then rebuilds the atlas at a higher resolution and the
// box shrinks back to the same on-screen size BEFORE the world's scale(zoom) applies — so the net
// scale of a crisp atlas stays ≈ 1 and nothing is shaved. zoom ≤ 1 stays at 1.0 (downscale never
// clips). Snapped to discrete steps so a continuous pinch only rebuilds the atlas a few times.
export const RENDER_SCALE_STEPS: readonly number[] = [1.0, 1.5, 2.0, 2.5]

export function snapRenderScale(zoom: number): number {
  // xterm owns a pixel scroll viewport. Changing its font and counter-scaled render box while the
  // canvas is transformed makes Chromium emit intermediate scroll events with an old scrollTop and a
  // new cell height, which corrupts xterm's logical viewport position. Keep xterm in one layout space:
  // canvas zoom remains a visual transform only and never mutates the terminal grid or its scrollback.
  void zoom
  return 1.0
}

/** Trailing-edge debounce for the fit loop — a continuous resize/zoom gesture coalesces to one fit. */
export const FIT_DEBOUNCE_MS = 32
/** Minimum px delta before re-fitting. Pure CSS-transform changes (pan/zoom) leave clientWidth
 *  alone, so this short-circuits before touching xterm. */
export const FIT_RESIZE_EPSILON = 0.5
/** Frames to retry a fit when a freshly (re)attached render box still measures zero — covers the
 *  layout gap right after term.element is re-parented into a new container (Deska's attach retry). */
export const FIT_RETRY_FRAMES = 5

// Font-size zoom bounds for the in-terminal Ctrl +/− (kept legible at both ends).
export const MIN_FONT_SIZE = 6
export const MAX_FONT_SIZE = 40
export const clampFontSize = (px: number): number =>
  Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, px))

/** Effective BASE terminal font size (before render-scale): the per-panel override (Ctrl +/− zoom)
 *  wins, else the global setting, else 13. The size actually handed to xterm is this × renderScale. */
export const effectiveFontSize = (
  t: TerminalSettings,
  override?: TerminalProps['fontSize'],
): number => {
  if (override && override > 0) return clampFontSize(override)
  return t.fontSize > 0 ? t.fontSize : 13
}

/** Resolve the shell executable to spawn from the terminal settings (undefined = main default). */
export function resolveShell(t: TerminalSettings): string | undefined {
  if (t.shellPath.trim()) return t.shellPath.trim()
  switch (t.shell) {
    case 'powershell':
      return 'powershell.exe'
    case 'pwsh':
      return 'pwsh.exe'
    case 'cmd':
      return 'cmd.exe'
    case 'bash':
      return 'bash'
    case 'zsh':
      return 'zsh'
    case 'fish':
      return 'fish'
    default:
      return undefined // 'auto'
  }
}

/**
 * Parse the path out of an OSC-7 payload the shell emits each prompt (`file:///C:/path`, or a bare
 * path). Returns a native path (Windows drive paths get backslashes) or null if it isn't usable.
 * Drives the live git badge's "follow the terminal's cd" behavior.
 */
export function parseOsc7Cwd(data: string): string | null {
  let s = (data || '').trim()
  if (!s) return null
  if (s.startsWith('file://')) {
    s = s.slice('file://'.length)
    const slash = s.indexOf('/') // drop an optional host before the first '/'
    s = slash >= 0 ? s.slice(slash) : s
  }
  try {
    s = decodeURIComponent(s)
  } catch {
    /* malformed %-encoding — keep the raw string */
  }
  // "/C:/Users/x" → "C:\Users\x" (Windows). POSIX paths are left untouched.
  if (/^\/[a-zA-Z]:/.test(s)) s = s.slice(1).replace(/\//g, '\\')
  return s.trim() || null
}
