import { cn } from '@/lib/cn'

interface ToggleProps {
  checked: boolean
  onChange: (next: boolean) => void
  label?: string
  /** 'arm' turns the ON state red — used for Auto-approve (lowering a guardrail). */
  tone?: 'default' | 'arm'
  disabled?: boolean
}

/** Pill toggle. The thumb does a small settle on change; armed state crossfades to red. */
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
        'app-no-drag relative inline-flex h-6 w-11 shrink-0 items-center rounded-pill border',
        'transition-colors duration-150 ease-settle focus-caliper disabled:opacity-40',
        armed
          ? 'border-transparent bg-destructive'
          : checked
            ? 'border-transparent bg-accent-soft-strong'
            : 'border-default bg-surface-4',
      )}
    >
      <span
        className={cn(
          'pointer-events-none absolute h-[18px] w-[18px] rounded-pill bg-accent shadow-sm',
          'transition-transform duration-150 ease-settle',
          checked ? 'translate-x-[22px]' : 'translate-x-[3px]',
        )}
      />
    </button>
  )
}
