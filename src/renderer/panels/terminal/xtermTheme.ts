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

export const TERMINAL_FONT = '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace'
