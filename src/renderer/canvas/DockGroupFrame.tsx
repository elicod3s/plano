import { memo, useEffect, useRef, useState, type CSSProperties } from 'react'
import type { Panel } from '@shared/domain/panel'
import type { GroupProps } from '@shared/domain/panel'
import { PANEL_META } from '@shared/domain/panel'
import { DOCK_GUTTER, layoutRects, setRatioAt, type DividerRect } from '@shared/domain/dock'
import type { Rect } from '@shared/domain/geometry'
import { useShallow } from 'zustand/react/shallow'
import { usePanelStore } from '@/stores/usePanelStore'
import { useCanvasFocusStore } from '@/stores/useCanvasFocusStore'
import { FocusShield, UNFOCUSED_OPACITY } from '@/panels/_base/PanelFrame'

import { viewportController } from '@/canvas/ViewportController'
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
  const layout = (panel.props as GroupProps).layout
  const inner: Rect = { x: 0, y: 0, width: panel.rect.width, height: panel.rect.height }
  const { panes, dividers } = layoutRects(layout, inner, GUTTER)
  const memberIds = panes.map((p) => p.panelId)
  // Plan D4: subscribe ONLY to this group's member panels, not the whole panel registry — a
  // drag elsewhere on the canvas no longer re-renders every dock group. useShallow bails out
  // unless a member's reference actually changed.
  const members = usePanelStore(
    useShallow((s) => memberIds.map((id) => s.panels[id]).filter((p): p is Panel => Boolean(p))),
  )
  // The whole group dims/brightens as ONE outer surface. Narrow boolean
  // selector: surfaces whose focus state did not change bail out of re-rendering.
  const focused = useCanvasFocusStore((s) => s.focus?.surfaceId === panel.id)
  const [hovered, setHovered] = useState(false)

  const gesture = useRef<{
    kind: 'move' | ResizeDir | 'divider'
    sx: number
    sy: number
    start: Rect
    path?: string
    dir?: 'row' | 'col'
    area?: Rect
    startRatio?: number
    canvasRect?: DOMRect | null
  } | null>(null)
  // Count LIVE members, not layout entries: the layout can reference a pane whose panel was
  // already removed (close raced the dissolve, or a stale save). Rendering the shell then
  // leaves a hollow gray rectangle — a ghost group that can't be closed. Only render when ≥2
  // members actually exist; with fewer, the store's dissolve path releases the survivor and
  // this frame simply disappears.
  const liveMembers = panes.filter((p) => members.some((m) => m.id === p.panelId))
  if (liveMembers.length < 2) return null
  const livePaneIds = liveMembers.map((p) => p.panelId)
  /** Member id for group-level gestures (resize/dividers): keep the current focused member when it
   *  is still a live pane, else the first live pane. */
  const focusMemberForGesture = (): string => {
    const current = useCanvasFocusStore.getState().focus
    if (current && current.surfaceId === panel.id && livePaneIds.includes(current.panelId)) {
      return current.panelId
    }
    return livePaneIds[0]
  }

  const beginMove = (e: React.PointerEvent): void => {
    if ((e.target as HTMLElement).closest('.app-no-drag, button')) return
    e.preventDefault()
    // The anchor's pointerdown-capture already focused the group with the grabbed pane as member.
    bringToFront(panel.id)
    const canvasEl = (e.currentTarget as HTMLElement).closest('[data-canvas-background]') as HTMLElement | null
    // Direct drag (pre-glass behavior): the live group — xterm members included — translates
    // with the pointer via the anchor's pure translate3d (compositor-only, crisp). No ghost.
    gesture.current = {
      kind: 'move',
      sx: e.clientX,
      sy: e.clientY,
      start: { ...panel.rect },
      canvasRect: canvasEl?.getBoundingClientRect() ?? null,
    }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }

  const beginResize = (dir: ResizeDir) => (e: React.PointerEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    useCanvasFocusStore.getState().focusSurface(panel.id, focusMemberForGesture())
    bringToFront(panel.id)
    gesture.current = { kind: dir, sx: e.clientX, sy: e.clientY, start: { ...panel.rect } }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }

  const beginDivider = (d: DividerRect) => (e: React.PointerEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    useCanvasFocusStore.getState().focusSurface(panel.id, focusMemberForGesture())
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
    // All group moves are DIRECT (pre-glass behavior) — the live group translates with the
    // pointer via the anchor's pure translate3d (compositor-only, crisp). Dividers and resize
    // handles keep their direct-manipulation path. Zoom is read lazily during the drag instead
    // of taking it as a render prop (see PanelFrame).
    const zoom = viewportController.getLive().zoom
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

  // Escape cancels an in-flight group move: restore the group to its start position (never
  // commits). Direct drag already wrote positions, so move back explicitly.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      const g = gesture.current
      if (e.key === 'Escape' && g?.kind === 'move') {
        move(panel.id, g.start.x, g.start.y)
        gesture.current = null
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [move])

  const onPointerCancel = (): void => {
    endGesture()
  }

  // Pointer-capture loss (browser reclaim, element teardown): end the gesture, commit what moved.
  const onLostPointerCapture = (): void => {
    endGesture()
  }



  // Group ANCHOR: world position only (the camera lives on the world layer).
  const anchorStyle: CSSProperties = {
    left: 0,
    top: 0,
    width: panel.rect.width,
    height: panel.rect.height,
    transform: `translate3d(${panel.rect.x}px, ${panel.rect.y}px, 0)`,
    transformOrigin: '0 0',
    zIndex: zIndex ?? panel.z,
  }

  // The ghost header reads as the grabbed window: prefer a custom group title, else the first
  // live member's title (groups are created titled "Group" unless the user renames them).


  return (
    <div
      className="absolute"
      style={anchorStyle}
      onPointerDownCapture={(e) => {
        bringToFront(panel.id)
        // Primary clicks anywhere inside a pane (header or body) are a group-focus
        // action with THAT pane as the member — clicking between panes in an already-focused group
        // bumps the epoch and redirects the member without changing the group's opacity. Header
        // buttons/inputs (.app-no-drag) are excluded; resize handles/dividers focus via their own
        // handlers (they are app-no-drag, so they never reach this capture).
        if (e.button === 0 && !(e.target as HTMLElement).closest('.app-no-drag, input, textarea, button')) {
          const paneId = (e.target as HTMLElement).closest('[data-dock-pane]')?.getAttribute('data-dock-pane')
          if (paneId && members.some((m) => m.id === paneId && m.dockedIn === panel.id)) {
            useCanvasFocusStore.getState().focusSurface(panel.id, paneId)
          }
        }
      }}
      onPointerMove={onPointerMove}
      onPointerUp={endGesture}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={onLostPointerCapture}
    >
      {/* Group visual shell: the whole window — material + border + shadow + panes. The outer
          group dims/brightens as ONE unit; switching focus between panes (clicking a pane body)
          redirects the member without changing the group's opacity. */}
      <div
        data-surface-layer="panel"
        data-panel-focused={focused ? 'true' : 'false'}
        className="surface-layer surface-layer--panel absolute inset-0 overflow-hidden rounded-[26px]"
        style={{
          borderRadius: 26,
          opacity: !focused && !hovered ? UNFOCUSED_OPACITY : 1,
          // Same asymmetric wake/recede as a floating panel (PanelFrame) so a docked group and a
          // loose one never settle at different speeds side by side.
          transition:
            !focused && !hovered
              ? 'opacity 300ms var(--ease-settle), border-color 300ms var(--ease-settle)'
              : 'opacity 130ms var(--ease-settle), border-color 130ms var(--ease-settle)',
          // NO `content-visibility: auto` — same reason as PanelFrame: inside the scaled,
          // promoted world layer Chromium's relevance check lags the live transform, so the
          // group blanked while it moved. `contain` on .surface-layer--panel does the work.
        }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        {panes.map((p) => {
          const member = members.find((m) => m.id === p.panelId)
          if (!member) return null
          const Body = getPanelComponent(member.type)
          const meta = PANEL_META[member.type]
          return (
            <div
              key={p.panelId}
              data-dock-pane={p.panelId}
              className="absolute flex flex-col overflow-hidden"
              style={{ left: p.rect.x, top: p.rect.y, width: p.rect.width, height: p.rect.height }}
            >
              {/* slim pane header: drag = move group; DOUBLE-CLICK = detach; ⇲ button = detach; x = close */}
              <div
                className="group/h flex h-[30px] shrink-0 cursor-grab items-center gap-2.5 border-b border-glass bg-glass px-3 active:cursor-grabbing"
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
                <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-text-1">
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
              <div className="relative min-h-0 flex-1 select-text">
                <Body panel={member} />
                {/* Transparent first-click shield: clicking any unfocused group's pane body
                    focuses the OUTER group with this pane as the member (member redirect stays
                    invisible to the group's opacity). Sits above the pane content, below the
                    pane header and the group's z-20 resize handles. */}
                <FocusShield surfaceId={panel.id} memberId={p.panelId} />
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
