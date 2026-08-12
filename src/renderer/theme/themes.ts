/**
 * App theme system. PLANO's chrome is driven entirely by the CSS custom properties in
 * `styles/theme.css`; a theme is just a set of overrides written onto <html> at runtime.
 *
 * MONOLITH is the default — the original PLANO charcoal (dark, neutral, pure-white
 * glass). All other themes are opt-in overrides. No theme clears back to `:root`;
 * every theme carries its full override map.
 *
 * Accent is independent of theme: the user's picked accent (or the default "#FFFFFF")
 * overrides only `--accent-primary` / `-hover`. A default white accent defers to the
 * THEME's own accent (e.g. Indigo → indigo), so switching theme re-tints the app; a
 * user-picked accent wins over the theme accent. Soft hover tints stay neutral.
 */

import type { AppearanceSettings, CanvasBackground, ThemeId } from '@shared/domain/settings'

/** The full set of variables a theme controls — applied or cleared as a unit. */
export const THEME_VAR_KEYS = [
  '--bg-canvas',
  '--bg-base',
  '--surface-1',
  '--surface-2',
  '--surface-3',
  '--surface-4',
  '--surface-inset',
  '--glass',
  '--glass-strong',
  '--glass-hover',
  '--glass-active',
  '--glass-sheen',
  '--glass-panel',
  '--glass-bar',
  '--glass-input',
  '--glass-input-hover',
  '--border-subtle',
  '--border-default',
  '--border-strong',
  '--border-glass',
  '--border-glass-strong',
  '--border-glass-hover',
  '--border-grid-minor',
  '--border-grid-major',
  '--grid-dot',
  '--text-primary',
  '--text-secondary',
  '--text-tertiary',
  '--text-quaternary',
  '--text-muted',
  '--text-on-solid',
  '--text-on-accent',
  '--text-1',
  '--text-2',
  '--text-3',
  '--text-4',
  '--accent-soft',
  '--accent-soft-strong',
  '--scrim',
  '--selection-bg',
  '--selection-fg',
  '--region-border',
  '--region-border-hover',
  '--region-fill',
  '--region-fill-hover',
  '--focus-ring',
  '--status-ready',
  '--status-active',
  '--panel-tint',
  '--panel-border',
  '--inset-deep',
  '--inset-soft',
  '--glass-white',
  '--layer-control-hover',
  '--layer-control-active',
  '--layer-edge',
  '--layer-edge-strong',
  '--layer-highlight',
] as const

/** Chroma ramp for dark themes (white alpha glass) / light themes (white glass, dark ink). */
const DARK = '255, 255, 255'
const INK = '26, 34, 48' // dark ink used for borders/text on light themes

const wa = (alpha: number): string => `rgba(${DARK}, ${alpha})`
const inkA = (alpha: number): string => `rgba(${INK}, ${alpha})`

interface ThemeInput {
  /** Canvas background (screen behind everything). */
  bg: string
  /** Base surface (toolbar/dock glass sits over this). */
  base: string
  /** Chrome accent. A user-picked accent overrides this. */
  accent: string
  /** Ink placed on an accent fill. */
  onAccent: string
  /** Text ramp. */
  t1: string
  t2: string
  t3: string
  t4: string
  isLight: boolean
  /** Optional per-theme panel tint (e.g. Indigo panels carry a faint indigo wash). */
  tint?: string
  /** Panel border — accent-tinted for colored themes. */
  panelBorder?: string
  /** Terminal inset background (the dark box the CLI renders in). */
  terminalBg: string
  /** RGB channel of the glass white — the tint translucent surfaces carry. Warm themes
   *  (Monolith) use a cream so chrome reads warm like the canvas, not cold grey; cool
   *  themes keep pure white. Falls back to pure white. */
  glassWhite?: string
}

/** Expand a handful of surface/text inputs into the complete themeable var map. */
function buildTheme(i: ThemeInput): Record<string, string> {
  const light = i.isLight
  const gw = i.glassWhite ?? DARK
  // Dark themes: translucent white glass over a dark canvas. Light themes: near-opaque
  // white glass over a light canvas (the design's Pearl/Mist sheets are ~70–90% white).
  const glass = (a: number): string => `rgba(${light ? DARK : gw}, ${light ? 0.45 + a * 3.4 : a})`
  const border = (a: number): string => (light ? inkA(a) : `rgba(${gw}, ${a})`)
  const grid = (a: number): string => (light ? inkA(a * 1.8) : `rgba(${gw}, ${a})`)
  return {
    '--bg-canvas': i.bg,
    '--bg-base': i.base,
    // Bare RGB channel — consumers wrap it: rgba(var(--glass-white), a) / rgb(var(--glass-white)).
    '--glass-white': gw,
    '--surface-1': glass(0.05),
    '--surface-2': glass(0.08),
    '--surface-3': glass(0.13),
    '--surface-4': glass(0.16),
    '--surface-inset': light ? inkA(0.05) : 'rgba(0, 0, 0, 0.18)',
    '--glass': glass(0.06),
    '--glass-strong': glass(0.09),
    '--glass-hover': glass(0.13),
    '--glass-active': glass(0.16),
    '--glass-sheen': glass(0.12),
    '--glass-panel': glass(0.05),
    '--glass-bar': glass(0.08),
    '--glass-input': light ? 'rgba(255, 255, 255, 0.55)' : 'rgba(0, 0, 0, 0.28)',
    '--glass-input-hover': light ? 'rgba(255, 255, 255, 0.75)' : 'rgba(0, 0, 0, 0.34)',
    '--border-subtle': border(0.06),
    '--border-default': border(0.08),
    '--border-strong': border(0.18),
    '--border-glass': border(0.08),
    '--border-glass-strong': border(0.18),
    '--border-glass-hover': border(0.24),
    '--border-grid-minor': grid(0.035),
    '--border-grid-major': grid(0.055),
    // Dot-grid color — deliberately stronger than the hairlines so dots read at full strength.
    '--grid-dot': light ? inkA(0.16) : `rgba(${gw}, 0.11)`,
    '--text-primary': i.t1,
    '--text-secondary': i.t2,
    '--text-tertiary': i.t3,
    '--text-quaternary': i.t4,
    '--text-muted': i.t4,
    '--text-on-solid': i.onAccent,
    '--text-on-accent': i.onAccent,
    // A large part of the UI predates the semantic names above and uses the compact aliases.
    // They must travel with the theme too; leaving them at :root keeps dark-theme white ink
    // active in Pearl/Mist and makes entire settings surfaces look disabled.
    '--text-1': i.t1,
    '--text-2': i.t2,
    '--text-3': i.t3,
    '--text-4': i.t4,
    '--accent-soft': light ? inkA(0.07) : wa(0.12),
    '--accent-soft-strong': light ? inkA(0.11) : wa(0.16),
    '--scrim': light ? 'rgba(38, 36, 33, 0.28)' : 'rgba(0, 0, 0, 0.62)',
    '--selection-bg': light ? 'rgba(26, 34, 48, 0.14)' : 'rgba(255, 255, 255, 0.18)',
    '--selection-fg': light ? '#1a2230' : '#ffffff',
    '--region-border': border(0.18),
    '--region-border-hover': border(0.34),
    '--region-fill': border(0.02),
    '--region-fill-hover': border(0.04),
    '--focus-ring': light ? 'rgba(26, 34, 48, 0.7)' : 'rgba(255, 255, 255, 0.85)',
    '--status-ready': light ? inkA(0.5) : 'rgba(226, 232, 255, 0.5)',
    '--status-active': light ? i.t1 : '#f2f4ff',
    '--panel-tint': i.tint ?? 'transparent',
    '--panel-border': i.panelBorder ?? 'var(--border-glass-strong)',
    '--inset-deep': i.terminalBg,
    '--inset-soft': light ? inkA(0.05) : 'rgba(0, 0, 0, 0.18)',
    // Structural controls are white-alpha in dark themes and ink-alpha in light themes.
    // Keeping the dark defaults in Pearl/Mist erased borders, hover states and separators.
    '--layer-control-hover': border(0.07),
    '--layer-control-active': border(0.12),
    '--layer-edge': border(0.08),
    '--layer-edge-strong': border(0.18),
    '--layer-highlight': light ? 'rgba(255, 255, 255, 0.58)' : `rgba(${gw}, 0.06)`,
  }
}

export interface ThemeDef {
  id: ThemeId
  label: string
  isLight: boolean
  /** The theme's accent (used when the user accent is the default white). */
  accent: string
  /** Mini-preview colors for the theme card. `base` is the panel surface — the card needs it
   *  because several dark themes share a near-identical `bg` and differ mainly in their
   *  surfaces and accent (Monolith vs Indigo read as the same swatch without it). */
  swatch: { bg: string; base: string; line: string; dot: string; light: boolean }
  /** Override map, or null for the default (clears overrides → :root applies). */
  vars: Record<string, string> | null
}

const def = (id: ThemeId, label: string, input: ThemeInput | null): ThemeDef => ({
  id,
  label,
  isLight: input?.isLight ?? false,
  accent: input?.accent ?? '#ffffff',
  swatch: {
    bg: input?.bg ?? '#0a0b10',
    base: input?.base ?? '#111218',
    line: input?.t2 ?? 'rgba(226, 232, 255, 0.72)',
    dot: input?.accent ?? '#ffffff',
    light: input?.isLight ?? false,
  },
  vars: input ? buildTheme(input) : null,
})

const frost = (
  id: ThemeId,
  label: string,
  accent: string,
  onAccent: string,
  bg: string,
  base: string,
  tint: string | undefined,
  panelBorder: string | undefined,
): ThemeDef =>
  def(id, label, {
    bg,
    base,
    accent,
    onAccent,
    t1: '#f2f4ff',
    t2: 'rgba(226, 232, 255, 0.72)',
    t3: 'rgba(226, 232, 255, 0.5)',
    t4: 'rgba(226, 232, 255, 0.34)',
    isLight: false,
    tint,
    panelBorder,
    terminalBg: 'rgba(5, 6, 11, 0.6)',
  })

export const THEMES: ThemeDef[] = [
  // Monolith — the ORIGINAL PLANO charcoal (pre-redesign): dark, neutral, near-zero
  // warm cast. This is the default theme; pure-white glass keeps it neutral, not brown.
  def('monolith', 'Monolith', {
    bg: '#141414',
    base: '#191918',
    accent: '#ffffff',
    onAccent: '#0e0e0d',
    t1: '#f5f5f4',
    t2: 'rgba(201, 201, 196, 0.72)',
    t3: '#9a9994',
    t4: '#8a8984',
    isLight: false,
    terminalBg: 'rgba(10, 10, 9, 0.65)',
  }),
  // Indigo — deep indigo glass, periwinkle accent, faint indigo panel wash.
  frost(
    'indigo',
    'Indigo',
    '#8b9bff',
    '#ffffff',
    '#0a0c18',
    '#0d1020',
    'rgba(99, 102, 241, 0.15)',
    'rgba(139, 155, 255, 0.2)',
  ),
  // Orange — warm ember glass, soft-orange accent.
  frost(
    'orange',
    'Orange',
    '#fb923c',
    '#1a0e06',
    '#160f0c',
    '#1c1410',
    'rgba(249, 115, 22, 0.15)',
    'rgba(251, 146, 60, 0.2)',
  ),
  // Tokyo — night-neon glass, pink accent with cyan+magenta pools.
  frost(
    'tokyo',
    'Tokyo',
    '#f472b6',
    '#ffffff',
    '#0a0a14',
    '#0e0e1c',
    'rgba(244, 114, 182, 0.16)',
    'rgba(244, 114, 182, 0.2)',
  ),
  // Sakura — plum glass, soft pink accent.
  frost(
    'sakura',
    'Sakura',
    '#f9a8d4',
    '#2a0e24',
    '#150e14',
    '#1b111a',
    'rgba(249, 168, 212, 0.16)',
    'rgba(249, 168, 212, 0.24)',
  ),
  // Pearl — warm light glass, ink accent.
  def('pearl', 'Pearl', {
    bg: '#f2efe9',
    base: '#f8f6f1',
    accent: '#211f1b',
    onAccent: '#faf8f4',
    t1: '#211f1b',
    t2: 'rgba(33, 31, 27, 0.7)',
    t3: 'rgba(33, 31, 27, 0.5)',
    t4: 'rgba(33, 31, 27, 0.34)',
    isLight: true,
    terminalBg: '#e5e1d8',
  }),
  // Mist — cool light glass, slate ink.
  def('mist', 'Mist', {
    bg: '#ecf0f6',
    base: '#f4f6fb',
    accent: '#1a2230',
    onAccent: '#fdfdff',
    t1: '#1a2230',
    t2: 'rgba(26, 34, 48, 0.7)',
    t3: 'rgba(26, 34, 48, 0.5)',
    t4: 'rgba(26, 34, 48, 0.34)',
    isLight: true,
    terminalBg: '#e6eaf2',
  }),
  // Paper — pure-white glass, neutral ink. The cleanest light theme: no warm cast (Pearl),
  // no blue cast (Mist); near-white paper with a crisp graphite ink.
  def('paper', 'Paper', {
    bg: '#f8f8fa',
    base: '#ffffff',
    accent: '#17181d',
    onAccent: '#fdfdff',
    t1: '#17181d',
    t2: 'rgba(23, 24, 29, 0.68)',
    t3: 'rgba(23, 24, 29, 0.48)',
    t4: 'rgba(23, 24, 29, 0.32)',
    isLight: true,
    terminalBg: '#eceef2',
  }),
]

export function getTheme(id: ThemeId): ThemeDef {
  return THEMES.find((t) => t.id === id) ?? THEMES.find((t) => t.id === 'monolith') ?? THEMES[0]
}

/** Accent swatches (from the design file). White is the default — it defers to the theme accent. */
export interface AccentDef {
  id: string
  label: string
  hex: string
}
export const ACCENTS: AccentDef[] = [
  { id: 'white', label: 'White', hex: '#FFFFFF' },
  { id: 'red', label: 'Red', hex: '#F87171' },
  { id: 'orange', label: 'Orange', hex: '#FB923C' },
  { id: 'amber', label: 'Amber', hex: '#FACC15' },
  { id: 'green', label: 'Green', hex: '#4ADE80' },
  { id: 'cyan', label: 'Cyan', hex: '#22D3EE' },
  { id: 'blue', label: 'Blue', hex: '#60A5FA' },
  { id: 'purple', label: 'Purple', hex: '#A78BFA' },
  { id: 'magenta', label: 'Magenta', hex: '#F472B6' },
]

const WHITE = new Set(['#fff', '#ffffff'])

/** Resolve the canvas substrate's CSS background from the user's appearance settings.
 *  'theme' defers to the theme's --bg-canvas; solid/gradient paint literally. */
export function canvasBackgroundCss(bg: CanvasBackground): string {
  switch (bg.kind) {
    case 'solid':
      return bg.colors[0]
    case 'linear':
      return `linear-gradient(${Math.round(bg.angle)}deg, ${bg.colors[0]} 0%, ${bg.colors[1]} 100%)`
    case 'radial':
      return `radial-gradient(130% 130% at 50% 32%, ${bg.colors[0]} 0%, ${bg.colors[1]} 100%)`
    case 'theme':
    default:
      return 'var(--bg-canvas)'
  }
}

/** The ambient accent halo painted over the substrate — a soft radial wash that re-tints with
 *  the user's accent. strength is 0–40 (% alpha); 0 renders 'none' so no layer is allocated. */
export function canvasGlowCss(accent: string, strength: number): string {
  if (strength <= 0) return 'none'
  const alpha = Math.min(40, Math.max(0, strength)) / 100
  return `radial-gradient(140% 120% at 68% 22%, color-mix(in srgb, ${accent} ${Math.round(alpha * 100)}%, transparent) 0%, transparent 68%)`
}

/** Pick WCAG-safe ink for the actual accent, including a user-selected swatch. */
function textForAccent(color: string, fallback: string): string {
  const raw = color.trim().replace(/^#/, '')
  const hex = raw.length === 3 ? raw.split('').map((c) => c + c).join('') : raw
  if (!/^[0-9a-f]{6}$/i.test(hex)) return fallback
  const channels = [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255)
  const [r, g, b] = channels.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  )
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b
  // At L=0.179, black and white have equal WCAG contrast. Stay a little off the extremes
  // so the pill text matches the app's warm/cool ink instead of looking browser-default.
  return luminance > 0.179 ? '#111318' : '#fdfdff'
}

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

  // Accent: the user's pick wins; a white (default) accent defers to the theme accent
  // (Indigo theme → indigo accent). White-on-light would be invisible → fall back to ink.
  const isWhite = WHITE.has(a.accent.toLowerCase())
  const eff = isWhite ? theme.accent : a.accent
  const effFinal = isWhite && theme.isLight && WHITE.has(theme.accent.toLowerCase()) ? '#1f1f1d' : eff
  const onAccent = textForAccent(effFinal, theme.vars?.['--text-on-accent'] ?? '#fdfdff')
  root.style.setProperty('--accent-primary', effFinal)
  root.style.setProperty('--accent-primary-hover', `color-mix(in srgb, ${effFinal} 88%, #000)`)
  root.style.setProperty('--text-on-solid', onAccent)
  root.style.setProperty('--text-on-accent', onAccent)

  // data-motion is ALWAYS explicit once settings hydrate.
  root.dataset.motion = a.reduceMotion ? 'reduced' : 'full'
}
