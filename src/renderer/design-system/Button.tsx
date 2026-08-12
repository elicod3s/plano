import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { cn } from '@/lib/cn'

type Variant = 'primary' | 'secondary' | 'ghost'
type SizeOpt = 'sm' | 'md'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: SizeOpt
}

const base =
  'app-no-drag inline-flex items-center justify-center gap-2 rounded-[12px] font-medium ' +
  'whitespace-nowrap select-none transition-[background,transform,border-color,opacity] ' +
  'duration-150 ease-settle focus-caliper active:scale-[0.98] disabled:opacity-40 ' +
  'disabled:pointer-events-none'

const variants: Record<Variant, string> = {
  primary: 'bg-accent text-text-onsolid hover:bg-accent-hover hover:-translate-y-px',
  secondary:
    'border border-glass-strong bg-glass-bar text-text-primary hover:bg-glass-hover hover:border-glass-hover',
  ghost: 'text-text-secondary hover:bg-glass-hover hover:text-text-primary',
}

const sizes: Record<SizeOpt, string> = {
  sm: 'h-8 px-3 text-[13px]',
  md: 'h-9 px-[18px] text-[13px]',
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', className, ...rest },
  ref,
) {
  return <button ref={ref} className={cn(base, variants[variant], sizes[size], className)} {...rest} />
})
