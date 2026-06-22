import { useEffect, useState } from 'react'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { confirm } from '@/stores/useConfirmStore'
import { Icon } from '@/design-system/Icon'
import { BrandMark } from '@/design-system/BrandMark'
import { IconButton } from '@/design-system/IconButton'
import { SpacesMenu } from '@/chrome/workspaces/SpacesMenu'
import { FolderMenu } from '@/chrome/workspaces/FolderMenu'
import { WorkspaceGitChip } from '@/chrome/WorkspaceGitChip'
import { AgentManager } from '@/chrome/AgentManager'
import { TimeChip } from '@/chrome/TimeChip'
import { cn } from '@/lib/cn'

export function TopBar() {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    void window.plano.window.isMaximized().then(setMaximized)
  }, [])

  return (
    <header
      className="app-drag relative z-30 flex h-11 shrink-0 items-center gap-3 border-b border-subtle px-3"
      style={{ background: 'color-mix(in srgb, var(--bg-base) 82%, transparent)', backdropFilter: 'blur(12px)' }}
    >
      {/* brand */}
      <div className="app-no-drag flex shrink-0 items-center">
        <BrandMark size={22} title="PLANO" className="shrink-0 text-text-primary" />
      </div>

      {/* open-project folder: shows the path, click for Reveal / Copy / Change / Close */}
      <FolderMenu />

      {/* workspaces switcher — opens a floating dropdown of all spaces */}
      <SpacesMenu />

      {/* git/GitHub indicator for the open workspace repo (branch + state, click → GitHub) */}
      <WorkspaceGitChip />

      {/* right: running-agents manager + time chip + settings + window controls */}
      <div className="app-no-drag ml-auto flex items-center gap-2">
        <AgentManager />

        <TimeChip />

        <IconButton
          icon="Settings"
          label="Settings"
          size={30}
          onClick={() => useSettingsStore.getState().setOpen(true)}
        />

        <div className="ml-1 flex items-center">
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
      </div>
    </header>
  )
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
        'flex h-8 w-9 items-center justify-center rounded-sm text-text-secondary transition-colors',
        danger ? 'hover:bg-destructive hover:text-white' : 'hover:bg-accent-soft hover:text-text-primary',
      )}
    >
      <Icon name={icon} size={14} />
    </button>
  )
}
