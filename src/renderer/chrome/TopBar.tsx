import { useEffect, useState } from 'react'
import { useWorkspaceStore } from '@/stores/useWorkspaceStore'
import { Icon } from '@/design-system/Icon'
import { Button } from '@/design-system/Button'
import { openFolder } from '@/app/workspaceActions'
import { SpacesMenu } from '@/chrome/workspaces/SpacesMenu'
import { TimeChip } from '@/chrome/TimeChip'
import { cn } from '@/lib/cn'

export function TopBar() {
  const name = useWorkspaceStore((s) => s.name)
  const folderPath = useWorkspaceStore((s) => s.folderPath)
  const dirty = useWorkspaceStore((s) => s.dirty)
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    void window.plano.window.isMaximized().then(setMaximized)
  }, [])

  return (
    <header
      className="app-drag relative z-30 flex h-11 shrink-0 items-center gap-3 border-b border-subtle px-3"
      style={{ background: 'color-mix(in srgb, var(--bg-base) 82%, transparent)', backdropFilter: 'blur(12px)' }}
    >
      {/* brand + project */}
      <div className="app-no-drag flex shrink-0 items-center gap-2">
        <div className="flex h-6 w-6 items-center justify-center rounded-sm bg-accent text-text-onsolid">
          <Icon name="Frame" size={15} strokeWidth={2} />
        </div>
        <span
          className="max-w-[150px] truncate text-[13px] font-semibold text-text-primary"
          title={folderPath ?? undefined}
        >
          {name}
        </span>
        {dirty && (
          <span className="text-text-quaternary" title="Unsaved changes">
            •
          </span>
        )}
      </div>

      <div className="app-no-drag shrink-0">
        <Button variant="ghost" size="sm" onClick={() => void openFolder()}>
          <Icon name="FolderOpen" size={14} />
          {folderPath ? 'Change folder' : 'Open folder'}
        </Button>
      </div>

      {/* workspaces switcher — opens a floating dropdown of all spaces */}
      <SpacesMenu />

      {/* right: time chip + window controls */}
      <div className="app-no-drag ml-auto flex items-center gap-2">
        <TimeChip />

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
          <WindowButton icon="X" label="Close" danger onClick={() => window.plano.window.close()} />
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
