import { memo, useCallback, useState } from 'react'
import type { FsNode } from '@shared/ipc/contracts'
import { Icon } from '@/design-system/Icon'
import { cn } from '@/lib/cn'
import { FileTypeIcon } from './fileIcons'
import { TreeContextMenu } from './TreeContextMenu'

interface MenuState {
  node: FsNode
  x: number
  y: number
}

/** Collapsible file tree for the Files panel sidebar. Files open in the editor pane; the
 *  active file is highlighted. Right-click a node for path/copy/reveal actions.
 *
 *  Memoized: while a Files panel is dragged across the canvas its `panel` reference changes
 *  every pointer tick, re-rendering EditorPanel — but the tree's inputs (root, activePath,
 *  the stable onOpenFile/onOpenInTerminal callbacks) don't change, so this whole subtree
 *  (potentially hundreds of TreeNodes) is skipped. That's what keeps a deep, expanded tree
 *  smooth to move. For the bail-out to hold, EditorPanel must pass STABLE callbacks. */
function FileTreeInner({
  root,
  rootPath,
  activePath,
  onOpenFile,
  onOpenInTerminal,
}: {
  root: FsNode | null
  rootPath: string
  activePath?: string
  onOpenFile: (node: FsNode) => void
  onOpenInTerminal: (cwd: string) => void
}) {
  const [menu, setMenu] = useState<MenuState | null>(null)

  // Stable so the memoized TreeNodes don't re-render when the tree re-renders for an
  // unrelated reason (e.g. the active file changing).
  const openMenu = useCallback((node: FsNode, e: React.MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ node, x: e.clientX, y: e.clientY })
  }, [])

  if (!root) {
    return <div className="px-3 py-2 text-[12px] text-text-tertiary">Loading…</div>
  }
  if (!root.children?.length) {
    return <div className="px-3 py-2 text-[12px] text-text-tertiary">This folder is empty.</div>
  }
  return (
    <div className="py-1" style={{ userSelect: 'none' }}>
      {root.children.map((child) => (
        <TreeNode
          key={child.path}
          node={child}
          depth={0}
          activePath={activePath}
          onOpenFile={onOpenFile}
          onContextMenu={openMenu}
        />
      ))}
      {menu && (
        <TreeContextMenu
          node={menu.node}
          rootPath={rootPath}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          onOpenFile={onOpenFile}
          onOpenInTerminal={onOpenInTerminal}
        />
      )}
    </div>
  )
}

export const FileTree = memo(FileTreeInner)

// Memoized so when the tree DOES re-render (folder expand, active-file change) only the
// branches whose props actually changed reconcile — not every node. The recursive call below
// uses the memoized `TreeNode` const (not the inner function name) so the bail-out propagates
// down the tree.
const TreeNode = memo(function TreeNodeRow({
  node,
  depth,
  activePath,
  onOpenFile,
  onContextMenu,
}: {
  node: FsNode
  depth: number
  activePath?: string
  onOpenFile: (node: FsNode) => void
  onContextMenu: (node: FsNode, e: React.MouseEvent) => void
}) {
  const [open, setOpen] = useState(depth < 1)
  const isDir = node.type === 'directory'
  const isActive = !isDir && node.path === activePath

  return (
    <div>
      <button
        type="button"
        onClick={() => (isDir ? setOpen((o) => !o) : onOpenFile(node))}
        onContextMenu={(e) => onContextMenu(node, e)}
        className={cn(
          'flex h-7 w-full items-center gap-1.5 rounded-sm pr-2 text-left text-[13px] transition-colors',
          isActive
            ? 'bg-accent-soft-strong text-text-primary'
            : 'text-text-secondary hover:bg-accent-soft hover:text-text-primary',
        )}
        style={{ paddingLeft: 8 + depth * 12 }}
      >
        {isDir ? (
          <Icon name={open ? 'ChevronDown' : 'ChevronRight'} size={13} className="shrink-0 text-text-tertiary" />
        ) : (
          <span className="w-[13px] shrink-0" />
        )}
        {isDir ? (
          <Icon name={open ? 'FolderOpen' : 'Folder'} size={14} className="shrink-0 text-text-tertiary" />
        ) : (
          <FileTypeIcon name={node.name} size={14} className="shrink-0 text-text-tertiary" />
        )}
        <span className="truncate">{node.name}</span>
      </button>
      {isDir &&
        open &&
        node.children?.map((child) => (
          <TreeNode
            key={child.path}
            node={child}
            depth={depth + 1}
            activePath={activePath}
            onOpenFile={onOpenFile}
            onContextMenu={onContextMenu}
          />
        ))}
    </div>
  )
})
