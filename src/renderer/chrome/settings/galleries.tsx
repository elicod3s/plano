/**
 * Visual pickers for Appearance + Terminal — the new glass design:
 *  - themes are 92px cards with a mini canvas preview (3 bars) + a check badge when active,
 *  - the accent is a row of 20px dots in 34px rings,
 *  - the grid picker draws the actual dot/line pattern it selects.
 * Each picker renders with literal colors so it shows what it would look like.
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { THEMES, ACCENTS, getTheme, canvasBackgroundCss, canvasGlowCss, type ThemeDef } from '@/theme/themes'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { TERMINAL_THEMES } from '@/panels/terminal/terminalThemes'
import type { ThemeId, TerminalThemeId, GridStyle, CanvasBackground, CanvasBackgroundKind } from '@shared/domain/settings'
import { Icon } from '@/design-system/Icon'
import { cn } from '@/lib/cn'
import { Slider } from './controls'

/** Mini-canvas bar colors for the theme preview: white-alpha on dark themes, ink on light. */
function barsFor(theme: { isLight: boolean }): [string, string, string] {
  if (theme.isLight) return ['rgba(26, 34, 48, 0.7)', 'rgba(26, 34, 48, 0.35)', 'rgba(26, 34, 48, 0.22)']
  return ['rgba(255, 255, 255, 0.65)', 'rgba(255, 255, 255, 0.35)', 'rgba(255, 255, 255, 0.22)']
}

export function ThemeGallery({
  value,
  onChange,
}: {
  value: ThemeId
  onChange: (id: ThemeId) => void
}) {
  return (
    <>
      {THEMES.map((t) => {
        const active = t.id === value
        const [, b2, b3] = barsFor(t)
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => onChange(t.id)}
            aria-label={t.label}
            title={t.label}
            className={cn(
              'group flex flex-col items-stretch gap-1.5 focus-caliper',
            )}
          >
            {/* Mini canvas preview. Three NEUTRAL bars on the substrate made the dark themes
                near-indistinguishable — Monolith (#141414) and Indigo (#0a0c18) differ by a hue
                you cannot read at 54px, so the first two cards looked identical. The card now
                shows what actually separates the themes: a panel surface in the theme's own
                `base`, and a leading bar in the theme's ACCENT. */}
            <span
              className="relative flex h-[54px] w-full flex-col justify-end gap-1 overflow-hidden rounded-[13px] p-2.5"
              style={{
                background: t.swatch.bg,
                // Inset ring, never a border: a 1px border lets the substrate paint under it and
                // shifts the card by a pixel between states (same fix as the Background tiles).
                boxShadow: active
                  ? 'inset 0 0 0 1.5px color-mix(in srgb, var(--accent-primary) 80%, transparent)'
                  : 'inset 0 0 0 1px rgba(127,127,127,0.22)',
                transition: 'box-shadow 160ms var(--ease-settle)',
              }}
            >
              {/* the theme's panel surface, so `base` reads even when `bg` barely differs */}
              <span
                className="absolute inset-x-2.5 top-2.5 h-[18px] rounded-[5px]"
                style={{ background: t.swatch.base, boxShadow: `inset 0 0 0 1px ${b3}` }}
              />
              <span className="h-[6px] w-10 rounded-[3px]" style={{ background: t.accent }} />
              <span className="h-[5px] w-[54px] rounded-[3px]" style={{ background: b2 }} />
              <span className="h-[5px] w-[46px] rounded-[3px]" style={{ background: b3 }} />
              {active && (
                <span
                  className="absolute right-1.5 top-1.5 flex h-4 w-4 items-center justify-center rounded-pill"
                  style={{ background: t.isLight ? '#1a2230' : '#ffffff' }}
                >
                  <Icon
                    name="Check"
                    size={9}
                    strokeWidth={3}
                    className={t.isLight ? 'text-[#fdfdff]' : 'text-[#0b0d1a]'}
                  />
                </span>
              )}
            </span>
            <span className={cn('truncate text-center text-[11.5px]', active ? 'text-text-1' : 'text-text-2')}>
              {t.label}
            </span>
          </button>
        )
      })}
    </>
  )
}

/** Rainbow swatch for the custom accent — opens the inline PLANO-style picker. */
const RAINBOW = 'conic-gradient(from 180deg, #ff5f6d, #ffb84d, #f9f871, #6ee7b7, #22d3ee, #8ea2ff, #f472b6, #ff5f6d)'

// ── HSV ⇄ hex (small color-picker math; no dependency) ──
function hsvToHex(h: number, s: number, v: number): string {
  const c = v * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = v - c
  let r = 0
  let g = 0
  let b = 0
  if (h < 60) [r, g, b] = [c, x, 0]
  else if (h < 120) [r, g, b] = [x, c, 0]
  else if (h < 180) [r, g, b] = [0, c, x]
  else if (h < 240) [r, g, b] = [0, x, c]
  else if (h < 300) [r, g, b] = [x, 0, c]
  else [r, g, b] = [c, 0, x]
  const to = (n: number): string => Math.round((n + m) * 255).toString(16).padStart(2, '0')
  return `#${to(r)}${to(g)}${to(b)}`
}

function hexToHsv(hex: string): { h: number; s: number; v: number } {
  const raw = hex.replace('#', '')
  const full = raw.length === 3 ? raw.split('').map((ch) => ch + ch).join('') : raw
  const n = Number.parseInt(full, 16) || 0
  const r = ((n >> 16) & 255) / 255
  const g = ((n >> 8) & 255) / 255
  const b = (n & 255) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  let h = 0
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h *= 60
    if (h < 0) h += 360
  }
  return { h, s: max === 0 ? 0 : d / max, v: max }
}

/** PLANO-styled color picker: saturation/lightness field + hue rail + hex input. */
/**
 * Dismiss an open inline panel the way every other overlay in PLANO closes: a pointer-down
 * anywhere outside it, or Escape. Without this the only way out of the color picker was to
 * click the very swatch that opened it, which reads as "nothing here commits my choice".
 * Colors apply live as they are picked, so dismissing IS the commit — there is no cancel.
 */
function useDismiss(ref: React.RefObject<HTMLElement>, onDismiss: () => void, active: boolean): void {
  useEffect(() => {
    if (!active) return
    const onPointerDown = (e: PointerEvent): void => {
      const el = ref.current
      if (!el) return
      const target = e.target as Node | null
      // The trigger lives outside the panel; it toggles itself, so ignore clicks on it here
      // (otherwise both handlers fire and the panel closes then immediately reopens).
      if (target && (el.contains(target) || (target as HTMLElement).closest?.('[data-picker-trigger]'))) return
      onDismiss()
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onDismiss()
      }
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [ref, onDismiss, active])
}

function CustomColorPicker({
  value,
  onChange,
  onDone,
}: {
  value: string
  onChange: (hex: string) => void
  /** When given, the picker shows an explicit Done button that closes it. */
  onDone?: () => void
}) {
  const initial = hexToHsv(value)
  const [h, setH] = useState(initial.h)
  const [sv, setSv] = useState({ s: initial.s, v: initial.v })
  const [hexDraft, setHexDraft] = useState(value.replace('#', ''))
  const svRef = useRef<HTMLDivElement>(null)
  const hueRef = useRef<HTMLDivElement>(null)

  const emit = (nh: number, ns: number, nv: number): void => {
    setH(nh)
    setSv({ s: ns, v: nv })
    const hex = hsvToHex(nh, ns, nv)
    setHexDraft(hex.replace('#', ''))
    onChange(hex)
  }

  const updateSv = (e: React.PointerEvent): void => {
    const el = svRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const s = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))
    const v = 1 - Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))
    emit(h, s, v)
  }
  const updateHue = (e: React.PointerEvent): void => {
    const el = hueRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const nh = Math.min(360, Math.max(0, ((e.clientY - r.top) / r.height) * 360))
    emit(nh, sv.s, sv.v)
  }

  const hue = `hsl(${Math.round(h)} 100% 50%)`
  const current = hsvToHex(h, sv.s, sv.v)

  return (
    <div>
      <div className="flex gap-3">
        {/* saturation / lightness field */}
        <div
          ref={svRef}
          className="relative h-[104px] flex-1 cursor-crosshair rounded-[12px]"
          style={{
            background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${hue})`,
            boxShadow: 'inset 0 0 0 1px rgba(127, 127, 127, 0.28)',
            touchAction: 'none',
          }}
          onPointerDown={(e) => {
            updateSv(e)
            e.currentTarget.setPointerCapture(e.pointerId)
          }}
          onPointerMove={(e) => {
            if (e.buttons & 1) updateSv(e)
          }}
        >
          <span
            className="pointer-events-none absolute h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-pill border-2 border-white shadow-md"
            style={{ left: `${sv.s * 100}%`, top: `${(1 - sv.v) * 100}%`, background: current }}
          />
        </div>
        {/* hue rail */}
        <div
          ref={hueRef}
          className="relative w-6 cursor-pointer rounded-[12px]"
          style={{
            background: 'linear-gradient(to bottom, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)',
            boxShadow: 'inset 0 0 0 1px rgba(127, 127, 127, 0.28)',
            touchAction: 'none',
          }}
          onPointerDown={(e) => {
            updateHue(e)
            e.currentTarget.setPointerCapture(e.pointerId)
          }}
          onPointerMove={(e) => {
            if (e.buttons & 1) updateHue(e)
          }}
        >
          <span
            className="pointer-events-none absolute left-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-pill border-2 border-white shadow-md"
            style={{ top: `${(h / 360) * 100}%`, background: hue }}
          />
        </div>
      </div>

      {/* preview + hex readout */}
      <div className="mt-3 flex items-center gap-2.5">
        <span
          className="h-6 w-6 shrink-0 rounded-pill"
          style={{ background: current, boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.18)' }}
        />
        <label className="flex items-center gap-1.5 rounded-[11px] border border-glass bg-inset px-2.5 py-1.5 transition-colors focus-within:border-glass-hover">
          <span className="font-mono text-[12px] text-text-3">#</span>
          <input
            value={hexDraft}
            spellCheck={false}
            onChange={(e) => {
              const v = e.target.value.replace(/[^0-9a-fA-F]/g, '').slice(0, 6)
              setHexDraft(v)
              if (v.length === 6) {
                const next = hexToHsv(v)
                setH(next.h)
                setSv({ s: next.s, v: next.v })
                onChange(`#${v.toLowerCase()}`)
              }
            }}
            placeholder="8EA2FF"
            className="w-[88px] bg-transparent font-mono text-[12.5px] uppercase text-text-1 placeholder:text-text-4 focus:outline-none"
          />
        </label>
        {onDone && (
          <button
            type="button"
            onClick={onDone}
            className={cn(
              'ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-pill px-3 py-1.5 text-[12px]',
              'text-text-1 transition-colors focus-caliper',
            )}
            style={{ background: 'var(--glass)' }}
          >
            <Icon name="Check" size={13} />
            Done
          </button>
        )}
      </div>
    </div>
  )
}

export function AccentSwatches({
  value,
  onChange,
}: {
  value: string
  onChange: (hex: string) => void
}) {
  const sel = value.toLowerCase()
  const preset = ACCENTS.find((a) => a.hex.toLowerCase() === sel)
  const isCustom = !preset
  const activeHex = preset?.hex ?? (/^#[0-9a-f]{6}$/i.test(value) ? value : '#ffffff')
  const [customOpen, setCustomOpen] = useState(false)
  const customRef = useRef<HTMLDivElement>(null)

  const toggleCustom = (): void => {
    setCustomOpen((o) => !o)
  }
  const closeCustom = useCallback(() => setCustomOpen(false), [])
  useDismiss(customRef, closeCustom, customOpen)

  return (
    <div>
      {/* five preset accents + the rainbow custom swatch */}
      <div className="flex flex-wrap items-center gap-2 pl-1">
        {ACCENTS.map((a) => {
          const active = a.hex.toLowerCase() === sel
          return (
            <button
              key={a.id}
              type="button"
              title={a.label}
              aria-label={`Accent ${a.label}`}
              aria-pressed={active}
              onClick={() => {
                setCustomOpen(false)
                onChange(a.hex)
              }}
              className={cn(
                'flex h-[30px] w-[30px] items-center justify-center rounded-pill transition-transform hover:scale-110 focus-caliper',
              )}
              style={active ? { boxShadow: '0 0 0 1.5px var(--focus-ring)' } : undefined}
            >
              <span
                className="h-[22px] w-[22px] rounded-pill"
                style={{ background: a.hex, boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.18)' }}
              />
            </button>
          )
        })}
        <button
          type="button"
          data-picker-trigger
          title="Custom color"
          aria-label="Custom accent color"
          aria-expanded={customOpen}
          aria-pressed={isCustom}
          onClick={toggleCustom}
          className={cn(
            'flex h-[30px] w-[30px] items-center justify-center rounded-pill transition-transform hover:scale-110 focus-caliper',
          )}
          style={isCustom ? { boxShadow: '0 0 0 1.5px var(--focus-ring)' } : undefined}
        >
          <span
            className="h-[22px] w-[22px] rounded-pill"
            style={{ background: RAINBOW, boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.22)' }}
          />
        </button>
      </div>

      {/* inline custom picker — PLANO surface, full color field + hue rail + hex */}
      {customOpen && (
        <div
          ref={customRef}
          className="animate-menu-in mt-3 rounded-[14px] border border-glass bg-surface-2 p-3"
          style={{ boxShadow: '0 12px 32px -12px rgba(0,0,0,0.55)' }}
        >
          <div className="label-caps mb-2.5">Custom color</div>
          <CustomColorPicker value={activeHex} onChange={(hex) => onChange(hex)} onDone={closeCustom} />
        </div>
      )}
    </div>
  )
}

function patternStyle(id: GridStyle): CSSProperties {
  const ink = 'var(--text-quaternary)'
  if (id === 'lines') {
    return {
      background: 'var(--surface-inset)',
      backgroundImage: `linear-gradient(${ink} 1px, transparent 1px), linear-gradient(90deg, ${ink} 1px, transparent 1px)`,
      backgroundSize: '9px 9px',
    }
  }
  if (id === 'dots') {
    return {
      background: 'var(--surface-inset)',
      backgroundImage: `radial-gradient(${ink} 1px, transparent 1px)`,
      backgroundSize: '9px 9px',
    }
  }
  return { background: 'var(--surface-inset)' }
}

/** Grid-pattern picker — each tile draws the actual pattern it selects. */
export function GridStylePicker({
  value,
  onChange,
}: {
  value: GridStyle
  onChange: (v: GridStyle) => void
}) {
  const opts: { id: GridStyle; label: string }[] = [
    { id: 'dots', label: 'Dots' },
    { id: 'lines', label: 'Lines' },
    { id: 'none', label: 'None' },
  ]
  return (
    <div className="flex gap-2">
      {opts.map((o) => {
        const active = o.id === value
        return (
          <button
            key={o.id}
            type="button"
            onClick={() => onChange(o.id)}
            className={cn(
              'flex-1 overflow-hidden rounded-[13px] border transition-all focus-caliper',
              active ? 'border-glass-hover ring-1 ring-[var(--focus-ring)]' : 'border-glass hover:border-glass-hover',
            )}
          >
            <div className="relative h-11 w-full" style={patternStyle(o.id)}>
              {o.id === 'none' && (
                <span className="absolute inset-0 flex items-center justify-center font-mono text-[10px] text-text-quaternary">
                  ∅
                </span>
              )}
            </div>
            <div
              className={cn(
                'border-t border-glass py-1 text-center text-[11px] font-medium transition-colors',
                active ? 'bg-glass-hover text-text-1' : 'text-text-2',
              )}
            >
              {o.label}
            </div>
          </button>
        )
      })}
    </div>
  )
}

export function TerminalThemeGallery({
  value,
  onChange,
}: {
  value: TerminalThemeId
  onChange: (id: TerminalThemeId) => void
}) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {TERMINAL_THEMES.map((t) => {
        const active = t.id === value
        const th = t.theme
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => onChange(t.id)}
            className={cn(
              'overflow-hidden rounded-[13px] border text-left transition-all focus-caliper',
              active ? 'border-glass-hover ring-1 ring-[var(--focus-ring)]' : 'border-glass hover:border-glass-hover',
            )}
          >
            <div className="flex h-[50px] items-end gap-1 px-2.5 pb-2" style={{ background: th.background }}>
              {[th.green, th.blue, th.yellow, th.magenta, th.cyan, th.red].map((c, j) => (
                <span key={j} className="h-2 w-2 rounded-[2px]" style={{ background: c }} />
              ))}
              <span className="ml-auto h-3.5 w-1.5" style={{ background: th.cursor }} />
            </div>
            <div className="flex items-center justify-between gap-1 border-t border-glass bg-glass px-2.5 py-1.5">
              <span className="truncate text-[12px] font-medium text-text-1">{t.label}</span>
              {active && <Icon name="Check" size={13} className="shrink-0 text-text-1" />}
            </div>
          </button>
        )
      })}
    </div>
  )
}

// ── Canvas background ─────────────────────────────────────────────────────────

/**
 * Preview strings for the four background kinds, derived from the ACTIVE theme
 * (never hardcoded blues): the theme's swatch bg tinted toward the theme accent,
 * or the user's chosen color for the Solid kind while it is selected.
 */
/** Each tile previews the background the user would ACTUALLY get by picking it — their own two
 *  colors and angle, not a theme-derived stand-in. Only 'theme' shows the theme's own substrate. */
function bgPreviews(theme: ThemeDef, value: CanvasBackground): { id: CanvasBackgroundKind; label: string; preview: string }[] {
  const [start, end] = value.colors
  return [
    { id: 'theme', label: 'Theme', preview: theme.swatch.bg },
    { id: 'solid', label: 'Solid', preview: canvasBackgroundCss({ ...value, kind: 'solid' }) },
    { id: 'linear', label: 'Linear', preview: canvasBackgroundCss({ ...value, kind: 'linear', colors: [start, end] }) },
    { id: 'radial', label: 'Radial', preview: canvasBackgroundCss({ ...value, kind: 'radial', colors: [start, end] }) },
  ]
}

/** A color field (Start/End of a gradient) — opens the same PLANO picker the custom accent uses. */
function ColorField({
  label,
  hex,
  active,
  onClick,
  expanded,
}: {
  label: string
  hex: string
  active: boolean
  onClick: () => void
  /** True while THIS field's picker is open — marks it as the dismiss-safe trigger. */
  expanded?: boolean
}) {
  return (
    <button
      type="button"
      data-picker-trigger
      onClick={onClick}
      aria-pressed={active}
      aria-expanded={expanded}
      title={label}
      className={cn('group flex items-center gap-2.5 rounded-pill py-1 pr-2 pl-1 transition-colors hover:bg-glass focus-caliper', active && 'bg-glass')}
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-pill" style={{ background: 'var(--glass)' }}>
        <span
          className="h-[22px] w-[22px] rounded-pill transition-transform group-hover:scale-110"
          style={{ background: hex, boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.18)' }}
        />
      </span>
      <span className="flex min-w-0 flex-col text-left">
        <span className="truncate text-[12px] leading-none text-text-2">{label}</span>
        <span className="mt-1.5 font-mono text-[10px] uppercase leading-none tracking-[0.08em] text-text-4">{hex.toUpperCase()}</span>
      </span>
    </button>
  )
}

/** Background kind + color/angle controls. Tiles derive from the active theme. */
export function BackgroundPicker({
  value,
  onChange,
  theme,
}: {
  value: CanvasBackground
  onChange: (bg: CanvasBackground) => void
  theme: ThemeId
}) {
  const set = (patch: Partial<CanvasBackground>): void => onChange({ ...value, ...patch })
  const kinds = bgPreviews(getTheme(theme), value)
  const [openField, setOpenField] = useState<'start' | 'end' | null>(null)
  const pickerRef = useRef<HTMLDivElement>(null)
  const closeField = useCallback(() => setOpenField(null), [])
  useDismiss(pickerRef, closeField, openField !== null)
  const fieldHex = openField === 'end' ? value.colors[1] : value.colors[0]
  const setFieldHex = (hex: string): void => {
    if (openField === 'end') set({ colors: [value.colors[0], hex] })
    else set({ colors: [hex, value.colors[1]] })
  }
  return (
    <div>
      <div className="grid grid-cols-4 gap-3">
        {kinds.map((k) => {
          const active = value.kind === k.id
          return (
            <button
              key={k.id}
              type="button"
              onClick={() => onChange({ ...value, kind: k.id })}
              aria-label={k.label}
              aria-pressed={active}
              title={k.label}
              className="group flex flex-col items-stretch gap-1.5 focus-caliper"
            >
              <span
                className="relative flex h-[52px] w-full items-end overflow-hidden rounded-[13px]"
                style={{
                  background: k.preview,
                  // The ring is an INSET SHADOW, never a `border`. A 1px border draws over a
                  // background that (background-clip: border-box) also paints underneath it, so a
                  // gradient tile showed a hard mismatched edge — the odd outline on Linear. An
                  // inset ring sits inside the same box, so every tile rings identically and
                  // switching active/inactive no longer nudges the gradient by a pixel.
                  boxShadow: active
                    ? 'inset 0 0 0 1.5px color-mix(in srgb, var(--accent-primary) 80%, transparent)'
                    : 'inset 0 0 0 1px rgba(127,127,127,0.24)',
                  transition: 'box-shadow 160ms var(--ease-settle), background 200ms ease',
                }}
              >
                {active && (
                  /* Neutral white/black badge — it must stay legible on ANY substrate the user
                     picks, so it never inherits the accent (the ring already carries that). */
                  <span className="absolute right-1.5 top-1.5 flex h-4 w-4 items-center justify-center rounded-pill bg-white/85 text-black">
                    <Icon name="Check" size={9} strokeWidth={3} />
                  </span>
                )}
              </span>
              <span className={cn('truncate text-center text-[11.5px]', active ? 'text-text-1' : 'text-text-2')}>
                {k.label}
              </span>
            </button>
          )
        })}
      </div>

      {value.kind !== 'theme' && (
        <div className="mt-3 space-y-3">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
            <ColorField
              label={value.kind === 'solid' ? 'Color' : 'Start'}
              hex={value.colors[0]}
              active={openField === 'start' || (value.kind === 'solid' && openField !== null)}
              onClick={() => setOpenField(openField === 'start' ? null : 'start')}
              expanded={openField === 'start' || (value.kind === 'solid' && openField !== null)}
            />
            {value.kind !== 'solid' && (
              <ColorField
                label="End"
                hex={value.colors[1]}
                active={openField === 'end'}
                onClick={() => setOpenField(openField === 'end' ? null : 'end')}
                expanded={openField === 'end'}
              />
            )}
            {value.kind !== 'solid' && (
              <button
                type="button"
                onClick={() => set({ colors: [value.colors[1], value.colors[0]] })}
                aria-label="Swap start and end colors"
                title="Swap colors"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-pill text-text-3 transition-colors hover:bg-glass hover:text-text-1 focus-caliper"
              >
                <Icon name="ArrowLeftRight" size={14} />
              </button>
            )}
            {value.kind === 'linear' && (
              <label className="ml-auto flex shrink-0 items-center gap-2 text-[12px] text-text-secondary">
                Angle
                <Slider
                  value={value.angle}
                  min={0}
                  max={360}
                  step={5}
                  onChange={(angle) => set({ angle })}
                  format={(v) => `${Math.round(v)}°`}
                  width={120}
                />
              </label>
            )}
          </div>

          {/* the PLANO color picker, inline — same component the custom accent uses */}
          {openField && (
            <div
              ref={pickerRef}
              className="animate-menu-in rounded-[14px] border border-glass bg-surface-2 p-3"
              style={{ boxShadow: '0 12px 32px -12px rgba(0,0,0,0.55)' }}
            >
              <div className="label-caps mb-2.5">{openField === 'end' ? 'End color' : value.kind === 'solid' ? 'Color' : 'Start color'}</div>
              <CustomColorPicker key={openField} value={fieldHex} onChange={setFieldHex} onDone={closeField} />
            </div>
          )}

          <CanvasPreview background={value} />
        </div>
      )}
    </div>
  )
}

/** Minor grid spacing per gridSize preset (mirrors GridBackground). */
const PREVIEW_GRID_MINOR: Record<'fine' | 'standard' | 'coarse', number> = { fine: 16, standard: 24, coarse: 36 }

/**
 * A miniature of the real canvas rather than a flat color strip: the chosen substrate, the
 * ambient accent glow, the drafting grid at its actual style/size/strength, and two panel
 * silhouettes for scale. Every layer is the same CSS the canvas itself paints, so what the user
 * sees here is what they get — the flat strip could only show the substrate, which is the one
 * part that was already visible in the four tiles above.
 */
function CanvasPreview({ background }: { background: CanvasBackground }) {
  const accent = useSettingsStore((s) => s.settings.appearance.accent)
  const glow = useSettingsStore((s) => s.settings.appearance.canvasGlow)
  const gridStyle = useSettingsStore((s) => s.settings.appearance.gridStyle)
  const gridOpacity = useSettingsStore((s) => s.settings.appearance.gridOpacity)
  const gridSize = useSettingsStore((s) => s.settings.appearance.gridSize)

  const minor = PREVIEW_GRID_MINOR[gridSize] ?? PREVIEW_GRID_MINOR.standard
  const gridLayer: CSSProperties | null =
    gridStyle === 'none'
      ? null
      : gridStyle === 'lines'
        ? {
            backgroundImage: [
              'linear-gradient(var(--border-grid-minor) 1px, transparent 1px)',
              'linear-gradient(90deg, var(--border-grid-minor) 1px, transparent 1px)',
            ].join(','),
            backgroundSize: `${minor}px ${minor}px, ${minor}px ${minor}px`,
            opacity: gridOpacity,
          }
        : {
            backgroundImage: 'radial-gradient(var(--grid-dot) 1.3px, transparent 1.3px)',
            backgroundSize: `${minor}px ${minor}px`,
            opacity: gridOpacity,
          }

  return (
    <div
      aria-hidden
      className="relative h-[108px] overflow-hidden rounded-[14px]"
      style={{
        background: canvasBackgroundCss(background),
        boxShadow: 'inset 0 0 0 1px rgba(127,127,127,0.26)',
        transition: 'background 200ms ease',
      }}
    >
      <div className="absolute inset-0" style={{ background: canvasGlowCss(accent, glow) }} />
      {gridLayer && <div className="absolute inset-0" style={gridLayer} />}
      {/* two panel silhouettes, drawn from the same layer tokens the real panels use */}
      <div
        className="absolute left-4 top-5 h-[62px] w-[104px] rounded-[9px]"
        style={{
          background: 'var(--layer-panel-bg)',
          boxShadow: 'inset 0 0 0 1px var(--layer-edge), 0 6px 14px -6px rgba(0,0,0,0.55)',
        }}
      >
        <div className="h-[13px] w-full rounded-t-[9px]" style={{ background: 'var(--layer-panel-header-bg)' }} />
      </div>
      <div
        className="absolute left-[134px] top-9 h-[54px] w-[132px] rounded-[9px]"
        style={{
          background: 'var(--layer-panel-bg)',
          boxShadow: 'inset 0 0 0 1px var(--layer-edge), 0 6px 14px -6px rgba(0,0,0,0.55)',
        }}
      >
        <div className="h-[13px] w-full rounded-t-[9px]" style={{ background: 'var(--layer-panel-header-bg)' }} />
      </div>
    </div>
  )
}
