import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { cn } from '@/lib/cn'

type Variant = 'primary' | 'secondary' | 'ghost'
type SizeOpt = 'sm' | 'md'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: SizeOpt
}

const base =
  'app-no-drag inline-flex items-center justify-center gap-2 rounded-sm font-medium ' +
  'whitespace-nowrap select-none transition-[background,transform,border-color,opacity] ' +
  'duration-150 ease-settle focus-caliper active:scale-[0.98] disabled:opacity-40 ' +
  'disabled:pointer-events-none'

const variants: Record<Variant, string> = {
  primary: 'bg-accent text-text-onsolid hover:bg-accent-hover hover:-translate-y-px',
  secondary: 'border border-default text-text-primary hover:bg-accent-soft hover:border-strong',
  ghost: 'text-text-secondary hover:bg-accent-soft hover:text-text-primary',
}

const sizes: Record<SizeOpt, string> = {
  sm: 'h-8 px-3 text-[13px]',
  md: 'h-9 px-4 text-[13px]',
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', className, ...rest },
  ref,
) {
  return <button ref={ref} className={cn(base, variants[variant], sizes[size], className)} {...rest} />
})
