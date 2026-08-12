import { useEffect, useState } from 'react'
import { useViewportStore } from '@/stores/useViewportStore'
import { useUiStore } from '@/stores/useUiStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { IconButton } from '@/design-system/IconButton'
import { zoomToFitAll } from '@/app/actions'
import { viewportController } from '@/canvas/ViewportController'

/**
 * Glass view controls, bottom-right: zoom in/out, the zoom readout (click to reset),
 * zoom-to-fit, and the minimap toggle — a compact 44px rounded column per the design.
 * The minimap toggle writes through the `canvas.showMinimap` setting.
 *
 * The zoom readout subscribes to the camera's LIVE channel (not the React store), so a
 * pan/zoom gesture never re-renders this chrome overlay via React — the world transform
 * keeps exactly one writer (the controller during motion, the store at rest).
 */
export function ViewControls() {
  const zoomTo = useViewportStore((s) => s.zoomTo)
  const minimapVisible = useUiStore((s) => s.minimapVisible)
  const patch = useSettingsStore((s) => s.patch)
  const [zoom, setZoom] = useState(useViewportStore.getState().zoom)

  useEffect(() => {
    const unLive = viewportController.subscribeLive((v) => setZoom(v.zoom))
    const unSettled = viewportController.subscribeSettled((v) => setZoom(v.zoom))
    // The controller's channels only fire for GESTURES. Every programmatic camera change writes
    // the store instead — Reset zoom, the +/− buttons, zoom-to-fit, the minimap, jump-to-panel —
    // so without this subscription the readout froze at whatever the last gesture left (the
    // motion E2E caught it: Reset zoom kept reporting 90%). Worse, the +/− buttons compute from
    // this value, so a stale base made them jump from the wrong zoom. Since the camera is no
    // longer published to the store mid-gesture, this fires only at rest — no per-frame renders.
    const unStore = useViewportStore.subscribe((s) => {
      const next = s.zoom
      setZoom((prev) => (prev === next ? prev : next))
    })
    return () => {
      unLive()
      unSettled()
      unStore()
    }
  }, [])

  const viewport = (): { width: number; height: number } => ({
    width: window.innerWidth,
    height: window.innerHeight,
  })

  /**
   * One zoom step, EASED. The buttons used to write `zoom * 1.25` straight to the store, so the
   * world snapped from one scale to the next with nothing in between — the jumpiness the user
   * reported. This rides the same live camera path a wheel gesture uses, anchored at the screen
   * centre, and reads the CURRENT zoom from the controller so repeated clicks compound correctly.
   */
  const stepZoom = (factor: number): void => {
    const v = viewport()
    viewportController.animateZoomTo(viewportController.getLive().zoom * factor, {
      x: v.width / 2,
      y: v.height / 2,
    })
  }

  return (
    <div
      className="app-no-drag pointer-events-auto surface-layer surface-layer--chrome absolute bottom-6 right-5 z-[var(--z-chrome)] flex flex-col items-center gap-0.5 rounded-[26px] px-1 py-1.5"
      data-surface-layer="chrome"
    >
      <IconButton icon="Plus" label="Zoom in" size={28} onClick={() => stepZoom(1.25)} />
      <button
        type="button"
        onClick={() => zoomTo(1, viewport())}
        className="flex h-[22px] w-9 items-center justify-center rounded-[7px] font-mono text-[10.5px] text-text-1 transition-colors hover:bg-glass-hover"
        style={{ background: 'rgba(0,0,0,0.18)' }}
        title="Reset zoom"
      >
        {Math.round(zoom * 100)}%
      </button>
      <IconButton icon="Minus" label="Zoom out" size={28} onClick={() => stepZoom(1 / 1.25)} />

      <Divider />

      <IconButton icon="Maximize2" label="Zoom to fit" size={28} onClick={() => zoomToFitAll()} />
      <IconButton
        icon="Map"
        label={minimapVisible ? 'Hide map' : 'Show map'}
        size={28}
        active={minimapVisible}
        onClick={() => patch('canvas', { showMinimap: !minimapVisible })}
      />
    </div>
  )
}

function Divider() {
  return <div className="my-1 h-px w-5 bg-[rgba(255,255,255,0.1)]" />
}
