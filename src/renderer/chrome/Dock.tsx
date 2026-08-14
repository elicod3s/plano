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

/** Left vertical glass dock — purely for ADDING panels. View controls live bottom-right. */
export function Dock() {
  const setCommandPalette = useUiStore((s) => s.setCommandPalette)

  return (
    <div
      className="app-no-drag pointer-events-auto surface-layer surface-layer--chrome absolute left-5 top-1/2 z-[var(--z-chrome)] flex -translate-y-1/2 flex-col items-center gap-1 rounded-[26px] px-1.5 py-2"
      data-surface-layer="chrome"
    >
      {/* Primary action — the Library circle (accent-filled), opens the command palette. */}
      <button
        type="button"
        onClick={() => setCommandPalette(true)}
        aria-label="Library"
        title={`Library (${fmtKeys('Ctrl+Shift+E')})`}
        className={cn(
          'app-no-drag mb-0.5 inline-flex h-9 w-9 items-center justify-center rounded-full text-text-onsolid',
          'bg-accent transition-[background,color,transform] duration-150 ease-settle active:scale-[0.96] focus-caliper',
          'hover:bg-accent-hover',
        )}
      >
        <Icon name="LayoutGrid" size={16} />
      </button>

      <Divider />

      <IconButton icon="SquareTerminal" label="New Terminal" title={tip('New Terminal', 'terminal')} onClick={() => addPanelAtCenter('terminal')} />
      <IconButton icon="FolderTree" label="New Files" title={tip('New Files', 'editor')} onClick={() => addPanelAtCenter('editor')} />
      <IconButton icon="Globe" label="New Browser" title={tip('New Browser', 'browser')} onClick={() => addPanelAtCenter('browser')} />
      <IconButton icon="StickyNote" label="New Sticky Note" title={tip('New Sticky Note', 'sticky')} onClick={() => addPanelAtCenter('sticky')} />
      <IconButton icon="ListChecks" label="New To-do List" title={tip('New To-do List', 'todo')} onClick={() => addPanelAtCenter('todo')} />
      <IconButton icon="Timer" label="New Pomodoro" title={tip('New Pomodoro', 'pomodoro')} onClick={() => addPanelAtCenter('pomodoro')} />
    </div>
  )
}

function Divider() {
  return <div className="my-1 h-px w-6 bg-[rgba(255,255,255,0.1)]" />
}
