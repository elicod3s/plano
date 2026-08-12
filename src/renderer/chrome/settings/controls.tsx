/**
 * Settings controls — the shared vocabulary of the Settings modal, in the Monolith voice:
 * a row title in Space Grotesk, a mono "blueprint" description, and a control pinned right.
 * Everything styles only via design tokens (no hardcoded hex), so themes re-tint it for free.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Icon } from '@/design-system/Icon'
import { cn } from '@/lib/cn'

/** Section header with PLANO's blueprint datum rule (accent tick + measured hairline). */
export function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <div className="mb-4">
      <h2 className="text-[17px] font-semibold tracking-tightui text-text-1">{children}</h2>
      <div className="mt-2.5 flex items-center gap-1.5">
        <span className="h-[2px] w-7 rounded-pill bg-accent" />
        <span className="h-px flex-1 bg-[var(--border-glass)]" />
      </div>
    </div>
  )
}

/**
 * A group divider inside a section: a mono label on a hairline. It replaces the habit of
 * explaining a cluster of rows in each row's description — the group says what they are once.
 */
export function GroupLabel({ children }: { children: ReactNode }) {
  // Same `label-caps` vocabulary the other sections already use for their groups
  // ("Canvas & Workspace", "Account", "Mobile & Remote") — one house style, not a second one.
  return <div className="label-caps mb-2 mt-6 px-1">{children}</div>
}

/** One setting: title + short description on the left, a control on the right. Compact. */
export function SettingRow({
  title,
  description,
  children,
  control,
}: {
  title: string
  description?: ReactNode
  /** Render the control inline at the right (default). */
  children?: ReactNode
  /** Alias for `children`; either works. */
  control?: ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-5 border-b border-glass py-3 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="text-[13.5px] text-text-1">{title}</div>
        {description && (
          <div className="mt-0.5 text-[12px] leading-snug text-text-3">{description}</div>
        )}
      </div>
      <div className="flex shrink-0 items-center">{control ?? children}</div>
    </div>
  )
}

/** A full-width block setting (control sits below the description, e.g. galleries). */
export function SettingBlock({
  title,
  description,
  children,
}: {
  title: string
  description?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="border-b border-glass py-3 last:border-b-0">
      <div className="text-[13.5px] text-text-1">{title}</div>
      {description && (
        <div className="mt-0.5 text-[12px] leading-snug text-text-3">{description}</div>
      )}
      <div className="mt-2.5">{children}</div>
    </div>
  )
}

export interface Opt<T extends string> {
  value: T
  label: string
}

/** Pill segmented control. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: Opt<T>[]
  onChange: (v: T) => void
}) {
  return (
    <div className="inline-flex items-center gap-0.5 rounded-pill border border-glass bg-inset p-0.5">
      {options.map((o) => {
        const active = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            className={cn(
              'app-no-drag h-7 rounded-pill px-2.5 font-mono text-[11px] transition-colors focus-caliper',
              active
                ? 'bg-accent text-text-onsolid'
                : 'text-text-2 hover:text-text-1',
            )}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

/** Range slider with a mono value readout. */
export function Slider({
  value,
  min,
  max,
  step = 1,
  onChange,
  format,
  width = 180,
}: {
  value: number
  min: number
  max: number
  step?: number
  onChange: (v: number) => void
  format?: (v: number) => string
  width?: number
}) {
  return (
    <div className="flex items-center gap-3">
      <input
        type="range"
        className="plano-range app-no-drag"
        style={{ width }}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="w-12 text-right font-mono text-[12px] tabular-nums text-text-secondary">
        {format ? format(value) : value}
      </span>
    </div>
  )
}

/** Custom dropdown (native select is hard to theme consistently across platforms). */
export function Select<T extends string>({
  value,
  options,
  onChange,
  width = 160,
}: {
  value: T
  options: Opt<T>[]
  onChange: (v: T) => void
  width?: number
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const current = options.find((o) => o.value === value)

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('pointerdown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={ref} className="relative" style={{ width }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="app-no-drag flex h-8 w-full items-center justify-between gap-2 rounded-[12px] border border-glass bg-inset px-2.5 text-text-1 transition-colors hover:border-glass-hover focus-caliper"
      >
        <span className="truncate font-mono text-[12px]">{current?.label ?? value}</span>
        <Icon name="ChevronDown" size={14} className="shrink-0 text-text-3" />
      </button>
      {open && (
        <div data-surface-layer="popover" className="animate-menu-in surface-layer surface-layer--popover absolute right-0 top-[calc(100%+4px)] z-50 max-h-60 w-full overflow-y-auto rounded-[14px] p-1">
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => {
                onChange(o.value)
                setOpen(false)
              }}
              className={cn(
                'flex h-8 w-full items-center justify-between gap-2 rounded-sm px-2 text-left text-[12.5px] transition-colors',
                o.value === value
                  ? 'bg-accent-soft text-text-primary'
                  : 'text-text-secondary hover:bg-accent-soft hover:text-text-primary',
              )}
            >
              <span className="truncate">{o.label}</span>
              {o.value === value && <Icon name="Check" size={13} className="shrink-0" />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** Mono text input, echoing the browser address bar / readouts. */
export function TextField({
  value,
  onChange,
  placeholder,
  width = 200,
  type = 'text',
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  width?: number
  type?: string
}) {
  return (
    <input
      type={type}
      value={value}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(e) => onChange(e.target.value)}
      style={{ width }}
      className="app-no-drag h-8 rounded-[12px] border border-glass bg-inset px-2.5 font-mono text-[12px] text-text-1 placeholder:text-text-4 focus-caliper"
    />
  )
}

/** Numeric stepper input. `0`/empty allowed so callers can model "use default = 0". */
export function NumberField({
  value,
  onChange,
  min,
  max,
  step = 1,
  width = 84,
  suffix,
}: {
  value: number
  onChange: (v: number) => void
  min?: number
  max?: number
  step?: number
  width?: number
  suffix?: string
}) {
  const clamp = (n: number): number => {
    let v = n
    if (min !== undefined) v = Math.max(min, v)
    if (max !== undefined) v = Math.min(max, v)
    return v
  }
  return (
    <div
      className="app-no-drag flex h-8 items-center gap-1 rounded-[12px] border border-glass bg-inset pl-2.5 pr-1 focus-within:outline focus-within:outline-2 focus-within:outline-offset-2"
      style={{ width, outlineColor: 'var(--focus-ring)' }}
    >
      <input
        type="number"
        value={Number.isFinite(value) ? value : 0}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onChange(clamp(Number(e.target.value)))}
        className="w-full bg-transparent font-mono text-[12px] tabular-nums text-text-primary focus:outline-none"
      />
      {suffix && <span className="shrink-0 font-mono text-[11px] text-text-quaternary">{suffix}</span>}
    </div>
  )
}

/** Pillustration used by placeholder sections (e.g. Account before auth lands). */
export function PlaceholderCard({
  icon,
  title,
  body,
}: {
  icon: string
  title: string
  body: string
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-[16px] border border-dashed border-glass-strong bg-inset px-6 py-12 text-center">
      <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-pill border border-glass bg-glass text-text-2">
        <Icon name={icon} size={20} />
      </div>
      <div className="text-[14px] font-semibold text-text-1">{title}</div>
      <div className="mt-1.5 max-w-xs font-mono text-[11.5px] leading-relaxed text-text-3">
        {body}
      </div>
    </div>
  )
}
