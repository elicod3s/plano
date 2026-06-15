import { useRef, useState } from 'react'
import type { Panel } from '@shared/domain/panel'
import { PANEL_META } from '@shared/domain/panel'
import { snap, type Rect } from '@shared/domain/geometry'
import { usePanelStore } from '@/stores/usePanelStore'
import { useUiStore } from '@/stores/useUiStore'
import { useTerminalStore } from '@/stores/useTerminalStore'
import { useAgentStore, selectVerdict } from '@/stores/useAgentStore'
import { Icon } from '@/design-system/Icon'
import { IconButton } from '@/design-system/IconButton'
import { cn } from '@/lib/cn'
import { getPanelComponent } from './PanelRegistry'

const GRID = 8
const MIN_W = 200
const MIN_H = 120

type ResizeDir = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

export function PanelFrame({ panel, zoom, zIndex }: { panel: Panel; zoom: number; zIndex?: number }) {
  const move = usePanelStore((s) => s.movePanel)
  const resize = usePanelStore((s) => s.resizePanel)
  const bringToFront = usePanelStore((s) => s.bringToFront)
  const remove = usePanelStore((s) => s.removePanel)
  const setTitle = usePanelStore((s) => s.setTitle)
  const isFront = usePanelStore((s) => s.zCounter === panel.z)
  const snapping = useUiStore((s) => s.snapping)

  const ptyId = useTerminalStore((s) => (panel.type === 'terminal' ? s.byPanel[panel.id]?.ptyId ?? null : null))
  const termStatus = useTerminalStore((s) => s.byPanel[panel.id]?.status)
  const agentActive = useAgentStore(selectVerdict(ptyId)).active

  const [editingTitle, setEditingTitle] = useState(false)
  const meta = PANEL_META[panel.type]
  const Body = getPanelComponent(panel.type)
  const gesture = useRef<{ kind: 'move' | ResizeDir; sx: number; sy: number; start: Rect } | null>(null)

  const maybeSnap = (v: number): number => (snapping ? snap(v, GRID) : Math.round(v))

  const beginMove = (e: React.PointerEvent): void => {
    if ((e.target as HTMLElement).closest('.app-no-drag, input, textarea, button')) return
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

  const onPointerMove = (e: React.PointerEvent): void => {
    const g = gesture.current
    if (!g) return
    const dx = (e.clientX - g.sx) / zoom
    const dy = (e.clientY - g.sy) / zoom

    if (g.kind === 'move') {
      move(panel.id, maybeSnap(g.start.x + dx), maybeSnap(g.start.y + dy))
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

  const statusColor =
    panel.type === 'terminal'
      ? termStatus === 'exited'
        ? 'var(--status-error)'
        : agentActive
          ? 'var(--status-active)'
          : 'var(--status-ready)'
      : 'var(--status-ready)'

  return (
    <div
      className={cn(
        'group absolute flex flex-col overflow-hidden rounded-lg border bg-surface-1',
        isFront ? 'border-strong' : 'border-subtle',
        agentActive && 'animate-agent-breathe',
      )}
      style={{
        // Position via GPU transform (not left/top) so moving a panel composites cleanly
        // — left/top moves repaint and leave a ghost trail from the agent box-shadow/rail.
        left: 0,
        top: 0,
        width: panel.rect.width,
        height: panel.rect.height,
        transform: `translate3d(${panel.rect.x}px, ${panel.rect.y}px, 0)`,
        zIndex: zIndex ?? panel.z,
        boxShadow: isFront ? 'var(--shadow-panel-focus)' : 'var(--shadow-panel)',
      }}
      onPointerDownCapture={() => bringToFront(panel.id)}
      onPointerMove={onPointerMove}
      onPointerUp={endGesture}
      onPointerCancel={endGesture}
    >
      {/* agent-mode left status rail + one-shot scan hairline */}
      {agentActive && (
        <>
          <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-[2px] bg-accent" />
          <div
            key="scan"
            className="animate-agent-scan pointer-events-none absolute left-0 right-0 z-10 h-px bg-accent/40"
          />
        </>
      )}

      {/* header (drag handle) */}
      <div
        className="flex h-9 shrink-0 cursor-grab items-center gap-2 border-b border-subtle bg-surface-2 px-2.5 active:cursor-grabbing"
        onPointerDown={beginMove}
        onDoubleClick={() => setEditingTitle(true)}
      >
        <span className="datum-grip shrink-0 group-hover:[&>span]:bg-[var(--text-secondary)]">
          {Array.from({ length: 6 }).map((_, i) => (
            <span key={i} />
          ))}
        </span>
        <span className="h-1.5 w-1.5 shrink-0 rounded-pill" style={{ background: statusColor }} />
        <Icon name={meta.icon} size={14} className="shrink-0 text-text-secondary" />

        {editingTitle ? (
          <input
            autoFocus
            defaultValue={panel.title}
            onBlur={(e) => {
              setTitle(panel.id, e.target.value || panel.title)
              setEditingTitle(false)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              if (e.key === 'Escape') setEditingTitle(false)
            }}
            className="app-no-drag min-w-0 flex-1 bg-transparent text-[13px] font-semibold text-text-primary focus:outline-none"
          />
        ) : (
          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-text-primary">
            {panel.title}
          </span>
        )}

        {agentActive && <span className="label-caps shrink-0 text-text-primary">Agent</span>}

        <div className="app-no-drag flex shrink-0 items-center gap-0.5 opacity-60 transition-opacity group-hover:opacity-100">
          <IconButton icon="X" label="Close panel" size={24} danger onClick={() => remove(panel.id)} />
        </div>
      </div>

      {/* body */}
      <div className="min-h-0 flex-1">
        <Body panel={panel} />
      </div>

      {/* resize handles (8-way) */}
      <ResizeHandles onBegin={beginResize} />
    </div>
  )
}

function ResizeHandles({ onBegin }: { onBegin: (dir: ResizeDir) => (e: React.PointerEvent) => void }) {
  const edge = 'absolute z-20'
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
