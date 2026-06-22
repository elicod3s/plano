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
    if (r) setPos({ left: Math.min(r.left, window.innerWidth - MENU_W - 8), top: r.bottom + 6 })
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
        className="app-no-drag flex shrink-0 items-center gap-2 rounded-md border border-subtle px-2.5 py-1 text-[12px] text-text-secondary transition-colors hover:border-default hover:bg-accent-soft hover:text-text-primary"
      >
        <Icon name="FolderPlus" size={14} className="shrink-0 text-text-tertiary" />
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
          open ? 'border-strong bg-accent-soft' : 'border-subtle hover:border-default hover:bg-accent-soft',
        )}
      >
        <Icon name="Folder" size={14} className="shrink-0 text-text-tertiary" />
        <span className="max-w-[280px] truncate font-mono text-[12px] text-text-secondary">
          {prettyPath(folderPath)}
        </span>
        {dirty && (
          <span className="shrink-0 text-text-quaternary" title="Unsaved changes">
            •
          </span>
        )}
        <Icon
          name="ChevronDown"
          size={12}
          className={cn('shrink-0 text-text-tertiary transition-transform duration-200', open && 'rotate-180')}
        />
      </button>

      {open &&
        pos &&
        createPortal(
          <div className="fixed inset-0 z-[55]" onPointerDown={close}>
            <div
              className="animate-palette-in absolute flex flex-col overflow-hidden rounded-xl border border-strong py-1 shadow-overlay"
              style={{
                left: pos.left,
                top: pos.top,
                width: MENU_W,
                background: 'color-mix(in srgb, var(--bg-base) 94%, transparent)',
                backdropFilter: 'blur(20px)',
              }}
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
      className="flex items-center gap-2.5 px-3 py-1.5 text-left text-[12.5px] text-text-secondary transition-colors hover:bg-accent-soft hover:text-text-primary"
    >
      <Icon name={icon} size={14} className="shrink-0 text-text-tertiary" />
      {label}
    </button>
  )
}
