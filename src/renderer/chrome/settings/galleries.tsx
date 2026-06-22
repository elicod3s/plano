/**
 * Visual pickers for Appearance + Terminal — deliberately NOT the generic "fake window card
 * + circle row + text segmented" pattern. PLANO's blueprint voice instead:
 *  - themes are paint-chips of the theme's REAL surface ramp,
 *  - the accent is a row of square chips marked with the caliper motif + a mono readout,
 *  - the grid picker draws the actual dot/line pattern it selects.
 * Each picker renders with literal colors so it shows what it would look like.
 */
import type { CSSProperties } from 'react'
import { THEMES, ACCENTS } from '@/theme/themes'
import { TERMINAL_THEMES } from '@/panels/terminal/terminalThemes'
import type { ThemeId, TerminalThemeId, GridStyle } from '@shared/domain/settings'
import { Icon } from '@/design-system/Icon'
import { cn } from '@/lib/cn'

const THEME_TAG: Partial<Record<ThemeId, string>> = {
  monolith: 'WARM',
  slate: 'COOL',
  carbon: 'BLACK',
  'dark-warm': 'WARM',
  indigo: 'COLOR',
  cyber: 'COLOR',
  light: 'LIGHT',
}

export function ThemeGallery({
  value,
  onChange,
}: {
  value: ThemeId
  onChange: (id: ThemeId) => void
}) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {THEMES.map((t) => {
        const active = t.id === value
        const canvas = t.ramp[0]
        const panelBg = t.ramp[2]
        const line = t.swatch.line
        const border = `color-mix(in srgb, ${line} 26%, transparent)`
        const grid = `color-mix(in srgb, ${line} 15%, transparent)`
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => onChange(t.id)}
            className={cn(
              'overflow-hidden rounded-lg border text-left transition-all focus-caliper',
              active ? 'border-strong ring-1 ring-[var(--focus-ring)]' : 'border-default hover:border-strong',
            )}
          >
            {/* A mini PLANO PANEL skeleton on the theme's real canvas — not a generic window:
                datum-grip dots + a status dot in the header, content hairlines below. */}
            <div className="relative h-[66px] w-full overflow-hidden" style={{ background: canvas }}>
              <div
                className="absolute inset-0"
                style={{
                  backgroundImage: `radial-gradient(${grid} 1px, transparent 1px)`,
                  backgroundSize: '7px 7px',
                }}
              />
              <div
                className="absolute bottom-2.5 left-3 top-2.5 w-[58%] overflow-hidden rounded-md border"
                style={{ background: panelBg, borderColor: border }}
              >
                <div className="flex h-3 items-center gap-[3px] border-b px-1.5" style={{ borderColor: border }}>
                  <span className="h-[3px] w-[3px] rounded-full" style={{ background: line }} />
                  <span className="h-[3px] w-[3px] rounded-full" style={{ background: line }} />
                  <span className="ml-auto h-1.5 w-1.5 rounded-full" style={{ background: t.swatch.dot }} />
                </div>
                <div className="space-y-1 p-1.5">
                  <span
                    className="block h-[3px] w-3/4 rounded-full"
                    style={{ background: `color-mix(in srgb, ${line} 55%, transparent)` }}
                  />
                  <span
                    className="block h-[3px] w-1/2 rounded-full"
                    style={{ background: `color-mix(in srgb, ${line} 32%, transparent)` }}
                  />
                </div>
              </div>
            </div>
            <div className="flex items-center justify-between gap-1 border-t border-subtle bg-surface-2 px-2.5 py-1.5">
              <span className="flex min-w-0 items-baseline gap-1.5">
                <span className="truncate text-[12px] font-medium text-text-primary">{t.label}</span>
                <span className="shrink-0 font-mono text-[8.5px] tracking-label text-text-quaternary">
                  {THEME_TAG[t.id] ?? (t.isLight ? 'LIGHT' : 'MONO')}
                </span>
              </span>
              {active && <Icon name="Check" size={13} className="shrink-0 text-text-primary" />}
            </div>
          </button>
        )
      })}
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
  const current = ACCENTS.find((a) => a.hex.toLowerCase() === sel)
  return (
    <div>
      <div className="flex flex-wrap items-center gap-1.5">
        {ACCENTS.map((a) => {
          const active = a.hex.toLowerCase() === sel
          return (
            <button
              key={a.id}
              type="button"
              title={a.label}
              onClick={() => onChange(a.hex)}
              className={cn(
                'relative h-7 w-7 rounded-[6px] transition-transform hover:scale-105 focus-caliper',
                active && 'outline outline-2 outline-offset-2',
              )}
              style={{ background: a.hex, outlineColor: active ? 'var(--focus-ring)' : undefined }}
            >
              {/* keep the white "mono" chip visible on dark surfaces */}
              {a.id === 'mono' && (
                <span className="pointer-events-none absolute inset-0 rounded-[6px] ring-1 ring-inset ring-black/25" />
              )}
            </button>
          )
        })}
      </div>
      {/* measured readout */}
      <div className="mt-2 font-mono text-[10px] tracking-label text-text-quaternary">
        ACCENT · {(current?.label ?? 'Custom').toUpperCase()} · {value.toUpperCase()}
      </div>
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
              'flex-1 overflow-hidden rounded-lg border transition-all focus-caliper',
              active ? 'border-strong ring-1 ring-[var(--focus-ring)]' : 'border-default hover:border-strong',
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
                'border-t border-subtle py-1 text-center text-[11px] font-medium transition-colors',
                active ? 'bg-accent-soft text-text-primary' : 'text-text-secondary',
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
              'overflow-hidden rounded-lg border text-left transition-all focus-caliper',
              active ? 'border-strong ring-1 ring-[var(--focus-ring)]' : 'border-default hover:border-strong',
            )}
          >
            {/* a real ANSI swatch strip over the terminal background */}
            <div className="flex h-[50px] items-end gap-1 px-2.5 pb-2" style={{ background: th.background }}>
              {[th.green, th.blue, th.yellow, th.magenta, th.cyan, th.red].map((c, j) => (
                <span key={j} className="h-2 w-2 rounded-[2px]" style={{ background: c }} />
              ))}
              <span className="ml-auto h-3.5 w-1.5" style={{ background: th.cursor }} />
            </div>
            <div className="flex items-center justify-between gap-1 border-t border-subtle bg-surface-2 px-2.5 py-1.5">
              <span className="truncate text-[12px] font-medium text-text-primary">{t.label}</span>
              {active && <Icon name="Check" size={13} className="shrink-0 text-text-primary" />}
            </div>
          </button>
        )
      })}
    </div>
  )
}
