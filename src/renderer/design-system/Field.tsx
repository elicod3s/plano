import { forwardRef, type InputHTMLAttributes } from 'react'
import { cn } from '@/lib/cn'
import { Icon } from './Icon'

interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Optional leading icon name (lucide). */
  icon?: string
  /** Accessible label. */
  label?: string
}

/** Glass input field — inset-soft fill, rounded-[11px], hairline glass border, soft shadow. */
export const Field = forwardRef<HTMLInputElement, FieldProps>(function Field(
  { icon, label, className, ...rest },
  ref,
) {
  return (
    <div
      className={cn(
        'flex items-center gap-2.5 rounded-[11px] border border-glass bg-inset px-3.5',
        'shadow-[0_1px_6px_rgba(0,0,0,0.5)] transition-[border-color,background] duration-150',
        'focus-within:border-glass-hover focus-within:bg-glass-input-hover',
        className,
      )}
    >
      {icon && <Icon name={icon} size={14} className="shrink-0 text-text-3" />}
      <input
        ref={ref}
        aria-label={label}
        spellCheck={false}
        className="h-full min-w-0 flex-1 bg-transparent text-[13px] text-text-1 placeholder:text-text-3 focus:outline-none"
        {...rest}
      />
    </div>
  )
})
