import type { TerminalSettings } from '@shared/domain/settings'
import type { TerminalProps } from '@shared/domain/panel'

/**
 * Pure, DOM-free helpers shared by the terminal engine. Nothing here touches React, a store, or a
 * live xterm/DOM node — it's all math + string parsing so it can be reasoned about in isolation.
 */

// ── Render-scale model ───────────────────────────────────────────────────────────────────────────
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

/** Frames to retry a fit when a freshly (re)attached render box still measures zero — covers the
 *  layout gap right after term.element is re-parented into a new container (attach retry). */
export const FIT_RETRY_FRAMES = 5

// ── Whole-device-pixel cell pitch ────────────────────────────────────────────────────────────────
// xterm builds its cell grid from the font's MEASURED advance and then FLOORS it:
//   device.char.width = Math.floor(charSizeService.width × devicePixelRatio)
// JetBrains Mono advances 0.6em, so the requested 13px font measures 7.7999px and is placed on a
// 7px pitch — a 0.8px (10%) deficit on EVERY cell. The glyph is still rasterized at its natural
// 7.8px advance, so each letter's ink runs 0.8px into its neighbour's cell and each letter lands on
// a different sub-pixel phase of the grid. Measured on a real row: 78% of ink pixels carried a
// strong LCD colour fringe and the per-glyph ink centroid scattered ±0.30px — exactly the "letters
// nudged by a fraction of a pixel" look.
// Fix: render at the nearest size whose advance IS a whole device pixel (13 → 13.34, advance 8.0),
// so the pitch xterm floors to and the advance the glyph is drawn with are the same number.
/** Largest deviation from the requested size we will accept to land on the grid (px). */
const MAX_SNAP_DELTA = 1
const SNAP_STEP = 0.02
const SNAP_MAX_STEPS = 24 // 24 × 0.02px of headroom — far more than the quantisation error needs

/**
 * `measureAdvance(px)` MUST measure exactly the way xterm's CharSizeService does
 * (`ctx.font = \`${px}px ${family}\``, then `measureText('W').width`) — anything else measures a
 * different number than the one that will be floored into the cell.
 */
export function snapFontSizeToWholeCell(
  size: number,
  dpr: number,
  measureAdvance: (px: number) => number,
): number {
  const fallback = Math.max(1, Math.round(size))
  if (!(size > 0) || !(dpr > 0)) return fallback
  const advance = measureAdvance(size)
  if (!(advance > 0)) return fallback // font not loaded yet / no 2D context → xterm's own metrics
  const target = Math.max(1, Math.round(advance * dpr))
  if (Math.floor(advance * dpr) === target) return size // already whole — leave the size alone

  // Converge by MEASUREMENT, not by scaling the ratio: a glyph advance is not linear in font size
  // (Chromium quantises advances at small sizes), so the arithmetic guess lands just short. Measured:
  // aiming a 13px/0.6em font at an 8px advance produced 7.99798, which floor() took straight back to
  // 7 — the snap silently did nothing. Stepping up until the measured advance really floors to the
  // whole pixel is the only version that holds for every font/size/dpr combination.
  let px = size * (target / advance)
  for (let i = 0; i < SNAP_MAX_STEPS; i += 1) {
    const floored = Math.floor(measureAdvance(px) * dpr)
    if (floored === target) return Math.abs(px - size) > MAX_SNAP_DELTA ? fallback : px
    if (floored > target) break // overshot a whole pixel — keep the user's size instead
    px += SNAP_STEP
  }
  return fallback
}

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

// ── Emoji width parity with Windows Terminal ───────────────────────────────────────────────────────
// xterm's Unicode-11 wcwidth already gives 2 cells to almost every emoji (U+1F300+ and the 2705-style
// BMP marks), but a handful of BMP emoji-presentation characters (❤ ⚡ ☀ ⭐ ⌚ …) are classified
// "ambiguous" and come out 1 cell — Windows Terminal/ConPTY render them 2 cells wide. The exact
// Emoji_Presentation=Yes list from Unicode's emoji-data.txt. Deliberately EXCLUDES the text-presentation
// marks CLIs use inline (✓✗✻★☆⚠ are not in the list), so monospace alignment never breaks.
const EMOJI_PRESENTATION_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x231a, 0x231b], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3], [0x25fd, 0x25fe],
  [0x2614, 0x2615], [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1],
  [0x26aa, 0x26ab], [0x26bd, 0x26be], [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4],
  [0x26ea, 0x26ea], [0x26f2, 0x26f3], [0x26f5, 0x26f5], [0x26fa, 0x26fa], [0x26fd, 0x26fd],
  [0x2705, 0x2705], [0x270a, 0x270b], [0x2728, 0x2728], [0x274c, 0x274c], [0x274e, 0x274e],
  [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797], [0x27b0, 0x27b0], [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55],
  // supplementary-plane emoji are already wide under Unicode-11; listed anyway for completeness
  [0x1f004, 0x1f004], [0x1f0cf, 0x1f0cf], [0x1f18e, 0x1f18e], [0x1f191, 0x1f19a],
  [0x1f201, 0x1f201], [0x1f21a, 0x1f21a], [0x1f22f, 0x1f22f], [0x1f232, 0x1f236],
  [0x1f238, 0x1f23b], [0x1f250, 0x1f251], [0x1f300, 0x1f320], [0x1f32d, 0x1f335],
  [0x1f337, 0x1f37c], [0x1f37e, 0x1f393], [0x1f3a0, 0x1f3ca], [0x1f3cf, 0x1f3d3],
  [0x1f3e0, 0x1f3f0], [0x1f3f4, 0x1f3f4], [0x1f3f8, 0x1f43e], [0x1f440, 0x1f440],
  [0x1f442, 0x1f4fc], [0x1f4ff, 0x1f53d], [0x1f54b, 0x1f54e], [0x1f550, 0x1f567],
  [0x1f57a, 0x1f57a], [0x1f595, 0x1f596], [0x1f5a4, 0x1f5a4], [0x1f5fb, 0x1f64f],
  [0x1f680, 0x1f6c5], [0x1f6cc, 0x1f6cc], [0x1f6d0, 0x1f6d2], [0x1f6d5, 0x1f6d7],
  [0x1f6dc, 0x1f6df], [0x1f6eb, 0x1f6ec], [0x1f6f4, 0x1f6fc], [0x1f7e0, 0x1f7eb],
  [0x1f7f0, 0x1f7f0], [0x1f90c, 0x1f93a], [0x1f93c, 0x1f945], [0x1f947, 0x1f9ff],
  [0x1fa70, 0x1fa7c], [0x1fa80, 0x1fa88], [0x1fa90, 0x1fabd], [0x1fabf, 0x1fac5],
  [0x1face, 0x1fadb], [0x1fae0, 0x1fae8], [0x1faf0, 0x1faf8],
]

/** True for Unicode Emoji_Presentation=Yes codepoints (rendered as 2-cell emoji by Windows Terminal). */
export function isEmojiPresentationWide(cp: number): boolean {
  for (const [lo, hi] of EMOJI_PRESENTATION_RANGES) {
    if (cp >= lo && cp <= hi) return true
  }
  return false
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
  // msys path → Windows path: "/C:/..." → "C:\..." (e.g. %USERPROFILE%). POSIX paths are left untouched.
  if (/^\/[a-zA-Z]:/.test(s)) s = s.slice(1).replace(/\//g, '\\')
  return s.trim() || null
}
