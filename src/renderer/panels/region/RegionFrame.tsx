import { useRef, useState } from 'react'
import type { Panel, RegionProps } from '@shared/domain/panel'
import { snap, type Rect } from '@shared/domain/geometry'
import { usePanelStore } from '@/stores/usePanelStore'
import { useUiStore } from '@/stores/useUiStore'
import { Icon } from '@/design-system/Icon'
import { IconButton } from '@/design-system/IconButton'
import { cn } from '@/lib/cn'

const GRID = 8
const MIN_W = 240
const MIN_H = 180

type ResizeDir = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

/** Panels whose center sits inside the region — the set that travels with it. */
function membersOf(panels: Record<string, Panel>, region: Panel): Panel[] {
  const r = region.rect
  const out: Panel[] = []
  for (const p of Object.values(panels)) {
    if (p.id === region.id) continue
    const cx = p.rect.x + p.rect.width / 2
    const cy = p.rect.y + p.rect.height / 2
    if (cx >= r.x && cx <= r.x + r.width && cy >= r.y && cy <= r.y + r.height) out.push(p)
  }
  return out
}

/**
 * A region is *ground*, not a floating window: a resizable, named zone that lives behind
 * the panels and carries everything inside it when moved. It deliberately wears a different
 * skin from PanelFrame — a dashed rounded plate with a single grab-tab — and leaves its
 * interior click-through so the canvas still pans and panels stay interactive on top.
 */
export function RegionFrame({ panel, zoom, zIndex }: { panel: Panel; zoom: number; zIndex: number }) {
  const props = panel.props as RegionProps
  const moveMany = usePanelStore((s) => s.moveMany)
  const resize = usePanelStore((s) => s.resizePanel)
  const remove = usePanelStore((s) => s.removePanel)
  const updateProps = usePanelStore((s) => s.updateProps)
  const setTitle = usePanelStore((s) => s.setTitle)
  const snapping = useUiStore((s) => s.snapping)
  const memberCount = usePanelStore((s) => membersOf(s.panels, panel).length)

  const [editing, setEditing] = useState(false)
  const gesture = useRef<{
    kind: 'move' | ResizeDir
    sx: number
    sy: number
    start: Rect
    members: { id: string; x: number; y: number }[]
  } | null>(null)

  const maybeSnap = (v: number): number => (snapping ? snap(v, GRID) : Math.round(v))

  const beginMove = (e: React.PointerEvent): void => {
    if ((e.target as HTMLElement).closest('.app-no-drag, input, button')) return
    e.preventDefault()
    const panels = usePanelStore.getState().panels
    const members = membersOf(panels, panel).map((p) => ({ id: p.id, x: p.rect.x, y: p.rect.y }))
    gesture.current = { kind: 'move', sx: e.clientX, sy: e.clientY, start: { ...panel.rect }, members }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }

  const beginResize = (dir: ResizeDir) => (e: React.PointerEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    gesture.current = { kind: dir, sx: e.clientX, sy: e.clientY, start: { ...panel.rect }, members: [] }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e: React.PointerEvent): void => {
    const g = gesture.current
    if (!g) return
    const dx = (e.clientX - g.sx) / zoom
    const dy = (e.clientY - g.sy) / zoom

    if (g.kind === 'move') {
      const nx = maybeSnap(g.start.x + dx)
      const ny = maybeSnap(g.start.y + dy)
      const ddx = nx - g.start.x
      const ddy = ny - g.start.y
      moveMany([
        { id: panel.id, x: nx, y: ny },
        ...g.members.map((m) => ({ id: m.id, x: m.x + ddx, y: m.y + ddy })),
      ])
      return
    }

    let { x, y, width, height } = g.start
    const dir = g.kind
    if (dir.includes('e')) width = Math.max(MIN_W, g.start.width + dx)
    if (dir.includes('s')) height = Math.max(MIN_H, g.start.height + dy)
    if (dir.includes('w')) {
      width = Math.max(MIN_W, g.start.width - dx)
      x = g.start.x + (g.start.width - width)
    }
    if (dir.includes('n')) {
      height = Math.max(MIN_H, g.start.height - dy)
      y = g.start.y + (g.start.height - height)
    }
    resize(panel.id, {
      x: maybeSnap(x),
      y: maybeSnap(y),
      width: maybeSnap(width),
      height: maybeSnap(height),
    })
  }

  const endGesture = (): void => {
    gesture.current = null
  }

  const commitName = (value: string): void => {
    const next = value.trim() || props.label || 'Region'
    updateProps<'region'>(panel.id, { label: next })
    setTitle(panel.id, next)
    setEditing(false)
  }

  return (
    // Wrapper is click-through; only the tab and resize handles capture pointer events,
    // so the large interior never blocks canvas panning or the panels stacked above it.
    <div
      className="group/region absolute"
      style={{
        left: panel.rect.x,
        top: panel.rect.y,
        width: panel.rect.width,
        height: panel.rect.height,
        zIndex,
        pointerEvents: 'none',
      }}
      onPointerMove={onPointerMove}
      onPointerUp={endGesture}
      onPointerCancel={endGesture}
    >
      {/* the zone plate — purely visual */}
      <div
        className="absolute inset-0 rounded-2xl border-[1.5px] border-dashed"
        style={{ borderColor: 'var(--border-default)', background: 'rgba(255,255,255,0.018)' }}
      />

      {/* grab-tab: drag to move the region + everything inside, double-click to rename */}
      <div
        className={cn(
          'absolute -top-[34px] left-0 flex h-7 max-w-[80%] cursor-move items-center gap-1.5 rounded-md',
          'border border-subtle bg-surface-2 pl-2 pr-1 shadow-popover',
        )}
        style={{ pointerEvents: 'auto' }}
        onPointerDown={beginMove}
        onDoubleClick={() => setEditing(true)}
      >
        <span className="datum-grip shrink-0 group-hover/region:[&>span]:bg-[var(--text-secondary)]">
          {Array.from({ length: 6 }).map((_, i) => (
            <span key={i} />
          ))}
        </span>
        <Icon name="Frame" size={13} className="shrink-0 text-text-secondary" />

        {editing ? (
          <input
            autoFocus
            defaultValue={props.label}
            onBlur={(e) => commitName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              if (e.key === 'Escape') setEditing(false)
            }}
            className="app-no-drag min-w-0 flex-1 bg-transparent font-display text-[12px] font-semibold text-text-primary focus:outline-none"
          />
        ) : (
          <span className="min-w-0 flex-1 truncate font-display text-[12px] font-semibold text-text-primary">
            {props.label}
          </span>
        )}

        <span className="label-caps shrink-0 px-1 text-text-quaternary">{memberCount}</span>

        <div className="app-no-drag shrink-0 opacity-0 transition-opacity group-hover/region:opacity-100">
          <IconButton icon="Trash2" label="Remove region" size={22} danger onClick={() => remove(panel.id)} />
        </div>
      </div>

      <ResizeHandles onBegin={beginResize} />
    </div>
  )
}

function ResizeHandles({ onBegin }: { onBegin: (dir: ResizeDir) => (e: React.PointerEvent) => void }) {
  const edge = 'absolute z-20'
  const pe = { pointerEvents: 'auto' as const }
  return (
    <>
      <div className={cn(edge, 'inset-x-4 top-0 h-1.5 cursor-ns-resize')} style={pe} onPointerDown={onBegin('n')} />
      <div className={cn(edge, 'inset-x-4 bottom-0 h-1.5 cursor-ns-resize')} style={pe} onPointerDown={onBegin('s')} />
      <div className={cn(edge, 'inset-y-4 left-0 w-1.5 cursor-ew-resize')} style={pe} onPointerDown={onBegin('w')} />
      <div className={cn(edge, 'inset-y-4 right-0 w-1.5 cursor-ew-resize')} style={pe} onPointerDown={onBegin('e')} />
      <div className={cn(edge, 'left-0 top-0 h-4 w-4 cursor-nwse-resize')} style={pe} onPointerDown={onBegin('nw')} />
      <div className={cn(edge, 'right-0 top-0 h-4 w-4 cursor-nesw-resize')} style={pe} onPointerDown={onBegin('ne')} />
      <div className={cn(edge, 'bottom-0 left-0 h-4 w-4 cursor-nesw-resize')} style={pe} onPointerDown={onBegin('sw')} />
      <div className={cn(edge, 'bottom-0 right-0 h-4 w-4 cursor-nwse-resize')} style={pe} onPointerDown={onBegin('se')} />
    </>
  )
}
