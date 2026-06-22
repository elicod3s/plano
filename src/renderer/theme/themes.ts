/**
 * App theme system. PLANO's chrome is driven entirely by the CSS custom properties in
 * `styles/theme.css`; a theme is just a set of overrides written onto <html> at runtime.
 *
 * The DEFAULT ("monolith") clears every override so the :root values apply byte-for-byte —
 * the locked warm-neutral monochrome look is untouched unless the user opts into another
 * theme. Colored themes (indigo, cyber) and a light theme are opt-in, per the owner's call
 * to relax the monochrome rule for user-chosen themes (see CLAUDE.md → Hard design rules).
 *
 * Accent is independent of theme: it overrides only `--accent-primary` / `-hover`. The soft
 * hover tints stay theme-neutral so the accent stays a sparing highlight, not a flood.
 */

import type { AppearanceSettings, ThemeId } from '@shared/domain/settings'

/** The full set of variables a theme controls — applied or cleared as a unit. */
export const THEME_VAR_KEYS = [
  '--bg-canvas',
  '--bg-base',
  '--surface-1',
  '--surface-2',
  '--surface-3',
  '--surface-4',
  '--surface-inset',
  '--border-subtle',
  '--border-default',
  '--border-strong',
  '--border-grid-minor',
  '--border-grid-major',
  '--text-primary',
  '--text-secondary',
  '--text-tertiary',
  '--text-quaternary',
  '--text-on-solid',
  '--accent-soft',
  '--accent-soft-strong',
  '--scrim',
  '--selection-bg',
  '--region-border',
  '--region-border-hover',
  '--region-fill',
  '--region-fill-hover',
  '--focus-ring',
] as const

interface ThemeInput {
  bg: string
  base: string
  s1: string
  s2: string
  s3: string
  s4: string
  inset: string
  textPrimary: string
  textSecondary: string
  textTertiary: string
  textQuaternary: string
  /** Ink placed on an accent fill (dark for light-accent buttons, light for dark-accent). */
  onSolid: string
  isLight: boolean
}

/** Expand a handful of surface/text inputs into the complete themeable var map. */
function buildTheme(i: ThemeInput): Record<string, string> {
  const ch = i.isLight ? '0, 0, 0' : '255, 255, 255'
  const a = (alpha: number): string => `rgba(${ch}, ${alpha})`
  return {
    '--bg-canvas': i.bg,
    '--bg-base': i.base,
    '--surface-1': i.s1,
    '--surface-2': i.s2,
    '--surface-3': i.s3,
    '--surface-4': i.s4,
    '--surface-inset': i.inset,
    '--border-subtle': a(0.06),
    '--border-default': a(0.1),
    '--border-strong': a(0.16),
    '--border-grid-minor': a(i.isLight ? 0.08 : 0.05),
    '--border-grid-major': a(i.isLight ? 0.12 : 0.07),
    '--text-primary': i.textPrimary,
    '--text-secondary': i.textSecondary,
    '--text-tertiary': i.textTertiary,
    '--text-quaternary': i.textQuaternary,
    '--text-on-solid': i.onSolid,
    '--accent-soft': a(0.08),
    '--accent-soft-strong': a(0.14),
    '--scrim': i.isLight ? 'rgba(38, 38, 42, 0.3)' : 'rgba(8, 8, 8, 0.64)',
    '--selection-bg': a(i.isLight ? 0.16 : 0.18),
    '--region-border': a(0.26),
    '--region-border-hover': a(0.5),
    '--region-fill': a(0.025),
    '--region-fill-hover': a(0.045),
    '--focus-ring': i.isLight ? 'rgba(0, 0, 0, 0.72)' : 'rgba(255, 255, 255, 0.9)',
  }
}

export interface ThemeDef {
  id: ThemeId
  label: string
  isLight: boolean
  /** Mini-preview colors for the theme card. */
  swatch: { bg: string; line: string; dot: string }
  /** The theme's REAL surface ramp [canvas, s1, s2, s3, s4] — drawn as a paint-chip. */
  ramp: string[]
  /** Override map, or null for the default (clears overrides → :root applies). */
  vars: Record<string, string> | null
}

const def = (
  id: ThemeId,
  label: string,
  input: ThemeInput | null,
  dot: string,
  /** Literal preview colors when input is null (default theme reads from :root at runtime). */
  fallback?: { bg: string; line: string },
): ThemeDef => ({
  id,
  label,
  isLight: input?.isLight ?? false,
  swatch: {
    bg: input?.base ?? fallback?.bg ?? '#141414',
    line: input?.textSecondary ?? fallback?.line ?? '#a1a1aa',
    dot,
  },
  ramp: input
    ? [input.bg, input.s1, input.s2, input.s3, input.s4]
    : ['#0e0e0d', '#1a1a19', '#201f1e', '#272625', '#2e2d2b'],
  vars: input ? buildTheme(input) : null,
})

export const THEMES: ThemeDef[] = [
  def('monolith', 'Monolith', null, '#ffffff', { bg: '#141414', line: '#a1a1aa' }),
  def(
    'slate',
    'Slate',
    {
      bg: '#0d0e11', base: '#121318', s1: '#181a1f', s2: '#1e2026', s3: '#25272e', s4: '#2c2f37',
      inset: '#0a0b0e', textPrimary: '#ffffff', textSecondary: '#a3a6b2', textTertiary: '#888b97',
      textQuaternary: '#686b76', onSolid: '#0d0e11', isLight: false,
    },
    '#c7cad6',
  ),
  def(
    'carbon',
    'Carbon',
    {
      bg: '#000000', base: '#060606', s1: '#0d0d0d', s2: '#141414', s3: '#1b1b1b', s4: '#232323',
      inset: '#000000', textPrimary: '#ffffff', textSecondary: '#a1a1a1', textTertiary: '#8a8a8a',
      textQuaternary: '#6a6a6a', onSolid: '#000000', isLight: false,
    },
    '#ffffff',
  ),
  def(
    'dark-warm',
    'Dark Warm',
    {
      bg: '#100e0b', base: '#17140f', s1: '#1e1a14', s2: '#251f18', s3: '#2d261d', s4: '#352d22',
      inset: '#0c0a07', textPrimary: '#ffffff', textSecondary: '#b0a594', textTertiary: '#978c7c',
      textQuaternary: '#726a5d', onSolid: '#100e0b', isLight: false,
    },
    '#e6c07b',
  ),
  def(
    'indigo',
    'Indigo',
    {
      bg: '#14121d', base: '#1a1726', s1: '#211d31', s2: '#28233b', s3: '#2f2946', s4: '#382f54',
      inset: '#100e18', textPrimary: '#f4f1ff', textSecondary: '#b3acce', textTertiary: '#938cb0',
      textQuaternary: '#6f6889', onSolid: '#14121d', isLight: false,
    },
    '#b18cff',
  ),
  def(
    'cyber',
    'Cyber',
    {
      bg: '#08151b', base: '#0d1d24', s1: '#122830', s2: '#16323c', s3: '#1b3d49', s4: '#214a58',
      inset: '#061116', textPrimary: '#eafcff', textSecondary: '#9fc4cd', textTertiary: '#7fa6b0',
      textQuaternary: '#5d808a', onSolid: '#08151b', isLight: false,
    },
    '#4fd1c5',
  ),
  def(
    'light',
    'Light',
    {
      bg: '#f1f1ef', base: '#fbfbfa', s1: '#ffffff', s2: '#f6f6f4', s3: '#efefec', s4: '#e7e7e3',
      inset: '#ededeb', textPrimary: '#1a1a18', textSecondary: '#55554f', textTertiary: '#74746c',
      textQuaternary: '#9a9a90', onSolid: '#ffffff', isLight: true,
    },
    '#1f1f1d',
  ),
]

export function getTheme(id: ThemeId): ThemeDef {
  return THEMES.find((t) => t.id === id) ?? THEMES[0]
}

/** Accent swatches. White ("Mono") is the monochrome default; it auto-flips to ink on light. */
export interface AccentDef {
  id: string
  label: string
  hex: string
}
export const ACCENTS: AccentDef[] = [
  { id: 'mono', label: 'Mono', hex: '#FFFFFF' },
  { id: 'coral', label: 'Coral', hex: '#ff7a66' },
  { id: 'amber', label: 'Amber', hex: '#f5b449' },
  { id: 'teal', label: 'Teal', hex: '#4fd1c5' },
  { id: 'azure', label: 'Azure', hex: '#5b9cff' },
  { id: 'violet', label: 'Violet', hex: '#b18cff' },
  { id: 'rose', label: 'Rose', hex: '#ff8fc7' },
  { id: 'lime', label: 'Lime', hex: '#9bdc77' },
]

const WHITE = new Set(['#fff', '#ffffff'])

/**
 * Apply theme + accent + reduced-motion to <html>. Idempotent: every themeable var is
 * either set (non-default theme) or cleared (default), so switching themes never leaves a
 * previous theme's overrides behind.
 */
export function applyAppearance(a: AppearanceSettings): void {
  const root = document.documentElement
  const theme = getTheme(a.theme)

  if (theme.vars) {
    for (const [k, v] of Object.entries(theme.vars)) root.style.setProperty(k, v)
  } else {
    for (const k of THEME_VAR_KEYS) root.style.removeProperty(k)
  }
  root.dataset.theme = theme.id

  // Accent. White on a dark theme = the :root default (cleared). White on a light theme
  // would be invisible on white surfaces, so fall back to ink.
  const isWhite = WHITE.has(a.accent.toLowerCase())
  const eff = isWhite ? (theme.isLight ? '#1f1f1d' : null) : a.accent
  if (eff) {
    root.style.setProperty('--accent-primary', eff)
    root.style.setProperty('--accent-primary-hover', `color-mix(in srgb, ${eff} 90%, #000)`)
  } else {
    root.style.removeProperty('--accent-primary')
    root.style.removeProperty('--accent-primary-hover')
  }

  if (a.reduceMotion) root.dataset.motion = 'reduced'
  else delete root.dataset.motion
}
