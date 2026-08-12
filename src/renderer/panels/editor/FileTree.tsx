import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from 'react'
import type { FsDirEntry, FsNode } from '@shared/ipc/contracts'
import { Icon } from '@/design-system/Icon'
import { cn } from '@/lib/cn'
import { FileTypeIcon } from './fileIcons'
import { TreeContextMenu } from './TreeContextMenu'
import { loadDirectory, subscribe, getVersion, getDirectory } from '@/stores/useFileTreeStore'

// ── Narrow active-file atom ──────────────────────────────────────────────────
// Each row subscribes to a BOOLEAN derived from its OWN path (`activeByPanel[panelId] === path`),
// never to the full activePath. A file switch therefore re-renders exactly the old and new
// active rows — every other memoized row's snapshot is unchanged and bails out.
const activeByPanel = new Map<string, string | undefined>()
const activeListeners = new Set<() => void>()

/** EditorPanel reports its panel's active file here (per PANEL, so two panels rooted at the
 *  same folder can highlight different files). */
export function setActiveFile(panelId: string, activePath: string | undefined): void {
  if (activeByPanel.get(panelId) === activePath) return
  activeByPanel.set(panelId, activePath)
  for (const listener of activeListeners) listener()
}

function subscribeActive(listener: () => void): () => void {
  activeListeners.add(listener)
  return () => {
    activeListeners.delete(listener)
  }
}

function useIsActive(panelId: string, path: string): boolean {
  return useSyncExternalStore(subscribeActive, () => activeByPanel.get(panelId) === path, () => false)
}

interface MenuState {
  node: FsNode
  x: number
  y: number
  /** True for the synthetic root entry (right-click on empty space) — no rename/delete. */
  isRoot: boolean
}

/** A pending "New File / New Folder" inline input inside `parent`. */
interface DraftState {
  parent: string
  type: 'file' | 'directory'
}

/** A disk change performed from the tree — the panel reacts (refresh, fix the open file). */
export type TreeMutation =
  | { kind: 'created'; path: string; type: 'file' | 'directory' }
  | { kind: 'renamed'; from: string; to: string }
  | { kind: 'deleted'; path: string }

export interface FileTreeHandle {
  /** Start an inline "New File" / "New Folder" input at the tree root (header buttons). */
  startCreate(type: 'file' | 'directory'): void
}

/** Last path segment, OS-agnostic. */
function baseName(p: string): string {
  const segments = p.split(/[\\/]/).filter(Boolean)
  return segments[segments.length - 1] ?? p
}

/** Strip Electron's invoke-rejection prefix so the user sees only the real message. */
function ipcErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return raw.replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, '') || 'Something went wrong.'
}

/** Per-level name filter (P0): keeps rows whose name contains the query. Matching directories
 *  auto-load below so the user can drill into them. Global deep search is a P1 endpoint. */
function filterEntries(entries: FsDirEntry[] | null, query: string): FsDirEntry[] | null {
  if (!entries) return null
  const q = query.trim().toLowerCase()
  if (!q) return entries
  const out = entries.filter((e) => e.name.toLowerCase().includes(q))
  return out.length === entries.length ? entries : out
}

/** One visible row in the FLATTENED, virtualized tree (plan C5). */
interface FlatRow {
  key: string
  path: string
  name: string
  type: 'file' | 'directory'
  depth: number
  /** Inline "New File/Folder" input row rendered under this directory. */
  kind?: 'draft'
  /** The tree root row — always expanded, never collapsible. */
  root?: boolean
}

/** Fixed row height in px — the virtualization window is computed from it. */
const ROW_H = 30
const OVERSCAN = 12

interface FileTreeProps {
  /** Panel identity — scopes the active-row atom (per-panel highlight). */
  panelId: string
  rootPath: string
  onOpenFile: (node: FsNode) => void
  onOpenInTerminal: (cwd: string) => void
  onMutated: (mutation: TreeMutation) => void
  /** When non-empty, rows are filtered to matching names and matching dirs force-expand. */
  filterQuery?: string
  /** The tree's scroll container (owned by EditorPanel) — drives the virtual window. */
  scrollRef?: RefObject<HTMLDivElement | null>
}

/**
 * Lazy collapsible file tree for the Files panel sidebar. Directory rows read ONE shallow
 * listing from the SHARED per-directory store on expansion — no recursive walk, no snapshot
 * tree. The expanded tree is FLATTENED to a row list and VIRTUALIZED (plan C5): only the
 * viewport window + overscan rows are mounted, so a project with thousands of expanded rows
 * costs ~40 mounted rows instead of thousands of DOM nodes inside the world layer.
 *
 * Memoized: while a Files panel is dragged across the canvas its `panel` reference changes
 * every pointer tick, re-rendering EditorPanel — but the tree's props (panelId, rootPath, the
 * stable callbacks) don't change, so this whole subtree is skipped. Directory loads re-derive
 * the flat list (cheap), and a file switch re-renders only the old/new active rows.
 */
const FileTreeInner = forwardRef<FileTreeHandle, FileTreeProps>(function FileTreeInner(
  { panelId, rootPath, onOpenFile, onOpenInTerminal, onMutated, filterQuery, scrollRef },
  ref,
) {
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [draft, setDraft] = useState<DraftState | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  // Expansion lives HERE (not per row) so the flat list can be derived from it (plan C5).
  const [expandedDirs, setExpandedDirs] = useState<ReadonlySet<string>>(() => new Set())

  const rootDir = getDirectory(rootPath)
  // Flat-list re-derivation key: bumps on ANY store emit (a dir loading/ready/invalidated).
  const version = useSyncExternalStore(subscribe, getVersion, () => 0)

  // Bounded filter (plan C2): a 1-character query only filters what is already loaded; deeper
  // auto-loads stop 2 levels below the root; at most 64 directories auto-load per query.
  const MIN_FILTER_LEN = 2
  const MAX_AUTO_LOAD_DIRS = 64
  const filterActive = (filterQuery ?? '').length >= MIN_FILTER_LEN
  const forceOpenDepth = filterActive ? 2 : 0
  const [budgetLeft, setBudgetLeft] = useState(MAX_AUTO_LOAD_DIRS)
  useEffect(() => {
    setBudgetLeft(MAX_AUTO_LOAD_DIRS)
  }, [filterQuery])
  const onAutoLoad = useCallback((): void => {
    setBudgetLeft((n) => Math.max(0, n - 1))
  }, [])

  const rootPathRef = useRef(rootPath)
  rootPathRef.current = rootPath

  useImperativeHandle(
    ref,
    () => ({
      startCreate: (type) => {
        setRenaming(null)
        setDraft({ parent: rootPathRef.current, type })
      },
    }),
    [],
  )

  // Stable so the memoized rows don't re-render when the tree re-renders for an
  // unrelated reason (e.g. a directory loading elsewhere).
  const openMenu = useCallback((node: FsNode, e: React.MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ node, x: e.clientX, y: e.clientY, isRoot: false })
  }, [])

  // Right-click on the empty space below the rows → actions on the root folder itself.
  const openRootMenu = (e: React.MouseEvent): void => {
    if (e.target !== e.currentTarget) return
    e.preventDefault()
    const node: FsNode = { name: baseName(rootPathRef.current), path: rootPathRef.current, type: 'directory' }
    setMenu({ node, x: e.clientX, y: e.clientY, isRoot: true })
  }

  const startDraft = useCallback((parent: string, type: 'file' | 'directory'): void => {
    setRenaming(null)
    setDraft({ parent, type })
  }, [])

  const startRename = useCallback((node: FsNode): void => {
    setDraft(null)
    setRenaming(node.path)
  }, [])

  const cancelDraft = useCallback((): void => setDraft(null), [])
  const cancelRename = useCallback((): void => setRenaming(null), [])
  const clearDraft = useCallback((): void => setDraft(null), [])

  const commitRename = useCallback(
    async (node: FsNode, newName: string): Promise<void> => {
      const r = await window.plano.fs.renameEntry({ path: node.path, newName })
      setRenaming(null)
      if (r.path !== node.path) onMutated({ kind: 'renamed', from: node.path, to: r.path })
    },
    [onMutated],
  )

  const requestDelete = useCallback(
    (node: FsNode): void => {
      const kind = node.type === 'directory' ? 'folder' : 'file'
      const ok = window.confirm(`Delete the ${kind} "${node.name}"?\nIt will be moved to the system trash.`)
      if (!ok) return
      window.plano.fs
        .deleteEntry({ path: node.path })
        .then(() => onMutated({ kind: 'deleted', path: node.path }))
        .catch((err) => window.alert(ipcErrorMessage(err)))
    },
    [onMutated],
  )

  const toggleDir = useCallback(
    (path: string): void => {
      setExpandedDirs((prev) => {
        const next = new Set(prev)
        if (next.has(path)) next.delete(path)
        else next.add(path)
        return next
      })
      // First open of a never-read directory → one shallow read.
      if (!expandedDirs.has(path) && getDirectory(path).entries === null) loadDirectory(path)
    },
    [expandedDirs],
  )

  // ── Virtual window ────────────────────────────────────────────────────────────
  const [scrollTop, setScrollTop] = useState(0)
  const [viewH, setViewH] = useState(600)
  useEffect(() => {
    const el = scrollRef?.current
    if (!el) return
    const onScroll = (): void => setScrollTop(el.scrollTop)
    const measure = (): void => setViewH(el.clientHeight)
    el.addEventListener('scroll', onScroll, { passive: true })
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    onScroll()
    measure()
    return () => {
      el.removeEventListener('scroll', onScroll)
      ro.disconnect()
    }
  }, [scrollRef])

  // ── Flatten the expanded tree into one row list (re-derived on store version) ──
  const flat = useMemo<FlatRow[]>(() => {
    const out: FlatRow[] = []
    const query = filterQuery ?? ''
    // The root is ALWAYS open (it IS the tree); every other directory opens on toggle or
    // while the filter force-expands it (bounded to forceOpenDepth).
    const visit = (path: string, name: string, depth: number, alwaysOpen: boolean): void => {
      out.push({ key: `d:${path}`, path, name, type: 'directory', depth, root: alwaysOpen })
      const snap = getDirectory(path)
      const open = alwaysOpen || depth < forceOpenDepth || expandedDirs.has(path)
      if (!open) return
      if (draft && draft.parent === path) {
        out.push({ key: `draft:${path}`, path, name: '', type: 'directory', depth: depth + 1, kind: 'draft' })
      }
      const entries = filterEntries(snap.entries, query)
      if (!entries) return
      for (const e of entries) {
        if (e.type === 'directory') {
          // Auto-load a matching dir when the filter wants it opened but it was never read
          // (bounded: forceOpenDepth + budget, plan C2).
          if (depth < forceOpenDepth && snap.status === 'idle' && budgetLeft > 0) {
            onAutoLoad()
            loadDirectory(e.path)
          }
          visit(e.path, e.name, depth + 1, false)
        } else {
          out.push({ key: `f:${e.path}`, path: e.path, name: e.name, type: 'file', depth: depth + 1 })
        }
      }
    }
    visit(rootPath, baseName(rootPath), 0, true)
    return out
  }, [version, rootPath, filterQuery, forceOpenDepth, budgetLeft, onAutoLoad, expandedDirs, draft])

  const total = flat.length
  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN)
  const end = Math.min(total, Math.ceil((scrollTop + viewH) / ROW_H) + OVERSCAN)
  const visible = flat.slice(start, end)

  const rootDraft = draft && draft.parent === rootPath ? draft : null

  return (
    <div className="min-h-full py-1" style={{ userSelect: 'none' }} onContextMenu={openRootMenu}>
      {rootDraft && (
        <NameInput
          depth={0}
          type={rootDraft.type}
          onCommit={async (name) => {
            const r = await window.plano.fs.createEntry({ dir: rootDraft.parent, name, type: rootDraft.type })
            setDraft(null)
            onMutated({ kind: 'created', path: r.path, type: rootDraft.type })
          }}
          onCancel={cancelDraft}
        />
      )}
      {total === 0 && (rootDir.status === 'idle' || (rootDir.status === 'loading' && rootDir.entries === null)) ? (
        // First-ever root read: the shell is already painted; only a small row appears after
        // ~100 ms — never a panel-wide loading gate.
        <RootLoading />
      ) : total === 0 && rootDir.status === 'error' ? (
        <div className="px-3 py-2 text-[12px] text-text-tertiary">Couldn’t read this folder.</div>
      ) : total === 0 ? (
        <div className="px-3 py-2 text-[12px] text-text-tertiary">This folder is empty.</div>
      ) : (
        <div style={{ height: total * ROW_H, position: 'relative' }}>
          {visible.map((row, i) => {
            const index = start + i
            return (
              <div key={row.key} style={{ position: 'absolute', top: index * ROW_H, left: 0, right: 0 }}>
                <VirtualRow
                  panelId={panelId}
                  row={row}
                  renaming={renaming}
                  draft={draft}
                  expandedDirs={expandedDirs}
                  onToggleDir={toggleDir}
                  onOpenFile={onOpenFile}
                  onContextMenu={openMenu}
                  onCommitRename={commitRename}
                  onCancelRename={cancelRename}
                  onCreateEntry={async (parent, name, type) => {
                    const r = await window.plano.fs.createEntry({ dir: parent, name, type })
                    clearDraft()
                    onMutated({ kind: 'created', path: r.path, type })
                  }}
                  onCancelDraft={cancelDraft}
                />
              </div>
            )
          })}
        </div>
      )}
      {filterActive && budgetLeft <= 0 && (
        <div className="px-3 py-1.5 text-[11.5px] text-text-4">Refine the filter to see more results</div>
      )}
      {menu && (
        <TreeContextMenu
          node={menu.node}
          rootPath={rootPath}
          x={menu.x}
          y={menu.y}
          isRoot={menu.isRoot}
          onClose={() => setMenu(null)}
          onOpenFile={onOpenFile}
          onOpenInTerminal={onOpenInTerminal}
          onNewEntry={startDraft}
          onRename={startRename}
          onDelete={requestDelete}
        />
      )}
    </div>
  )
})

export const FileTree = memo(FileTreeInner)

// ── Row rendering ──────────────────────────────────────────────────────────────
/** One flat virtualized row. A separate component so per-file rows can call the isActive
 *  hook (hooks are illegal inside the map in the parent). */
function VirtualRow({
  panelId,
  row,
  renaming,
  draft,
  expandedDirs,
  onToggleDir,
  onOpenFile,
  onContextMenu,
  onCommitRename,
  onCancelRename,
  onCreateEntry,
  onCancelDraft,
}: {
  panelId: string
  row: FlatRow
  renaming: string | null
  draft: DraftState | null
  expandedDirs: ReadonlySet<string>
  onToggleDir: (path: string) => void
  onOpenFile: (node: FsNode) => void
  onContextMenu: (node: FsNode, e: React.MouseEvent) => void
  onCommitRename: (node: FsNode, newName: string) => Promise<void>
  onCancelRename: () => void
  onCreateEntry: (parent: string, name: string, type: 'file' | 'directory') => Promise<void>
  onCancelDraft: () => void
}) {
  // The active atom is consulted for EVERY row (dirs never match it → false), so the hook
  // count is stable across renders even when a row enters/leaves rename/draft (React #300).
  const isActive = useIsActive(panelId, row.path)
  if (row.kind === 'draft' && draft) {
    return (
      <NameInput
        depth={row.depth}
        type={draft.type}
        onCommit={(name) => onCreateEntry(row.path, name, draft.type)}
        onCancel={onCancelDraft}
      />
    )
  }
  if (renaming === row.path) {
    return (
      <NameInput
        depth={row.depth}
        type={row.type}
        initial={row.name}
        onCommit={(newName) => onCommitRename({ path: row.path, name: row.name, type: row.type }, newName)}
        onCancel={onCancelRename}
      />
    )
  }
  const isDir = row.type === 'directory'
  return (
    <RowButton
      name={row.name}
      depth={row.depth}
      expanded={isDir && (row.root === true || expandedDirs.has(row.path))}
      isDir={isDir}
      isActive={isDir ? false : isActive}
      onClick={() => {
        if (isDir) {
          if (row.root === true) return // root is always open
          onToggleDir(row.path)
        } else {
          onOpenFile({ path: row.path, name: row.name, type: 'file' })
        }
      }}
      onContextMenu={(e) => onContextMenu({ path: row.path, name: row.name, type: row.type }, e)}
    />
  )
}

/** One flat virtualized row — a 30px button (folder chevron + icon + name). */
function RowButton({
  name,
  depth,
  expanded,
  isDir,
  isActive,
  onClick,
  onContextMenu,
}: {
  name: string
  depth: number
  expanded: boolean
  isDir: boolean
  isActive: boolean
  onClick: () => void
  onContextMenu: (e: React.MouseEvent) => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      onContextMenu={onContextMenu}
      className={cn(
        'flex h-[30px] w-full items-center gap-2 rounded-[10px] pr-2 text-left text-[13px] transition-colors focus-caliper',
        isDir ? 'text-text-2 hover:bg-glass hover:text-text-1' : isActive ? 'bg-glass text-text-1' : 'text-text-1 hover:bg-glass',
      )}
      style={{ paddingLeft: 6 + depth * 18 }}
    >
      {isDir ? (
        <Icon name={expanded ? 'ChevronDown' : 'ChevronRight'} size={12} className="shrink-0 text-text-4" />
      ) : (
        <span className="w-3 shrink-0" />
      )}
      {isDir ? (
        <Icon name={expanded ? 'FolderOpen' : 'Folder'} size={14} className="shrink-0 text-text-3" />
      ) : (
        <FileTypeIcon name={name} size={14} className="shrink-0 text-text-3" />
      )}
      <span className="truncate">{name}</span>
    </button>
  )
}

/** First-ever root read affordance — appears only after ~100 ms, in a single small row. */
function RootLoading() {
  const [show, setShow] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setShow(true), 100)
    return () => clearTimeout(t)
  }, [])
  if (!show) return null
  return (
    <div className="flex h-[30px] items-center gap-2 px-3 text-text-4">
      <span className="h-3 w-3 animate-spin rounded-full border border-text-quaternary border-t-transparent" />
      <span className="text-[11.5px]">Loading…</span>
    </div>
  )
}

/** Inline VS Code-style naming row (new entry / rename). Enter or blur commits, Escape
 *  cancels; a rejected commit keeps the input open and shows the error right below it. */
function NameInput({
  depth,
  type,
  initial,
  onCommit,
  onCancel,
}: {
  depth: number
  type: 'file' | 'directory'
  initial?: string
  onCommit: (name: string) => Promise<void>
  onCancel: () => void
}) {
  const [value, setValue] = useState(initial ?? '')
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])
  const commit = async (): Promise<void> => {
    const name = value.trim()
    if (!name) {
      onCancel()
      return
    }
    try {
      await onCommit(name)
    } catch (err) {
      setError(ipcErrorMessage(err))
    }
  }
  return (
    <div>
      <div className="flex h-[30px] items-center gap-2 pr-2" style={{ paddingLeft: 6 + depth * 18 }}>
        <Icon name={type === 'directory' ? 'Folder' : 'FileText'} size={14} className="shrink-0 text-text-3" />
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void commit()
            if (e.key === 'Escape') onCancel()
          }}
          onBlur={() => void commit()}
          spellCheck={false}
          className="h-[22px] min-w-0 flex-1 rounded-[6px] border border-glass-strong bg-inset px-1.5 font-mono text-[12.5px] text-text-1 focus:outline-none"
        />
      </div>
      {error && <div className="px-3 pb-1 text-[11px] text-status-danger">{error}</div>}
    </div>
  )
}
