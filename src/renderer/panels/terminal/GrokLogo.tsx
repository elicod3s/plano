import type { IconType } from 'react-icons'

/**
 * The xAI mark used by Grok: one continuous stroke running top-right → bottom-left, crossed by a
 * second diagonal that is BROKEN into two segments with a gap where the first passes through.
 * That break is what distinguishes it from a plain "X" (and from the Twitter/X glyph), so it is
 * drawn as three polygons rather than two crossing strokes.
 *
 * Monochrome and tintable like the simple-icons brand marks: fills from `color`, defaulting to
 * `currentColor`, so the caller decides whether it reads as brand colour or as chrome.
 */
export const GrokLogo: IconType = ({ size = '1em', color, className, title }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill={color ?? 'currentColor'}
    className={className}
    role="img"
    aria-label={typeof title === 'string' ? title : 'Grok'}
    xmlns="http://www.w3.org/2000/svg"
  >
    {typeof title === 'string' ? <title>{title}</title> : null}
    {/* continuous diagonal: top-right to bottom-left */}
    <polygon points="18.6,1.8 22.4,1.8 5.4,22.2 1.6,22.2" />
    {/* upper-left segment of the crossed diagonal */}
    <polygon points="1.6,1.8 5.4,1.8 10.4,7.8 8.5,10.1" />
    {/* lower-right segment, resuming past the crossing */}
    <polygon points="15.5,13.9 22.4,22.2 18.6,22.2 13.6,16.2" />
  </svg>
)
