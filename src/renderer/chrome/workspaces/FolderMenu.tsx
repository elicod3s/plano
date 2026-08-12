import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useWorkspaceStore } from '@/stores/useWorkspaceStore'
import { openFolder, closeWorkspace, changeActiveWorkspaceFolder } from '@/app/workspaceActions'
import { Icon } from '@/design-system/Icon'
import { cn } from '@/lib/cn'

const MENU_W = 236

/** Show a Windows path with forward slashes — reads cleaner in the chip; copy keeps the real path. */
function prettyPath(p: string): string {
  return p.replace(/\\/g, '/')
}

/**
 * The open-project control in the top bar. When a folder is open it shows that folder's path and,
 * on click, drops a small menu: Reveal in File Explorer · Copy Path · Change Folder… · Close Project.
 * When no folder is open the chip becomes a single "choose folder" call to the native picker — so
 * the top bar only ever shows the real folder path, never a stale name.
 */
export function FolderMenu() {
  const folderPath = useWorkspaceStore((s) => s.folderPath)
  const dirty = useWorkspaceStore((s) => s.dirty)

  const triggerRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  const close = (): void => setOpen(false)

  useLayoutEffect(() => {
    if (!open) return
    const r = triggerRef.current?.getBoundingClientRect()
    if (r) setPos({ left: Math.min(r.left, window.innerWidth - MENU_W - 12), top: r.bottom + 12 })
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', close)
    }
  }, [open])

  // No project open → the chip is a direct shortcut to the folder picker (the menu actions don't apply).
  if (!folderPath) {
    return (
      <button
        type="button"
        onClick={() => void openFolder()}
        className="app-no-drag flex h-7 shrink-0 items-center gap-2 rounded-pill border border-glass px-2.5 text-[12.5px] text-text-2 transition-colors hover:border-glass-hover hover:bg-glass hover:text-text-1"
        style={{ background: 'var(--glass)' }}
      >
        <Icon name="FolderPlus" size={14} className="shrink-0 text-text-3" />
        choose folder
      </button>
    )
  }

  const reveal = (): void => {
    void window.plano.shell.revealPath(folderPath)
    close()
  }
  const copy = (): void => {
    void window.plano.clipboard.writeText(folderPath)
    close()
  }
  const change = (): void => {
    close()
    void changeActiveWorkspaceFolder()
  }
  const closeProject = (): void => {
    close()
    void closeWorkspace()
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={folderPath}
        aria-label="Project folder"
        className={cn(
          'app-no-drag flex min-w-0 shrink items-center gap-2 rounded-md border px-2.5 py-1 transition-colors',
          open ? 'border-glass-hover bg-glass-hover' : 'border-glass hover:border-glass-hover hover:bg-glass',
        )}
      >
        <Icon name="Folder" size={14} className="shrink-0 text-text-3" />
        <span className="max-w-[220px] truncate text-[12.5px] text-text-2">
          {prettyPath(folderPath)}
        </span>
        {dirty && (
          <span className="shrink-0 text-text-4" title="Unsaved changes">
            •
          </span>
        )}
        <Icon
          name="ChevronDown"
          size={12}
          className={cn('shrink-0 text-text-3 transition-transform duration-200', open && 'rotate-180')}
        />
      </button>

      {open &&
        pos &&
        createPortal(
          <div className="fixed inset-0 z-[var(--z-popover)]" onPointerDown={close}>
            <div
              data-surface-layer="popover"
              className="animate-palette-in surface-layer surface-layer--popover absolute flex flex-col overflow-hidden rounded-[16px] py-1"
              style={{ left: pos.left, top: pos.top, width: MENU_W }}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <MenuItem icon="FolderOpen" label="Reveal in File Explorer" onClick={reveal} />
              <MenuItem icon="Copy" label="Copy Path" onClick={copy} />
              <div className="my-1 border-t border-subtle" />
              <MenuItem icon="FolderSync" label="Change Folder…" onClick={change} />
              <MenuItem icon="FolderX" label="Close Workspace" onClick={closeProject} />
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}

function MenuItem({ icon, label, onClick }: { icon: string; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-2.5 px-3 py-2 text-left text-[12.5px] text-text-2 transition-colors hover:bg-glass-hover hover:text-text-1"
    >
      <Icon name={icon} size={14} className="shrink-0 text-text-3" />
      {label}
    </button>
  )
}
