import { memo, useEffect, useRef, useState } from 'react'
import type { Panel, LabelProps } from '@shared/domain/panel'
import { snap, type Rect } from '@shared/domain/geometry'
import { usePanelStore } from '@/stores/usePanelStore'
import { useUiStore } from '@/stores/useUiStore'
import { useViewportStore } from '@/stores/useViewportStore'
import { IconButton } from '@/design-system/IconButton'
import { cn } from '@/lib/cn'

const GRID = 8
const MIN_W = 120
const MIN_H = 36

type ResizeDir = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

/**
 * A text label is *ground*, not a window: free-floating display text that lives behind the
 * panels to title and organize zones of the canvas — the lightweight alternative to a region
 * when you only want a heading, not a bordered plate (that's why it renders here instead of
 * through PanelFrame, and shares a region's low z-band). It wears no panel chrome — no header,
 * no card, no fill — just the words. Drag to move, resize from any edge, double-click (or the
 * hover ✎) to edit. Deliberately distinct from a Sticky Note, which is a real card panel.
 */
function TextLabelFrameInner({ panel, zIndex }: { panel: Panel; zIndex: number }) {
  const props = panel.props as LabelProps
  const move = usePanelStore((s) => s.movePanel)
  const resize = usePanelStore((s) => s.resizePanel)
  const remove = usePanelStore((s) => s.removePanel)
  const updateProps = usePanelStore((s) => s.updateProps)
  const snapping = useUiStore((s) => s.snapping)

  const [editing, setEditing] = useState(false)
  const taRef = useRef<HTMLTextAreaElement | null>(null)
  const gesture = useRef<{ kind: 'move' | ResizeDir; sx: number; sy: number; start: Rect } | null>(null)

  // Focus + select-all when entering edit mode, so a double-click drops straight into typing.
  useEffect(() => {
    if (editing && taRef.current) {
      taRef.current.focus()
      taRef.current.select()
    }
  }, [editing])

  const maybeSnap = (v: number): number => (snapping ? snap(v, GRID) : Math.round(v))

  const beginMove = (e: React.PointerEvent): void => {
    if (editing) return
    if ((e.target as HTMLElement).closest('.app-no-drag, textarea, button')) return
    e.preventDefault()
    gesture.current = { kind: 'move', sx: e.clientX, sy: e.clientY, start: { ...panel.rect } }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }

  const beginResize = (dir: ResizeDir) => (e: React.PointerEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    gesture.current = { kind: dir, sx: e.clientX, sy: e.clientY, start: { ...panel.rect } }
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
    resize(panel.id, { x: maybeSnap(x), y: maybeSnap(y), width: maybeSnap(width), height: maybeSnap(height) })
  }

  const endGesture = (): void => {
    gesture.current = null
  }

  const commit = (value: string): void => {
    updateProps<'label'>(panel.id, { text: value })
    setEditing(false)
  }

  // A heading-scale display face, distinct from a sticky note's body text.
  const TYPO = 'font-display text-[26px] font-semibold leading-tight tracking-tightui'

  return (
    // Wrapper is click-through; only the text, toolbar and resize handles capture pointer
    // events. Positioned via transform (not left/top) so dragging composites cleanly.
    <div
      className="group/label absolute"
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
    >
      {editing ? (
        <textarea
          ref={taRef}
          defaultValue={props.text}
          placeholder="Text"
          spellCheck={false}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') (e.target as HTMLTextAreaElement).blur()
          }}
          className={cn(
            'app-no-drag h-full w-full resize-none border-none bg-transparent p-0',
            TYPO,
            'text-text-primary placeholder:text-text-quaternary focus:outline-none',
          )}
          style={{ pointerEvents: 'auto', userSelect: 'text' }}
        />
      ) : (
        <div
          className={cn(
            'h-full w-full cursor-move select-none overflow-visible whitespace-pre-wrap break-words',
            TYPO,
            props.text ? 'text-text-primary' : 'text-text-quaternary',
          )}
          style={{ pointerEvents: 'auto' }}
          onPointerDown={beginMove}
          onDoubleClick={() => setEditing(true)}
        >
          {props.text || 'Text'}
        </div>
      )}

      {/* hover toolbar — edit + delete; hidden while editing */}
      {!editing && (
        <div
          className="app-no-drag absolute -top-10 right-0 flex items-center gap-0.5 rounded-lg border border-subtle bg-surface-3 px-1 py-0.5 opacity-0 shadow-popover transition-opacity group-hover/label:opacity-100"
          style={{ pointerEvents: 'auto' }}
        >
          <IconButton icon="Pencil" label="Edit text" size={26} onClick={() => setEditing(true)} />
          <IconButton icon="Trash2" label="Remove text" size={26} danger onClick={() => remove(panel.id)} />
        </div>
      )}

      {/* resize handles (8-way) — chrome-less but grabbable, like a region; hidden while editing */}
      {!editing && <ResizeHandles onBegin={beginResize} />}
    </div>
  )
}

// Memoized so a pan/zoom (or dragging another panel) doesn't re-render every label. With the
// zoom prop gone, `panel`/`zIndex` are stable across a camera move, so memo bails on zoom.
export const TextLabelFrame = memo(TextLabelFrameInner)

const PE = { pointerEvents: 'auto' as const }

function ResizeHandles({ onBegin }: { onBegin: (dir: ResizeDir) => (e: React.PointerEvent) => void }) {
  return (
    <>
      <div className="absolute inset-x-3 top-0 z-20 h-1.5 cursor-ns-resize" style={PE} onPointerDown={onBegin('n')} />
      <div className="absolute inset-x-3 bottom-0 z-20 h-1.5 cursor-ns-resize" style={PE} onPointerDown={onBegin('s')} />
      <div className="absolute inset-y-3 left-0 z-20 w-1.5 cursor-ew-resize" style={PE} onPointerDown={onBegin('w')} />
      <div className="absolute inset-y-3 right-0 z-20 w-1.5 cursor-ew-resize" style={PE} onPointerDown={onBegin('e')} />
      <div className="absolute left-0 top-0 z-30 h-3 w-3 cursor-nwse-resize" style={PE} onPointerDown={onBegin('nw')} />
      <div className="absolute right-0 top-0 z-30 h-3 w-3 cursor-nesw-resize" style={PE} onPointerDown={onBegin('ne')} />
      <div className="absolute bottom-0 left-0 z-30 h-3 w-3 cursor-nesw-resize" style={PE} onPointerDown={onBegin('sw')} />
      <div className="absolute bottom-0 right-0 z-30 h-3 w-3 cursor-nwse-resize" style={PE} onPointerDown={onBegin('se')} />
    </>
  )
}
