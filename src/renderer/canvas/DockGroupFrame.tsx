import { memo, useRef, type CSSProperties } from 'react'
import type { Panel } from '@shared/domain/panel'
import type { GroupProps } from '@shared/domain/panel'
import { PANEL_META } from '@shared/domain/panel'
import { DOCK_GUTTER, layoutRects, setRatioAt, type DividerRect } from '@shared/domain/dock'
import type { Rect } from '@shared/domain/geometry'
import { usePanelStore } from '@/stores/usePanelStore'
import { useViewportStore } from '@/stores/useViewportStore'
import { undockPanel, closeDockedPanel } from '@/app/dockActions'
import { getPanelComponent } from '@/panels/_base/PanelRegistry'
import { Icon } from '@/design-system/Icon'
import { IconButton } from '@/design-system/IconButton'
import { cn } from '@/lib/cn'

const GUTTER = DOCK_GUTTER // px between panes (the draggable divider band)
const MIN_W = 240
const MIN_H = 160

type ResizeDir = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

/**
 * A dock group: one rounded window whose body is a split tree of member panels (image 12). Members
 * stay in usePanelStore (PTY/state preserved) and are rendered here instead of as floating frames.
 * Drag a pane header to move the whole group; the pop-out button undocks a pane to floating; the
 * dividers between panes resize the split. Group resize via the 8-way handles.
 */
function DockGroupFrameInner({ panel, zIndex }: { panel: Panel; zIndex?: number }) {
  const move = usePanelStore((s) => s.movePanel)
  const resize = usePanelStore((s) => s.resizePanel)
  const setGroupLayout = usePanelStore((s) => s.setGroupLayout)
  const bringToFront = usePanelStore((s) => s.bringToFront)
  const isFront = usePanelStore((s) => s.zCounter === panel.z)
  // Subscribe to the panel map so member title/type/props changes re-render (members are few).
  const panels = usePanelStore((s) => s.panels)

  const layout = (panel.props as GroupProps).layout
  const gesture = useRef<{
    kind: 'move' | ResizeDir | 'divider'
    sx: number
    sy: number
    start: Rect
    path?: string
    dir?: 'row' | 'col'
    area?: Rect
    startRatio?: number
  } | null>(null)

  const inner: Rect = { x: 0, y: 0, width: panel.rect.width, height: panel.rect.height }
  const { panes, dividers } = layoutRects(layout, inner, GUTTER)

  const beginMove = (e: React.PointerEvent): void => {
    if ((e.target as HTMLElement).closest('.app-no-drag, button')) return
    e.preventDefault()
    bringToFront(panel.id)
    gesture.current = { kind: 'move', sx: e.clientX, sy: e.clientY, start: { ...panel.rect } }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }

  const beginResize = (dir: ResizeDir) => (e: React.PointerEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    bringToFront(panel.id)
    gesture.current = { kind: dir, sx: e.clientX, sy: e.clientY, start: { ...panel.rect } }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }

  const beginDivider = (d: DividerRect) => (e: React.PointerEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    bringToFront(panel.id)
    gesture.current = {
      kind: 'divider',
      sx: e.clientX,
      sy: e.clientY,
      start: { ...panel.rect },
      path: d.path,
      dir: d.dir,
      area: d.area,
      startRatio: ratioAt(layout, d.path),
    }
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
      move(panel.id, Math.round(g.start.x + dx), Math.round(g.start.y + dy))
      return
    }
    if (g.kind === 'divider' && g.area && g.dir && g.path !== undefined && g.startRatio !== undefined) {
      const delta = g.dir === 'row' ? dx / g.area.width : dy / g.area.height
      setGroupLayout(panel.id, setRatioAt(layout, g.path, g.startRatio + delta))
      return
    }
    // resize
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
    resize(panel.id, { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) })
  }

  const endGesture = (): void => {
    gesture.current = null
  }

  const positionStyle: CSSProperties = {
    left: 0,
    top: 0,
    width: panel.rect.width,
    height: panel.rect.height,
    transform: `translate3d(${panel.rect.x}px, ${panel.rect.y}px, 0)`,
    zIndex: zIndex ?? panel.z,
  }

  return (
    <div
      className="absolute"
      style={positionStyle}
      onPointerDownCapture={() => bringToFront(panel.id)}
      onPointerMove={onPointerMove}
      onPointerUp={endGesture}
      onPointerCancel={endGesture}
    >
      <div
        className={cn(
          'absolute inset-0 overflow-hidden rounded-lg border bg-surface-1',
          isFront ? 'border-strong' : 'border-subtle',
        )}
        style={{ boxShadow: isFront ? 'var(--shadow-panel-focus)' : 'var(--shadow-panel)' }}
      >
        {panes.map((p) => {
          const member = panels[p.panelId]
          if (!member) return null
          const Body = getPanelComponent(member.type)
          const meta = PANEL_META[member.type]
          return (
            <div
              key={p.panelId}
              className="absolute flex flex-col overflow-hidden"
              style={{ left: p.rect.x, top: p.rect.y, width: p.rect.width, height: p.rect.height }}
            >
              {/* slim pane header: drag = move group; DOUBLE-CLICK = detach; ⇲ button = detach; x = close */}
              <div
                className="group/h flex h-[30px] shrink-0 cursor-grab items-center gap-2 border-b border-subtle bg-surface-2 px-2.5 active:cursor-grabbing"
                title="Drag to move · double-click to detach"
                onPointerDown={beginMove}
                onDoubleClick={() => undockPanel(p.panelId)}
              >
                <span className="datum-grip shrink-0 group-hover/h:[&>span]:bg-[var(--text-secondary)]">
                  {Array.from({ length: 6 }).map((_, k) => (
                    <span key={k} />
                  ))}
                </span>
                <Icon name={meta.icon} size={13} className="shrink-0 text-text-secondary" />
                <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-text-primary">
                  {member.title}
                </span>
                <div className="app-no-drag flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/h:opacity-100">
                  <IconButton
                    icon="PanelRightClose"
                    label="Detach panel (double-click the header)"
                    size={22}
                    onClick={() => undockPanel(p.panelId)}
                  />
                  <IconButton
                    icon="X"
                    label="Close panel"
                    size={22}
                    danger
                    onClick={() => closeDockedPanel(p.panelId)}
                  />
                </div>
              </div>
              {/* body — reuse the same component as the floating panel; it fills + resizes itself */}
              <div className="min-h-0 flex-1 select-text">
                <Body panel={member} />
              </div>
            </div>
          )
        })}

        {/* draggable dividers between panes */}
        {dividers.map((d) => (
          <div
            key={d.path || 'root'}
            className="app-no-drag absolute z-10"
            style={{
              left: d.rect.x,
              top: d.rect.y,
              width: d.rect.width,
              height: d.rect.height,
              cursor: d.dir === 'row' ? 'ew-resize' : 'ns-resize',
            }}
            onPointerDown={beginDivider(d)}
            onPointerMove={onPointerMove}
            onPointerUp={endGesture}
            onPointerCancel={endGesture}
          />
        ))}

        <ResizeHandles onBegin={beginResize} />
      </div>
    </div>
  )
}

export const DockGroupFrame = memo(DockGroupFrameInner)

/** Read the ratio of the split addressed by `path` (for an absolute-position-free divider drag). */
function ratioAt(node: import('@shared/domain/dock').DockNode, path: string): number {
  if (node.kind !== 'split') return 0.5
  if (path === '') return node.ratio
  return path[0] === 'a' ? ratioAt(node.a, path.slice(1)) : ratioAt(node.b, path.slice(1))
}

function ResizeHandles({ onBegin }: { onBegin: (dir: ResizeDir) => (e: React.PointerEvent) => void }) {
  const edge = 'app-no-drag absolute z-20'
  return (
    <>
      <div className={cn(edge, 'inset-x-2 top-0 h-1.5 cursor-ns-resize')} onPointerDown={onBegin('n')} />
      <div className={cn(edge, 'inset-x-2 bottom-0 h-1.5 cursor-ns-resize')} onPointerDown={onBegin('s')} />
      <div className={cn(edge, 'inset-y-2 left-0 w-1.5 cursor-ew-resize')} onPointerDown={onBegin('w')} />
      <div className={cn(edge, 'inset-y-2 right-0 w-1.5 cursor-ew-resize')} onPointerDown={onBegin('e')} />
      <div className={cn(edge, 'left-0 top-0 h-3 w-3 cursor-nwse-resize')} onPointerDown={onBegin('nw')} />
      <div className={cn(edge, 'right-0 top-0 h-3 w-3 cursor-nesw-resize')} onPointerDown={onBegin('ne')} />
      <div className={cn(edge, 'bottom-0 left-0 h-3 w-3 cursor-nesw-resize')} onPointerDown={onBegin('sw')} />
      <div className={cn(edge, 'bottom-0 right-0 h-3 w-3 cursor-nwse-resize')} onPointerDown={onBegin('se')} />
    </>
  )
}
