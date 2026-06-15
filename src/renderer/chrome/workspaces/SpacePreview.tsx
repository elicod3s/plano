import { boundingBox } from '@shared/domain/geometry'
import type { Panel, PanelType } from '@shared/domain/panel'

interface SpacePreviewProps {
  panels: Panel[]
  width: number
  height: number
  className?: string
  /** Corner radius of the panel rects. */
  radius?: number
}

const PAD = 3

/**
 * A scaled-down schematic of a space: every panel drawn as a rounded rect, laid out
 * exactly like the real canvas (shared boundingBox math with the Minimap). Stays
 * strictly monochrome per the design system — panels differ only by gray weight,
 * never by hue. Cheap enough to render for inactive spaces with no capture needed.
 */
export function SpacePreview({ panels, width, height, className, radius = 1.5 }: SpacePreviewProps) {
  const box = boundingBox(panels.map((p) => p.rect))
  const innerW = width - PAD * 2
  const innerH = height - PAD * 2
  const scale = box ? Math.min(innerW / Math.max(1, box.width), innerH / Math.max(1, box.height)) : 1
  const ox = box ? PAD + (innerW - box.width * scale) / 2 : 0
  const oy = box ? PAD + (innerH - box.height * scale) / 2 : 0

  return (
    <svg width={width} height={height} className={className} style={{ display: 'block' }}>
      {box && panels.length > 0 ? (
        panels.map((p) => (
          <rect
            key={p.id}
            x={ox + (p.rect.x - box.x) * scale}
            y={oy + (p.rect.y - box.y) * scale}
            width={Math.max(1.5, p.rect.width * scale)}
            height={Math.max(1.5, p.rect.height * scale)}
            rx={radius}
            fill={tint(p.type)}
          />
        ))
      ) : (
        <circle cx={width / 2} cy={height / 2} r={1.6} fill="rgba(255,255,255,0.16)" />
      )}
    </svg>
  )
}

/** Monochrome weight by panel kind — live surfaces brighter, annotations dimmer. */
function tint(type: PanelType): string {
  switch (type) {
    case 'terminal':
    case 'agent':
      return 'rgba(255,255,255,0.62)'
    case 'editor':
    case 'browser':
    case 'markdown':
    case 'files':
    case 'git':
    case 'voice':
      return 'rgba(255,255,255,0.40)'
    default:
      return 'rgba(255,255,255,0.20)'
  }
}
