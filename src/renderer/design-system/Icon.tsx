import { memo } from 'react'
import * as Lucide from 'lucide-react'
import type { LucideProps } from 'lucide-react'

interface IconProps extends Omit<LucideProps, 'ref'> {
  /** lucide-react icon name, e.g. "SquareTerminal". Falls back to a neutral glyph. */
  name: string
}

/** Renders a lucide icon by name so domain data (PANEL_META, AGENTS) can stay strings. */
export const Icon = memo(function Icon({ name, size = 16, strokeWidth = 1.5, ...rest }: IconProps) {
  const Cmp = (Lucide as unknown as Record<string, Lucide.LucideIcon>)[name] ?? Lucide.Square
  return <Cmp size={size} strokeWidth={strokeWidth} {...rest} />
})
