import { useEffect, useRef } from 'react'
import type { PanelType } from '@shared/domain/panel'
import { useUiStore } from '@/stores/useUiStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { Icon } from '@/design-system/Icon'
import { addPanelAtWorld } from '@/app/actions'
import { shortcutForPanel } from '@/app/commands'
import { cn } from '@/lib/cn'
import { fmtKeys } from '@/lib/hotkeys'

type Item =
  | { kind: 'panel'; panelType: PanelType; label: string; icon: string }
  | { kind: 'command'; label: string; icon: string; shortcut?: string; onSelect: () => void; disabled?: boolean; chevron?: boolean }
  | { kind: 'separator' }

const MENU_WIDTH = 240

export function ContextMenu() {
  const { open, screen, world } = useUiStore((s) => s.contextMenu)
  const close = useUiStore((s) => s.closeContextMenu)
  const openPalette = useUiStore((s) => s.setCommandPalette)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, close])

  if (!open) return null

  const add = (type: PanelType) => (): void => {
    addPanelAtWorld(type, world)
    close()
  }

  const items: Item[] = [
    { kind: 'panel', panelType: 'terminal', label: 'New Terminal', icon: 'SquareTerminal' },
    { kind: 'panel', panelType: 'editor', label: 'New Files', icon: 'FolderTree' },
    { kind: 'panel', panelType: 'browser', label: 'New Browser', icon: 'Globe' },
    { kind: 'panel', panelType: 'todo', label: 'New To-do List', icon: 'ListChecks' },
    { kind: 'panel', panelType: 'pomodoro', label: 'New Pomodoro', icon: 'Timer' },
    { kind: 'panel', panelType: 'sticky', label: 'New Sticky Note', icon: 'StickyNote' },
    { kind: 'separator' },
    {
      kind: 'command',
      label: 'Panel Library',
      icon: 'LayoutGrid',
      shortcut: 'Ctrl+Shift+E',
      onSelect: () => {
        openPalette(true)
        close()
      },
    },
    { kind: 'panel', panelType: 'region', label: 'New Region', icon: 'Frame' },
    { kind: 'panel', panelType: 'label', label: 'New Text', icon: 'Type' },
    { kind: 'separator' },
    {
      kind: 'command',
      label: 'Settings…',
      icon: 'Settings',
      shortcut: 'Ctrl+,',
      onSelect: () => {
        useSettingsStore.getState().setOpen(true)
        close()
      },
    },
    { kind: 'command', label: 'Paste', icon: 'Clipboard', disabled: true, onSelect: () => {} },
  ]

  // Clamp the menu inside the viewport.
  const left = Math.min(screen.x, window.innerWidth - MENU_WIDTH - 12)
  const top = Math.min(screen.y, window.innerHeight - 460)

  return (
    <>
      <div className="fixed inset-0 z-40" onPointerDown={close} onContextMenu={(e) => e.preventDefault()} />
      <div
        ref={ref}
        data-surface-layer="popover"
        className="animate-menu-in surface-layer surface-layer--popover fixed z-[var(--z-popover)] origin-top-left rounded-[18px] p-1.5"
        style={{ left, top, width: MENU_WIDTH }}
        onContextMenu={(e) => e.preventDefault()}
      >
        {items.map((item, i) =>
          item.kind === 'separator' ? (
            <div key={i} className="mx-2 my-1 h-px bg-[rgba(255,255,255,0.08)]" />
          ) : (
            <button
              key={i}
              type="button"
              disabled={item.kind === 'command' && item.disabled}
              onClick={item.kind === 'panel' ? add(item.panelType) : item.onSelect}
              className={cn(
                'flex h-[34px] w-full items-center gap-2.5 rounded-[10px] px-2.5 text-left text-[13px] transition-colors',
                'text-text-1 hover:bg-glass-hover disabled:opacity-40 disabled:hover:bg-transparent',
              )}
            >
              <Icon name={item.icon} size={15} className="shrink-0 text-text-2" />
              <span className="flex-1 truncate">{item.label}</span>
              {(() => {
                const sc = item.kind === 'command' ? item.shortcut : shortcutForPanel(item.panelType)
                return sc ? (
                  <span className="font-mono text-[10.5px] text-text-3">{fmtKeys(sc)}</span>
                ) : null
              })()}
              {item.kind === 'command' && item.chevron && (
                <Icon name="ChevronRight" size={13} className="text-text-3" />
              )}
            </button>
          ),
        )}
      </div>
    </>
  )
}
