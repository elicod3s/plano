import { useViewportStore } from '@/stores/useViewportStore'
import { useUiStore } from '@/stores/useUiStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { IconButton } from '@/design-system/IconButton'
import { zoomToFitAll } from '@/app/actions'

/**
 * Compact ComfyUI-style view controls, bottom-right: zoom in/out, the zoom readout (click to
 * reset), zoom-to-fit, and the minimap toggle. Kept separate from the left Dock — that bar is
 * only for adding panels; everything about *navigating* the canvas lives here.
 *
 * The minimap toggle writes through the `canvas.showMinimap` setting (which syncs the runtime
 * `minimapVisible` the canvas reads), so it persists across launches.
 */
export function ViewControls() {
  const zoom = useViewportStore((s) => s.zoom)
  const zoomTo = useViewportStore((s) => s.zoomTo)
  const minimapVisible = useUiStore((s) => s.minimapVisible)
  const patch = useSettingsStore((s) => s.patch)

  const viewport = (): { width: number; height: number } => ({
    width: window.innerWidth,
    height: window.innerHeight,
  })

  return (
    <div
      className="app-no-drag pointer-events-auto absolute bottom-6 right-4 z-30 flex flex-col items-center gap-1 rounded-xl border border-default px-1.5 py-3 shadow-dock"
      style={{ background: 'color-mix(in srgb, var(--bg-base) 72%, transparent)', backdropFilter: 'blur(12px)' }}
    >
      <IconButton icon="Plus" label="Zoom in" size={26} onClick={() => zoomTo(zoom * 1.25, viewport())} />
      <button
        type="button"
        onClick={() => zoomTo(1, viewport())}
        className="h-7 w-full rounded-sm px-0 font-mono text-[11px] text-text-secondary transition-colors hover:bg-accent-soft hover:text-text-primary"
        title="Reset zoom"
      >
        {Math.round(zoom * 100)}%
      </button>
      <IconButton icon="Minus" label="Zoom out" size={26} onClick={() => zoomTo(zoom * 0.8, viewport())} />

      <Divider />

      <IconButton icon="Maximize2" label="Zoom to fit" size={26} onClick={() => zoomToFitAll()} />
      <IconButton
        icon="Map"
        label={minimapVisible ? 'Hide map' : 'Show map'}
        size={26}
        active={minimapVisible}
        onClick={() => patch('canvas', { showMinimap: !minimapVisible })}
      />
    </div>
  )
}

function Divider() {
  return <div className="my-1 h-px w-5 bg-[var(--border-subtle)]" />
}
