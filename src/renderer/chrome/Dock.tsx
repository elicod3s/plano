import type { PanelType } from '@shared/domain/panel'
import { useUiStore } from '@/stores/useUiStore'
import { IconButton } from '@/design-system/IconButton'
import { Icon } from '@/design-system/Icon'
import { addPanelAtCenter } from '@/app/actions'
import { shortcutForPanel } from '@/app/commands'
import { cn } from '@/lib/cn'
import { fmtKeys } from '@/lib/hotkeys'

/** Tooltip with the panel's keyboard shortcut appended (from the command registry). */
function tip(label: string, type: PanelType): string {
  const sc = shortcutForPanel(type)
  return sc ? `${label} · ${fmtKeys(sc)}` : label
}

/** Left vertical dock — purely for ADDING panels. View controls (zoom, fit-to-screen, the
 *  minimap toggle) live in the separate bottom-right ViewControls cluster. */
export function Dock() {
  const setCommandPalette = useUiStore((s) => s.setCommandPalette)

  return (
    <div
      className="app-no-drag pointer-events-auto absolute left-6 top-1/2 z-30 flex -translate-y-1/2 flex-col items-center gap-1 rounded-xl border border-default px-1.5 py-3 shadow-dock"
      style={{ background: 'color-mix(in srgb, var(--bg-base) 72%, transparent)', backdropFilter: 'blur(12px)' }}
    >
      {/* Primary action — the only colored item in the dock (token-driven warm accent), kept
          icon-only so the bar stays a thin vertical strip. Shortcut lives in the tooltip. */}
      <button
        type="button"
        onClick={() => setCommandPalette(true)}
        aria-label="Library"
        title={`Library (${fmtKeys('Ctrl+Shift+E')})`}
        className={cn(
          'app-no-drag inline-flex h-7 w-7 items-center justify-center rounded-sm border',
          'border-[var(--dock-accent-border)] bg-[var(--dock-accent-soft)] text-[var(--dock-accent)]',
          'transition-[background,color,transform] duration-150 ease-settle active:scale-[0.96] focus-caliper',
          'hover:bg-[var(--dock-accent-soft-strong)]',
        )}
      >
        <Icon name="LayoutGrid" size={16} />
      </button>

      <Divider />

      <IconButton icon="SquareTerminal" label="New Terminal" title={tip('New Terminal', 'terminal')} onClick={() => addPanelAtCenter('terminal')} />
      <IconButton icon="FolderTree" label="New Files" title={tip('New Files', 'editor')} onClick={() => addPanelAtCenter('editor')} />
      <IconButton icon="Globe" label="New Browser" title={tip('New Browser', 'browser')} onClick={() => addPanelAtCenter('browser')} />
      <IconButton icon="Sparkles" label="New Agent" title={tip('New Agent', 'agent')} onClick={() => addPanelAtCenter('agent')} />
      <IconButton icon="StickyNote" label="New Sticky Note" title={tip('New Sticky Note', 'sticky')} onClick={() => addPanelAtCenter('sticky')} />
      <IconButton icon="ListChecks" label="New To-do List" title={tip('New To-do List', 'todo')} onClick={() => addPanelAtCenter('todo')} />
      <IconButton icon="Timer" label="New Pomodoro" title={tip('New Pomodoro', 'pomodoro')} onClick={() => addPanelAtCenter('pomodoro')} />

      <Divider />

      <IconButton icon="Mic" label="New Voice" title={tip('New Voice', 'voice')} onClick={() => addPanelAtCenter('voice')} />
    </div>
  )
}

function Divider() {
  return <div className={cn('my-1 h-px w-5 bg-[var(--border-subtle)]')} />
}
