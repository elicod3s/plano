import type { IconType } from 'react-icons'

/**
 * Kiro's brand mark (its ghost glyph), drawn as a single tintable monochrome path so it sits
 * alongside the simple-icons brand logos used for the other agents (Claude/OpenAI/Gemini).
 * The eyes are cut out with `fill-rule: evenodd` so the whole mark tints uniformly via the
 * `color` prop (defaults to `currentColor`), exactly like an `IconType` from react-icons.
 */
export const KiroLogo: IconType = ({ size = '1em', color, className, title }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill={color ?? 'currentColor'}
    className={className}
    role="img"
    aria-label={typeof title === 'string' ? title : 'Kiro'}
    xmlns="http://www.w3.org/2000/svg"
  >
    {typeof title === 'string' ? <title>{title}</title> : null}
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M12 2C7.582 2 4 5.582 4 10v9.3c0 .79.93 1.2 1.51.66l1.36-1.25a1 1 0 0 1 1.36.02l1.09 1.02a1 1 0 0 0 1.36 0l1.09-1.02a1 1 0 0 1 1.36-.02l1.36 1.25c.58.54 1.51.13 1.51-.66V10c0-4.418-3.582-8-8-8Zm-2.4 7.1a1.35 1.35 0 1 0 0 2.7 1.35 1.35 0 0 0 0-2.7Zm4.8 0a1.35 1.35 0 1 0 0 2.7 1.35 1.35 0 0 0 0-2.7Z"
    />
  </svg>
)
