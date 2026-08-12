import type { IconType } from 'react-icons'

/**
 * The official Pi coding agent brand mark (https://pi.dev/logo-auto.svg) — the P + i
 * glyph — drawn as tintable monochrome paths so it sits alongside the simple-icons brand
 * logos used for the other agents (Claude/OpenAI/Gemini). The P's inner hole is cut out
 * with `fill-rule: evenodd` so the whole mark tints uniformly via the `color` prop
 * (defaults to `currentColor`), exactly like an `IconType` from react-icons.
 */
export const PiLogo: IconType = ({ size = '1em', color, className, title }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill={color ?? 'currentColor'}
    className={className}
    role="img"
    aria-label={typeof title === 'string' ? title : 'Pi'}
    xmlns="http://www.w3.org/2000/svg"
  >
    {typeof title === 'string' ? <title>{title}</title> : null}
    {/* P shape: outer boundary clockwise, inner hole counter-clockwise */}
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M4.9587 4.9587 H15.5208 V12 H12 V15.5208 H8.4795 V19.0416 H4.9587 Z M8.4795 8.4795 V12 H12 V8.4795 Z"
    />
    {/* i dot */}
    <path d="M15.5208 12 H19.0416 V19.0416 H15.5208 Z" />
  </svg>
)
