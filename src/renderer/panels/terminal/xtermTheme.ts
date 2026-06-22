import type { ITheme } from '@xterm/xterm'

/**
 * Terminal theme. The CHROME is monochrome, but terminal CONTENT is the user's program
 * output — forcing it grayscale would make colored CLI output unreadable. So the ANSI
 * palette stays a tasteful, legible dark set; only the surface/cursor follow Monolith.
 */
export const xtermTheme: ITheme = {
  background: '#0b0b0a', // --surface-inset (recessed well)
  foreground: '#e9e9e6',
  cursor: '#ffffff',
  cursorAccent: '#0b0b0a',
  selectionBackground: 'rgba(255,255,255,0.20)',
  selectionForeground: '#ffffff',

  black: '#2e2d2b',
  red: '#f87171',
  green: '#a3d9a5',
  yellow: '#e6c07b',
  blue: '#88b4f0',
  magenta: '#cba6f7',
  cyan: '#8ad7d7',
  white: '#cfcfca',

  brightBlack: '#6b6a65',
  brightRed: '#fca5a5',
  brightGreen: '#bfe6c0',
  brightYellow: '#f0d9a8',
  brightBlue: '#a9c9f5',
  brightMagenta: '#dcc6fb',
  brightCyan: '#aee3e3',
  brightWhite: '#ffffff',
}

// JetBrains Mono first (box/block/geometric/✓✗ + all Latin). Then the two BUNDLED symbol layers from
// styles/terminal-symbols.css — "PLANO Term Symbols" (Cascadia: Braille spinners + Powerline) and
// "PLANO Term Dingbats" (DejaVu: Claude Code's ✻✳ star marks) — so CLI glyphs render in a real
// monospace on ANY machine. Trailing entries are last-resort OS monospace fallbacks (never a
// proportional system symbol font, which mangles terminal alignment).
export const TERMINAL_FONT =
  '"JetBrains Mono", "PLANO Term Symbols", "PLANO Term Dingbats", "Cascadia Mono", "Cascadia Code", Consolas, "Courier New", ui-monospace, SFMono-Regular, Menlo, "DejaVu Sans Mono", monospace'
