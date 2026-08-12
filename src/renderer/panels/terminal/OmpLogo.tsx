import type { IconType } from 'react-icons'

/**
 * The official Oh My Pi brand mark (assets/icon.svg in can1357/oh-my-pi, used across
 * omp.sh and the README): the π symbol — top bar + two legs — with an orange plugin
 * connector clipped onto the right leg ("a coding agent with the IDE wired in"), plus
 * two small connector dots on the bar. Brand colors are intrinsic (#fafafa white + the
 * #f97316 orange), matching how the simple-icons brand logos carry their own palette.
 */
export const OmpLogo: IconType = ({ size = '1em', className, title }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 120 90"
    className={className}
    role="img"
    aria-label={typeof title === 'string' ? title : 'Oh My Pi'}
    xmlns="http://www.w3.org/2000/svg"
  >
    {typeof title === 'string' ? <title>{title}</title> : null}
    {/* π symbol — horizontal bar + two legs */}
    <rect x="10" y="8" width="100" height="12" rx="2" fill="#fafafa" />
    <rect x="25" y="20" width="12" height="62" rx="2" fill="#fafafa" />
    <rect x="75" y="20" width="12" height="45" rx="2" fill="#fafafa" />
    {/* plugin connector on the right leg */}
    <rect x="71" y="55" width="20" height="16" rx="3" fill="#f97316" />
    <rect x="76" y="59" width="3" height="8" rx="1" fill="#0d0d0d" />
    <rect x="82" y="59" width="3" height="8" rx="1" fill="#0d0d0d" />
    {/* decorative dots on the bar */}
    <circle cx="18" cy="14" r="2" fill="#f97316" opacity="0.8" />
    <circle cx="102" cy="14" r="2" fill="#f97316" opacity="0.8" />
  </svg>
)
