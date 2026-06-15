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
 * scaled/clipped by the canvas transform. Copy actions feed paths to a running terminal
 * (paste with Ctrl/Cmd+V) without leaving PLANO.
 */
export function TreeContextMenu({
  node,
  rootPath,
  x,
  y,
  onClose,
  onOpenFile,
  onOpenInTerminal,
}: {
  node: FsNode
  rootPath: string
  x: number
  y: number
  onClose: () => void
  onOpenFile: (node: FsNode) => void
  onOpenInTerminal: (cwd: string) => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const copy = (text: string) => (): void => void window.plano.clipboard.writeText(text)
  const isDir = node.type === 'directory'
  const terminalCwd = isDir ? node.path : dirName(node.path)

  const items: Array<MenuItem | 'separator'> = [
    ...(isDir
      ? []
      : [{ label: 'Open', icon: 'FileSymlink', onClick: () => onOpenFile(node) } as MenuItem]),
    { label: 'Open in Terminal', icon: 'SquareTerminal', onClick: () => onOpenInTerminal(terminalCwd) },
    'separator',
    { label: 'Copy Path', icon: 'Copy', onClick: copy(node.path) },
    { label: 'Copy Relative Path', icon: 'Copy', onClick: copy(relativePath(rootPath, node.path)) },
    { label: 'Copy Name', icon: 'Copy', onClick: copy(node.name) },
    'separator',
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
        className="fixed inset-0 z-[70]"
        onPointerDown={onClose}
        onContextMenu={(e) => {
          e.preventDefault()
          onClose()
        }}
      />
      <div
        className="animate-menu-in fixed z-[71] origin-top-left rounded-md border bg-surface-3 p-1.5 shadow-popover"
        style={{ left, top: Math.max(8, top), width: MENU_WIDTH }}
        onContextMenu={(e) => e.preventDefault()}
      >
        {items.map((item, i) =>
          item === 'separator' ? (
            <div key={i} className="mx-1 my-1 h-px bg-[var(--border-subtle)]" />
          ) : (
            <button
              key={i}
              type="button"
              onClick={run(item.onClick)}
              className={cn(
                'flex h-8 w-full items-center gap-2.5 rounded-sm px-2 text-left text-[13px] transition-colors',
                'text-text-primary hover:bg-accent-soft',
              )}
            >
              <Icon name={item.icon} size={15} className="text-text-secondary" />
              <span className="flex-1">{item.label}</span>
            </button>
          ),
        )}
      </div>
    </>,
    document.body,
  )
}
