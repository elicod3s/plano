import { useViewportStore } from '@/stores/useViewportStore'
import { useUiStore } from '@/stores/useUiStore'
import { IconButton } from '@/design-system/IconButton'
import { Icon } from '@/design-system/Icon'
import { addPanelAtCenter, zoomToFitAll } from '@/app/actions'
import { cn } from '@/lib/cn'

export function Dock() {
  const zoom = useViewportStore((s) => s.zoom)
  const zoomTo = useViewportStore((s) => s.zoomTo)
  const setCommandPalette = useUiStore((s) => s.setCommandPalette)

  const viewport = (): { width: number; height: number } => ({
    width: window.innerWidth,
    height: window.innerHeight,
  })

  return (
    <div
      className="app-no-drag pointer-events-auto absolute bottom-6 left-1/2 z-30 flex -translate-x-1/2 items-center gap-1 rounded-xl border border-default p-1.5 shadow-dock"
      style={{ background: 'color-mix(in srgb, var(--bg-base) 72%, transparent)', backdropFilter: 'blur(12px)' }}
    >
      <button
        type="button"
        onClick={() => setCommandPalette(true)}
        className="flex h-8 items-center gap-2 rounded-sm border border-default px-3 text-[13px] font-medium text-text-primary transition-colors hover:bg-accent-soft hover:border-strong"
      >
        <Icon name="LayoutGrid" size={15} className="text-text-secondary" />
        Library
        <span className="font-mono text-[11px] text-text-tertiary">⌃⇧E</span>
      </button>

      <Divider />

      <IconButton icon="SquareTerminal" label="New Terminal" onClick={() => addPanelAtCenter('terminal')} />
      <IconButton icon="FolderTree" label="New Files" onClick={() => addPanelAtCenter('editor')} />
      <IconButton icon="Globe" label="New Browser" onClick={() => addPanelAtCenter('browser')} />
      <IconButton icon="Sparkles" label="New Agent" onClick={() => addPanelAtCenter('agent')} />
      <IconButton icon="StickyNote" label="New Sticky Note" onClick={() => addPanelAtCenter('sticky')} />

      <Divider />

      <IconButton icon="Mic" label="New Voice" onClick={() => addPanelAtCenter('voice')} />

      <Divider />

      <IconButton icon="Minus" label="Zoom out" size={26} onClick={() => zoomTo(zoom * 0.8, viewport())} />
      <button
        type="button"
        onClick={() => zoomTo(1, viewport())}
        className="h-7 min-w-[54px] rounded-sm px-2 font-mono text-[12px] text-text-secondary transition-colors hover:bg-accent-soft hover:text-text-primary"
        title="Reset zoom"
      >
        {Math.round(zoom * 100)}%
      </button>
      <IconButton icon="Plus" label="Zoom in" size={26} onClick={() => zoomTo(zoom * 1.25, viewport())} />
      <IconButton icon="Maximize2" label="Zoom to fit" size={26} onClick={() => zoomToFitAll()} />
    </div>
  )
}

function Divider() {
  return <div className={cn('mx-1 h-5 w-px bg-[var(--border-subtle)]')} />
}
