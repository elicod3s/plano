import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { cn } from '@/lib/cn'
import { Icon } from './Icon'

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: string
  /** accessible label (also used as the tooltip title) */
  label: string
  size?: number
  active?: boolean
  danger?: boolean
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, label, size = 28, active = false, danger = false, className, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={label}
      style={{ width: size, height: size }}
      className={cn(
        'app-no-drag inline-flex items-center justify-center rounded-sm transition-[background,color,transform]',
        'duration-150 ease-settle active:scale-[0.96] focus-caliper',
        active ? 'bg-accent-soft-strong text-text-primary' : 'text-text-secondary hover:bg-accent-soft hover:text-text-primary',
        danger && 'hover:bg-destructive-soft hover:text-destructive-hover',
        className,
      )}
      {...rest}
    >
      <Icon name={icon} size={Math.round(size * 0.57)} />
    </button>
  )
})
