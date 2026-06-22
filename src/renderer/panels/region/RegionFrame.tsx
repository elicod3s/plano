import { memo, useEffect, useRef, useState } from 'react'
import type { Panel, RegionProps } from '@shared/domain/panel'
import { snap, type Rect } from '@shared/domain/geometry'
import { usePanelStore } from '@/stores/usePanelStore'
import { useUiStore } from '@/stores/useUiStore'
import { useViewportStore } from '@/stores/useViewportStore'
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
    // A locked (pinned) panel stays put even when its enclosing region is dragged.
    if (p.id === region.id || p.locked) continue
    const cx = p.rect.x + p.rect.width / 2
    const cy = p.rect.y + p.rect.height / 2
    if (cx >= r.x && cx <= r.x + r.width && cy >= r.y && cy <= r.y + r.height) out.push(p)
  }
  return out
}

/**
 * A region is *ground*, not a floating window: a resizable, named zone that lives behind
 * the panels and carries everything inside it when moved. It wears a deliberately different
 * skin from PanelFrame — a brighter dashed plate with a header tab — and stays grabbable
 * from its whole border, while its interior is click-through so the canvas still pans and
 * panels stay interactive on top.
 */
function RegionFrameInner({ panel, zIndex }: { panel: Panel; zIndex: number }) {
  const props = panel.props as RegionProps
  const moveMany = usePanelStore((s) => s.moveMany)
  const resize = usePanelStore((s) => s.resizePanel)
  const remove = usePanelStore((s) => s.removePanel)
  const updateProps = usePanelStore((s) => s.updateProps)
  const setTitle = usePanelStore((s) => s.setTitle)
  const snapping = useUiStore((s) => s.snapping)
  const memberCount = usePanelStore((s) => membersOf(s.panels, panel).length)

  const [editing, setEditing] = useState(false)
  // Regions leave with a plain fade+blur (they're ground, not a window — no collapse).
  const [closing, setClosing] = useState(false)
  const closeTimer = useRef<number | null>(null)
  const gesture = useRef<{
    kind: 'move' | ResizeDir
    sx: number
    sy: number
    start: Rect
    members: { id: string; x: number; y: number }[]
  } | null>(null)

  useEffect(() => () => {
    if (closeTimer.current) window.clearTimeout(closeTimer.current)
  }, [])

  const handleClose = (): void => {
    if (closing) return
    setClosing(true)
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    closeTimer.current = window.setTimeout(() => remove(panel.id), reduce ? 0 : 260)
  }

  const onAnimationEnd = (e: React.AnimationEvent): void => {
    if (closing && e.animationName === 'region-out') {
      if (closeTimer.current) window.clearTimeout(closeTimer.current)
      remove(panel.id)
    }
  }

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
    // Lazily read zoom during the drag instead of taking it as a render prop (see PanelFrame).
    const zoom = useViewportStore.getState().zoom
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
    // Wrapper is click-through; only the border rim, tab and resize handles capture pointer
    // events, so the large interior never blocks canvas panning or the panels stacked above.
    // Positioned via transform (not left/top) to composite cleanly while dragging. The close
    // animation (animate-region-out) only touches opacity/filter, so it leaves that transform be.
    <div
      className={cn('group/region absolute', closing && 'animate-region-out')}
      style={{
        left: 0,
        top: 0,
        width: panel.rect.width,
        height: panel.rect.height,
        transform: `translate3d(${panel.rect.x}px, ${panel.rect.y}px, 0)`,
        zIndex,
        pointerEvents: 'none',
      }}
      onPointerMove={onPointerMove}
      onPointerUp={endGesture}
      onPointerCancel={endGesture}
      onAnimationEnd={onAnimationEnd}
    >
      {/* the zone plate — purely visual, brightens on hover */}
      <div
        className={cn(
          'absolute inset-0 rounded-2xl border-2 border-dashed transition-colors duration-150',
          'border-[color:var(--region-border)] bg-[color:var(--region-fill)]',
          'group-hover/region:border-[color:var(--region-border-hover)] group-hover/region:bg-[color:var(--region-fill-hover)]',
        )}
      />

      {/* fat draggable border rim — grab anywhere on the frame to move the whole region */}
      <div className="absolute inset-x-3 top-0 h-4 cursor-move" style={PE} onPointerDown={beginMove} />
      <div className="absolute inset-x-3 bottom-0 h-4 cursor-move" style={PE} onPointerDown={beginMove} />
      <div className="absolute inset-y-3 left-0 w-4 cursor-move" style={PE} onPointerDown={beginMove} />
      <div className="absolute inset-y-3 right-0 w-4 cursor-move" style={PE} onPointerDown={beginMove} />

      {/* generous resize handles (8-way) layered above the move rim */}
      <ResizeHandles onBegin={beginResize} />

      {/* header tab: a zone *title* (deliberately larger than panel chrome so it stays
          readable when zoomed out to see the whole region) that also drags the region;
          double-click or ✎ to rename */}
      <div
        className={cn(
          'absolute -top-[52px] left-0 flex h-[44px] max-w-full cursor-move items-center gap-2.5 rounded-xl',
          'border border-[color:var(--region-border)] bg-surface-3 pl-3.5 pr-2 shadow-popover',
          'group-hover/region:border-[color:var(--region-border-hover)]',
        )}
        style={PE}
        onPointerDown={beginMove}
        onDoubleClick={() => setEditing(true)}
      >
        <span className="datum-grip shrink-0 [&>span]:bg-[var(--text-tertiary)] group-hover/region:[&>span]:bg-[var(--text-secondary)]">
          {Array.from({ length: 6 }).map((_, i) => (
            <span key={i} />
          ))}
        </span>
        <Icon name="Frame" size={20} className="shrink-0 text-text-secondary" />

        {editing ? (
          <input
            autoFocus
            defaultValue={props.label}
            onBlur={(e) => commitName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              if (e.key === 'Escape') setEditing(false)
            }}
            className="app-no-drag min-w-[120px] flex-1 bg-transparent font-display text-[24px] font-semibold leading-none tracking-tightui text-text-primary focus:outline-none"
          />
        ) : (
          <span className="min-w-0 flex-1 truncate font-display text-[24px] font-semibold leading-none tracking-tightui text-text-primary">
            {props.label}
          </span>
        )}

        <span className="label-caps shrink-0 rounded-pill bg-surface-1 px-2 py-1 text-[12px] text-text-tertiary">
          {memberCount}
        </span>

        <div className="app-no-drag flex shrink-0 items-center opacity-0 transition-opacity group-hover/region:opacity-100">
          <IconButton icon="Pencil" label="Rename region" size={28} onClick={() => setEditing(true)} />
          <IconButton icon="Trash2" label="Remove region" size={28} danger onClick={handleClose} />
        </div>
      </div>
    </div>
  )
}

// Memoized so a camera move (pan/zoom) no longer re-renders every region: with the zoom prop gone,
// `panel`/`zIndex` are reference-stable across pan/zoom, so memo bails. (A region still re-renders
// when its own panel changes or its member count changes — that's its membersOf subscription, not
// the camera.)
export const RegionFrame = memo(RegionFrameInner)

const PE = { pointerEvents: 'auto' as const }

function ResizeHandles({ onBegin }: { onBegin: (dir: ResizeDir) => (e: React.PointerEvent) => void }) {
  // Edges: full-length thin outer strips. Corners: large squares layered on top so the
  // corner always wins over the adjacent edge/rim. All comfortably grabbable.
  return (
    <>
      <div className="absolute inset-x-5 top-0 z-20 h-2 cursor-ns-resize" style={PE} onPointerDown={onBegin('n')} />
      <div className="absolute inset-x-5 bottom-0 z-20 h-2 cursor-ns-resize" style={PE} onPointerDown={onBegin('s')} />
      <div className="absolute inset-y-5 left-0 z-20 w-2 cursor-ew-resize" style={PE} onPointerDown={onBegin('w')} />
      <div className="absolute inset-y-5 right-0 z-20 w-2 cursor-ew-resize" style={PE} onPointerDown={onBegin('e')} />
      <div className="absolute left-0 top-0 z-30 h-6 w-6 cursor-nwse-resize" style={PE} onPointerDown={onBegin('nw')} />
      <div className="absolute right-0 top-0 z-30 h-6 w-6 cursor-nesw-resize" style={PE} onPointerDown={onBegin('ne')} />
      <div className="absolute bottom-0 left-0 z-30 h-6 w-6 cursor-nesw-resize" style={PE} onPointerDown={onBegin('sw')} />
      <div className="absolute bottom-0 right-0 z-30 h-6 w-6 cursor-nwse-resize" style={PE} onPointerDown={onBegin('se')} />
    </>
  )
}
