import { boundingBox } from '@shared/domain/geometry'
import type { Panel, PanelType } from '@shared/domain/panel'

interface SpacePreviewProps {
  panels: Panel[]
  width: number
  height: number
  className?: string
  /** Corner radius of the panel rects. */
  radius?: number
  /**
   * The workspace's own colour. When set, the schematic is drawn in that hue instead of grey —
   * the preview IS the workspace's identity (its layout signature), so tinting it is what makes
   * two rows tell each other apart, without adding a badge or a coloured line beside them.
   */
  color?: string
  /** The workspace has work in flight: the schematic glows a little brighter. */
  active?: boolean
}

const PAD = 3

/**
 * A scaled-down schematic of a space: every panel drawn as a rounded rect, laid out
 * exactly like the real canvas (shared boundingBox math with the Minimap). Stays
 * strictly monochrome per the design system — panels differ only by gray weight,
 * never by hue. Cheap enough to render for inactive spaces with no capture needed.
 */
export function SpacePreview({ panels, width, height, className, radius = 1.5, color, active = false }: SpacePreviewProps) {
  // Docked panels have a stale rect (their group holds the real one) — show the group, not them.
  const visible = panels.filter((p) => !p.dockedIn)
  const box = boundingBox(visible.map((p) => p.rect))
  const innerW = width - PAD * 2
  const innerH = height - PAD * 2
  const scale = box ? Math.min(innerW / Math.max(1, box.width), innerH / Math.max(1, box.height)) : 1
  const ox = box ? PAD + (innerW - box.width * scale) / 2 : 0
  const oy = box ? PAD + (innerH - box.height * scale) / 2 : 0

  return (
    <svg width={width} height={height} className={className} style={{ display: 'block' }}>
      {box && visible.length > 0 ? (
        visible.map((p) => (
          <rect
            key={p.id}
            x={ox + (p.rect.x - box.x) * scale}
            y={oy + (p.rect.y - box.y) * scale}
            width={Math.max(1.5, p.rect.width * scale)}
            height={Math.max(1.5, p.rect.height * scale)}
            rx={radius}
            fill={tint(p.type, color, active)}
          />
        ))
      ) : (
        <circle cx={width / 2} cy={height / 2} r={1.6} fill="rgba(255,255,255,0.16)" />
      )}
    </svg>
  )
}

/**
 * Weight by panel kind — live surfaces brighter, annotations dimmer. The weights are the same
 * whether the preview is grey or tinted, so a workspace's schematic keeps its own reading; the
 * colour only changes WHICH hue those weights are expressed in.
 */
function tint(type: PanelType, color: string | undefined, active: boolean): string {
  const weight = ((): number => {
    switch (type) {
      case 'terminal':
      case 'agent':
        return 0.62
      case 'editor':
      case 'browser':
      case 'markdown':
      case 'files':
      case 'git':
      case 'voice':
      case 'todo':
      case 'pomodoro':
        return 0.4
      default:
        return 0.2
    }
  })()
  const alpha = active ? Math.min(1, weight + 0.28) : weight
  if (!color) return `rgba(255,255,255,${alpha})`
  // A HINT of the workspace's hue, not the hue itself: the schematic stays a light-grey
  // diagram that happens to lean warm or cool. Apple tints materials, it does not paint them —
  // a fully coloured mini-map turned the menu into a swatch board.
  return `color-mix(in srgb, ${color} 26%, rgba(255,255,255,${alpha}))`
}
