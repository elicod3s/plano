import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import type { FsNode } from '@shared/ipc/contracts'
import { Icon } from '@/design-system/Icon'
import { cn } from '@/lib/cn'

const MENU_WIDTH = 232

interface MenuItem {
  label: string
  icon: string
  onClick: () => void
  /** Destructive action — rendered in the reserved red. */
  danger?: boolean
}

/** Parent directory of an absolute path (OS-agnostic). */
function dirName(p: string): string {
  const idx = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'))
  return idx > 0 ? p.slice(0, idx) : p
}

/** Path relative to `root` (e.g. "src\\app\\main.ts"), falling back to the absolute path. */
function relativePath(root: string, p: string): string {
  if (!root || !p.startsWith(root)) return p
  return p.slice(root.length).replace(/^[\\/]+/, '') || p
}

/**
 * Right-click menu for a Files-panel tree node. Rendered in a body portal so it isn't
 * scaled/clipped by the canvas transform. Beyond path/copy/reveal, it's the file-manager
 * surface: New File / New Folder (inline naming in the tree), Rename, and Delete (→ OS
 * trash). `isRoot` marks the synthetic root entry, which can't be renamed or deleted.
 */
export function TreeContextMenu({
  node,
  rootPath,
  x,
  y,
  isRoot = false,
  onClose,
  onOpenFile,
  onOpenInTerminal,
  onNewEntry,
  onRename,
  onDelete,
}: {
  node: FsNode
  rootPath: string
  x: number
  y: number
  isRoot?: boolean
  onClose: () => void
  onOpenFile: (node: FsNode) => void
  onOpenInTerminal: (cwd: string) => void
  onNewEntry: (parentDir: string, type: 'file' | 'directory') => void
  onRename: (node: FsNode) => void
  onDelete: (node: FsNode) => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const copy = (text: string) => (): void => {
    void (async () => {
      try {
        await window.plano.clipboard.writeText(text)
      } catch {
        try {
          await navigator.clipboard.writeText(text)
        } catch {
          /* clipboard unavailable */
        }
      }
    })()
  }
  const isDir = node.type === 'directory'
  const terminalCwd = isDir ? node.path : dirName(node.path)
  // New entries land inside a folder; for a file, beside it.
  const newEntryDir = isDir ? node.path : dirName(node.path)

  const items: Array<MenuItem | 'separator'> = [
    ...(isDir
      ? []
      : [{ label: 'Open', icon: 'FileSymlink', onClick: () => onOpenFile(node) } as MenuItem]),
    { label: 'New File…', icon: 'FilePlus2', onClick: () => onNewEntry(newEntryDir, 'file') },
    { label: 'New Folder…', icon: 'FolderPlus', onClick: () => onNewEntry(newEntryDir, 'directory') },
    'separator',
    { label: 'Open in Terminal', icon: 'SquareTerminal', onClick: () => onOpenInTerminal(terminalCwd) },
    'separator',
    { label: 'Copy Path', icon: 'Copy', onClick: copy(node.path) },
    { label: 'Copy Relative Path', icon: 'Copy', onClick: copy(relativePath(rootPath, node.path)) },
    { label: 'Copy Name', icon: 'Copy', onClick: copy(node.name) },
    'separator',
    ...(!isRoot
      ? ([
          { label: 'Rename…', icon: 'PenLine', onClick: () => onRename(node) },
          { label: 'Delete', icon: 'Trash2', onClick: () => onDelete(node), danger: true },
          'separator',
        ] as Array<MenuItem | 'separator'>)
      : []),
    { label: 'Reveal in File Explorer', icon: 'FolderOpen', onClick: () => void window.plano.shell.revealPath(node.path) },
  ]

  // Clamp inside the viewport.
  const left = Math.min(x, window.innerWidth - MENU_WIDTH - 12)
  const top = Math.min(y, window.innerHeight - (items.length * 34 + 16))

  const run = (fn: () => void) => (): void => {
    fn()
    onClose()
  }

  return createPortal(
    <>
      <div
        className="fixed inset-0 z-[var(--z-popover)]"
        onPointerDown={onClose}
        onContextMenu={(e) => {
          e.preventDefault()
          onClose()
        }}
      />
      <div
        data-surface-layer="popover"
        className="animate-menu-in surface-layer surface-layer--popover fixed z-[var(--z-popover)] origin-top-left rounded-[18px] p-1.5"
        style={{ left, top: Math.max(8, top), width: MENU_WIDTH }}
        onContextMenu={(e) => e.preventDefault()}
      >
        {items.map((item, i) =>
          item === 'separator' ? (
            <div key={i} className="mx-2 my-1 h-px bg-[rgba(255,255,255,0.08)]" />
          ) : (
            <button
              key={i}
              type="button"
              onClick={run(item.onClick)}
              className={cn(
                // Identical metrics to the canvas context menu — one menu vocabulary in the app.
                'flex h-[34px] w-full items-center gap-2.5 rounded-[10px] px-2.5 text-left text-[13px] transition-colors',
                item.danger
                  ? 'text-[var(--destructive)] hover:bg-[color-mix(in_srgb,var(--destructive)_12%,transparent)]'
                  : 'text-text-1 hover:bg-glass-hover',
              )}
            >
              <Icon
                name={item.icon}
                size={15}
                className={cn('shrink-0', item.danger ? 'text-[var(--destructive)]' : 'text-text-2')}
              />
              <span className="flex-1 truncate">{item.label}</span>
            </button>
          ),
        )}
      </div>
    </>,
    document.body,
  )
}
