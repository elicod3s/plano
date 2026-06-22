import type { ITheme } from '@xterm/xterm'
import type { TerminalThemeId } from '@shared/domain/settings'
import { xtermTheme } from './xtermTheme'

/**
 * Terminal color presets. Unlike the app chrome (monochrome), terminal CONTENT is the
 * user's program output, so these palettes carry color freely. "Monolith" is the default
 * recessed-well look; the rest are opt-in per the global default or a per-terminal override.
 *
 * Each preset keeps a legible 16-color ANSI ramp; only surface/cursor/foreground change the
 * overall feel.
 */

export interface TerminalThemeDef {
  id: TerminalThemeId
  label: string
  theme: ITheme
  /**
   * Optional chrome tint for this terminal's panel border/status dot — a small, harmonious
   * accent (like the agent-panel tint), NOT a flood. `null` keeps the panel monochrome.
   */
  accent: string | null
}

const midnight: ITheme = {
  ...xtermTheme,
  background: '#0a0f1e',
  foreground: '#d7e0f2',
  cursor: '#9ec1ff',
  cursorAccent: '#0a0f1e',
  selectionBackground: 'rgba(140,180,255,0.22)',
  black: '#1b2440',
  brightBlack: '#5b6a92',
}

const amber: ITheme = {
  ...xtermTheme,
  background: '#1a1206',
  foreground: '#f3e3c4',
  cursor: '#ffb454',
  cursorAccent: '#1a1206',
  selectionBackground: 'rgba(255,180,84,0.22)',
  black: '#3a2c15',
  brightBlack: '#7a6543',
}

const matrix: ITheme = {
  ...xtermTheme,
  background: '#001403',
  foreground: '#4be06a',
  cursor: '#7dff9b',
  cursorAccent: '#001403',
  selectionBackground: 'rgba(75,224,106,0.22)',
  black: '#053210',
  green: '#5ce07a',
  brightGreen: '#86ff9f',
  white: '#9fe6ad',
  brightBlack: '#2f7a45',
}

const paper: ITheme = {
  background: '#f6f5ef',
  foreground: '#2a2a26',
  cursor: '#2a2a26',
  cursorAccent: '#f6f5ef',
  selectionBackground: 'rgba(0,0,0,0.14)',
  selectionForeground: '#1a1a18',
  black: '#3a3a36',
  red: '#c0392b',
  green: '#3f7d3a',
  yellow: '#9a7a18',
  blue: '#2b6cb0',
  magenta: '#8a4fb0',
  cyan: '#2c8a8a',
  white: '#d9d8d2',
  brightBlack: '#6b6a65',
  brightRed: '#e05548',
  brightGreen: '#5a9a55',
  brightYellow: '#b89530',
  brightBlue: '#4a87c8',
  brightMagenta: '#a36bc8',
  brightCyan: '#3fa3a3',
  brightWhite: '#1a1a18',
}

export const TERMINAL_THEMES: TerminalThemeDef[] = [
  { id: 'monolith', label: 'Monolith', theme: xtermTheme, accent: null },
  { id: 'midnight', label: 'Midnight', theme: midnight, accent: '#7aa2ff' },
  { id: 'amber', label: 'Amber', theme: amber, accent: '#ffb454' },
  { id: 'matrix', label: 'Matrix', theme: matrix, accent: '#57e389' },
  { id: 'paper', label: 'Paper', theme: paper, accent: null },
]

export function getTerminalTheme(id: TerminalThemeId | undefined): ITheme {
  return TERMINAL_THEMES.find((t) => t.id === id)?.theme ?? xtermTheme
}

/** The harmonious chrome tint for a terminal theme, or null to keep the panel monochrome. */
export function getTerminalThemeAccent(id: TerminalThemeId | undefined): string | null {
  return TERMINAL_THEMES.find((t) => t.id === id)?.accent ?? null
}
