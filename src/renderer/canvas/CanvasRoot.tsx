import { useEffect, useRef } from 'react'
import { useViewportStore } from '@/stores/useViewportStore'
import { useUiStore } from '@/stores/useUiStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { cn } from '@/lib/cn'
import { screenToWorld } from '@shared/domain/geometry'
import { usePanZoom } from './hooks/usePanZoom'
import { GridBackground } from './GridBackground'
import { PanelLayer } from './PanelLayer'
import { SnapOverlay } from './SnapOverlay'

/**
 * The infinite-canvas surface. Owns pan (space-drag / middle-drag), wheel zoom, the
 * right-click context menu, and click-to-dismiss for overlays. Panels stop propagation
 * on their own pointer events so dragging a panel never pans the canvas.
 */
export function CanvasRoot() {
  const ref = useRef<HTMLDivElement>(null)
  usePanZoom(ref)

  const setPanning = useViewportStore((s) => s.setPanning)
  const setInteracting = useViewportStore((s) => s.setInteracting)
  const panBy = useViewportStore((s) => s.panBy)
  const openContextMenu = useUiStore((s) => s.openContextMenu)
  const closeContextMenu = useUiStore((s) => s.closeContextMenu)
  const grain = useSettingsStore((s) => s.settings.appearance.grain)

  const spaceHeld = useRef(false)
  const pan = useRef<{ lastX: number; lastY: number } | null>(null)

  useEffect(() => {
    const down = (e: KeyboardEvent): void => {
      if (e.code === 'Space' && !isTypingTarget(e.target)) spaceHeld.current = true
    }
    const up = (e: KeyboardEvent): void => {
      if (e.code === 'Space') spaceHeld.current = false
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [])

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    // Only react to gestures that start on the empty canvas, not on a panel.
    if (e.target !== e.currentTarget && !(e.target as HTMLElement).dataset.canvasBackground) {
      return
    }
    closeContextMenu()
    const isPanGesture = e.button === 1 || (e.button === 0 && spaceHeld.current)
    if (!isPanGesture) return
    e.preventDefault()
    pan.current = { lastX: e.clientX, lastY: e.clientY }
    setPanning(true)
    setInteracting(true) // promote the world layer to a GPU texture for the duration of the pan
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!pan.current) return
    panBy(e.clientX - pan.current.lastX, e.clientY - pan.current.lastY)
    pan.current = { lastX: e.clientX, lastY: e.clientY }
  }

  const endPan = (): void => {
    if (!pan.current) return
    pan.current = null
    setPanning(false)
    setInteracting(false) // drop the GPU-layer hint so settled text re-rasters sharp
  }

  const onContextMenu = (e: React.MouseEvent<HTMLDivElement>): void => {
    if (e.target !== e.currentTarget && !(e.target as HTMLElement).dataset.canvasBackground) return
    e.preventDefault()
    const rect = ref.current!.getBoundingClientRect()
    const screen = { x: e.clientX - rect.left, y: e.clientY - rect.top }
    const { x, y, zoom } = useViewportStore.getState()
    const world = screenToWorld(screen, { x, y, zoom })
    openContextMenu(screen, world)
  }

  return (
    <div
      ref={ref}
      data-canvas-background="true"
      className={cn('absolute inset-0 overflow-hidden', grain && 'plano-grain')}
      style={{ background: 'var(--bg-canvas)', cursor: pan.current ? 'grabbing' : 'default' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPan}
      onPointerCancel={endPan}
      onLostPointerCapture={endPan}
      onContextMenu={onContextMenu}
    >
      <GridBackground />
      <PanelLayer />
      <SnapOverlay />
    </div>
  )
}

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable
}
