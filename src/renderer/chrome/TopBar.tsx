import { useEffect, useState } from 'react'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { confirm } from '@/stores/useConfirmStore'
import { Icon } from '@/design-system/Icon'
import { IconButton } from '@/design-system/IconButton'
import { BrandMark } from '@/design-system/BrandMark'
import { SpacesMenu } from '@/chrome/workspaces/SpacesMenu'
import { FolderMenu } from '@/chrome/workspaces/FolderMenu'
import { WorkspaceGitChip } from '@/chrome/WorkspaceGitChip'
import { AgentManager } from '@/chrome/AgentManager'
import { TimeChip } from '@/chrome/TimeChip'
import { MobileChip } from '@/chrome/MobileChip'
import { cn } from '@/lib/cn'
import { IS_MAC } from '@/lib/hotkeys'
import { fmtKeys } from '@/lib/hotkeys'

/** Divider inside the floating toolbar. */
function ToolbarDivider() {
  return <div className="h-[18px] w-px shrink-0 bg-[rgba(255,255,255,0.08)]" />
}

/**
 * The floating glass toolbar. A rounded pill (44px) sitting 16px from the top edge, blurred
 * glass over the canvas. Brand + workspace switcher on the left; the command trigger pill in
 * the middle; mobile/agents/time/git + window controls on the right — per the new UI design.
 */
export function TopBar() {
  const [maximized, setMaximized] = useState(false)
  const openPalette = useUiOpenPalette()

  useEffect(() => {
    void window.plano.window.isMaximized().then(setMaximized)
  }, [])

  return (
    <header
      className={cn(
        'app-drag surface-layer surface-layer--chrome absolute left-6 right-6 top-4 z-[var(--z-chrome)] flex h-11 items-center gap-2',
        // macOS draws native traffic lights on the LEFT; reserve room so the brand isn't
        // tucked under them. Windows/Linux are frameless with our own controls on the right.
        IS_MAC ? 'pl-[104px]' : 'pl-2.5 pr-2',
        'rounded-[22px]',
      )}
      data-surface-layer="chrome"
    >
      {/* left cluster — flex-1 so the centered command trigger sits exactly mid-bar */}
      <div className="flex min-w-0 flex-1 items-center gap-2">
      {/* brand — the original PLANO mark, exactly like before (no box, no extra text) */}
      <div className="app-no-drag flex shrink-0 items-center">
        <BrandMark size={22} title="PLANO" className="shrink-0 text-text-1" />
      </div>

      <ToolbarDivider />

      {/* open-project folder: shows the path, click for Reveal / Copy / Change / Close */}
      <FolderMenu />

      {/* workspaces switcher — pill with the active workspace dot + name */}
      <SpacesMenu />

      {/* git/GitHub indicator for the open workspace repo */}
      <WorkspaceGitChip />
      </div>

      {/* command trigger pill */}
      <button
        type="button"
        onClick={() => openPalette(true)}
        className="app-no-drag flex h-7 w-[300px] max-w-[32vw] shrink-0 items-center gap-2.5 rounded-pill border border-[rgba(255,255,255,0.18)] px-3 text-left transition-colors hover:border-[rgba(255,255,255,0.3)] hover:bg-glass-hover focus-caliper"
        style={{ background: 'var(--glass)' }}
        aria-label="Open command palette"
      >
        <Icon name="Search" size={13} className="shrink-0 text-text-3" />
        <span className="truncate text-[12.5px] text-text-3">Search or jump to…</span>
        <span className="ml-auto flex h-5 shrink-0 items-center rounded-[6px] border border-glass px-2 font-mono text-[10.5px] text-text-3" style={{ background: 'rgba(0,0,0,0.2)' }}>
          {fmtKeys('Ctrl+K')}
        </span>
      </button>

      {/* right cluster — flex-1 justify-end keeps the trigger centered. The container stays
          draggable (inherits app-drag from the header) so the empty space right of the command
          trigger can move the window; every control inside opts back in with app-no-drag. */}
      <div className="flex flex-1 items-center justify-end gap-2">
        <MobileChip />

        <AgentManager />

        <TimeChip />

        <IconButton
          icon="Settings"
          label="Settings"
          size={30}
          onClick={() => useSettingsStore.getState().setOpen(true)}
        />

        {/* Custom window controls — Windows/Linux only. On macOS the native traffic lights own
            min/zoom/close, so ours are hidden to avoid duplicates. */}
        {!IS_MAC && (
          <div className="ml-0.5 flex items-center">
            <WindowButton icon="Minus" label="Minimize" onClick={() => window.plano.window.minimize()} />
            <WindowButton
              icon={maximized ? 'Copy' : 'Square'}
              label="Maximize"
              onClick={() => {
                window.plano.window.toggleMaximize()
                setMaximized((m) => !m)
              }}
            />
            <WindowButton
              icon="X"
              label="Close"
              danger
              onClick={() => {
                const { warnBeforeQuit } = useSettingsStore.getState().settings.general
                if (!warnBeforeQuit) {
                  window.plano.window.close()
                  return
                }
                void confirm({
                  title: 'Quit PLANO',
                  message: 'Quit PLANO? Your workspace is autosaved.',
                  confirmLabel: 'Quit',
                  danger: true,
                }).then((ok) => {
                  if (ok) window.plano.window.close()
                })
              }}
            />
          </div>
        )}
      </div>
    </header>
  )
}

/** Pulls the palette-opener from the UI store without a full re-import cycle. */
import { useUiStore } from '@/stores/useUiStore'
function useUiOpenPalette(): (open: boolean) => void {
  return useUiStore((s) => s.setCommandPalette)
}

function WindowButton({
  icon,
  label,
  onClick,
  danger,
}: {
  icon: string
  label: string
  onClick: () => void
  danger?: boolean
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={cn(
        'app-no-drag flex h-7 w-7 items-center justify-center rounded-[10px] text-text-secondary transition-colors',
        danger ? 'hover:bg-destructive hover:text-white' : 'hover:bg-glass-hover hover:text-text-primary',
      )}
    >
      <Icon name={icon} size={14} />
    </button>
  )
}
