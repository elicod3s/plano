import { cn } from '@/lib/cn'

interface ToggleProps {
  checked: boolean
  onChange: (next: boolean) => void
  label?: string
  /** 'arm' turns the ON state red — used for Auto-approve (lowering a guardrail). */
  tone?: 'default' | 'arm'
  disabled?: boolean
}

/** Pill toggle (40×22) with a circular knob — glass track, white/ink knob. */
export function Toggle({ checked, onChange, label, tone = 'default', disabled }: ToggleProps) {
  const armed = tone === 'arm' && checked
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'app-no-drag relative inline-flex h-[22px] w-10 shrink-0 items-center rounded-pill border',
        'transition-colors duration-150 ease-settle focus-caliper disabled:opacity-40',
        armed
          ? 'border-transparent bg-destructive'
          : checked
            ? 'border-glass-hover bg-glass-active'
            : 'border-glass-strong bg-glass',
      )}
    >
      <span
        className={cn(
          'pointer-events-none absolute h-4 w-4 rounded-full shadow-sm',
          'transition-[transform,background] duration-150 ease-settle',
          armed ? 'bg-[#14090a]' : checked ? 'bg-accent' : 'bg-[color-mix(in_srgb,var(--text-primary)_65%,transparent)]',
          checked ? 'translate-x-[21px]' : 'translate-x-[3px]',
        )}
      />
    </button>
  )
}
