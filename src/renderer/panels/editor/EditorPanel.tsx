import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Panel, EditorProps, FilesProps } from '@shared/domain/panel'
import type { FsDirEntry, FsNode } from '@shared/ipc/contracts'
import { usePanelStore } from '@/stores/usePanelStore'
import {
  getDirectory,
  invalidateDirectory,
  loadDirectory,
  optimisticPatch,
  useFileTreeDirectory,
} from '@/stores/useFileTreeStore'
import { openTerminalAt } from '@/app/actions'
import { Icon } from '@/design-system/Icon'
import { IconButton } from '@/design-system/IconButton'
import { cn } from '@/lib/cn'
import { fmtKeys } from '@/lib/hotkeys'
import { useCodeMirror } from './useCodeMirror'
import { isMarkdownFile } from './languages'
import { MarkdownPreview } from './MarkdownPreview'
import { FileTree, setActiveFile, type FileTreeHandle, type TreeMutation } from './FileTree'
import { FileTypeIcon } from './fileIcons'

const SIDEBAR_W = 200

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'])

/** Last path segment, OS-agnostic. */
function baseName(p: string): string {
  const segments = p.split(/[\\/]/).filter(Boolean)
  return segments[segments.length - 1] ?? p
}

function isImagePath(p: string): boolean {
  const ext = p.split('.').pop()?.toLowerCase()
  return ext ? IMAGE_EXT.has(ext) : false
}

/** True when `child` lives anywhere under the `parent` directory (OS-agnostic). */
function isPathInside(child: string, parent: string): boolean {
  return child.startsWith(parent + '\\') || child.startsWith(parent + '/')
}

/** Watch events are normalized by the main process, but persisted paths can retain old casing. */
function comparablePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLocaleLowerCase()
}

/** Parent directory of an absolute path (OS-agnostic); undefined at a filesystem root. */
function parentDirOf(p: string): string | undefined {
  const norm = p.replace(/[\\/]+$/, '')
  const idx = Math.max(norm.lastIndexOf('/'), norm.lastIndexOf('\\'))
  if (idx < 0) return undefined
  if (idx === 0) return norm.slice(0, 1) // "/file" → "/"
  const parent = norm.slice(0, idx)
  return /^[A-Za-z]:$/.test(parent) ? `${parent}\\` : parent // "C:" → "C:\"
}

/**
 * The unified "Files" panel: an infinite-canvas file explorer that opens code, text and
 * images inline. The tree paints its shell immediately and reads ONE shallow directory at a
 * time (shared per-directory store, lazy expansion — no depth-five snapshot). The editor is
 * a single persistent CodeMirror view per panel: opening a file swaps the buffer in place
 * (undo history + scroll preserved per file) and never resizes the panel.
 */
export function EditorPanel({ panel }: { panel: Panel }) {
  // Accept either the editor props or a (pre-migration) File Explorer panel's rootPath.
  const props = panel.props as EditorProps & Partial<FilesProps>
  const updateProps = usePanelStore((s) => s.updateProps)

  const folderPath = props.folderPath ?? props.rootPath
  const activePath = props.filePath
  const sidebarOpen = props.sidebarOpen ?? true
  const isFile = !!activePath
  const activeIsImage = isFile && isImagePath(activePath as string)
  const activeIsMarkdown = isFile && isMarkdownFile(activePath)
  const [markdownPreview, setMarkdownPreview] = useState(() => activeIsMarkdown)

  // File-tree filter (the design's Filter field) — debounced so matching dirs auto-load at
  // most once per pause while typing (lazy tree: filter force-expands matches).
  const [filterInput, setFilterInput] = useState('')
  const [filterQuery, setFilterQuery] = useState('')
  // A path whose dirty buffer the user explicitly discarded — the persistent editor purges it.
  const [discardedPath, setDiscardedPath] = useState<string | undefined>(undefined)
  // Monotonic read ids prevent a slower, older disk read from replacing a newer document.
  const fileReadRef = useRef(0)
  const treeRef = useRef<FileTreeHandle>(null)
  const treeScrollRef = useRef<HTMLDivElement>(null)
  const treeScrollPositionRef = useRef({ top: 0, left: 0 })
  const [fileDoc, setFileDoc] = useState<{ path: string; content: string } | null>(null)
  // `url: ''` is the "load failed" sentinel — keeps the path settled so we don't hang on "Loading…".
  const [image, setImage] = useState<{ path: string; url: string } | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const dirtyRef = useRef(false)
  /** Last content observed on disk, kept separate from the user's possibly-dirty editor value. */
  const diskValueRef = useRef('')
  const valueRef = useRef('')
  // Advances when disk content must enter the existing editor without remounting it.
  const [docRevision, setDocRevision] = useState(0)
  const [externalChange, setExternalChange] = useState(false)
  // Read inside the stable fs-watch subscription without re-subscribing on every file open.
  const activePathRef = useRef(activePath)
  activePathRef.current = activePath

  useEffect(() => {
    setMarkdownPreview(isMarkdownFile(activePath))
  }, [activePath])

  // Keep the file-tree highlight atom in sync with this panel's active file (per-panel key,
  // so two panels rooted at the same folder highlight independently).
  useEffect(() => {
    setActiveFile(panel.id, activePath)
    return () => setActiveFile(panel.id, undefined)
  }, [panel.id, activePath])

  // A consumed discard is forgotten after the commit (the editor's switch effect runs first).
  useEffect(() => {
    if (!discardedPath) return
    const timer = window.setTimeout(() => setDiscardedPath(undefined), 0)
    return () => window.clearTimeout(timer)
  }, [discardedPath])

  // Migrate stale auto-titles: earlier builds set the panel title to the open folder/file
  // name, duplicating the explorer sub-header (and the editor's own file tab). The title bar
  // is the panel's identity ("Files") now, so reset a leftover auto-derived title back. We
  // only match the exact folder/file basename, so a user's manual rename is left untouched.
  useEffect(() => {
    const auto = [folderPath, activePath].filter(Boolean).map((p) => baseName(p as string))
    if (auto.includes(panel.title)) usePanelStore.getState().setTitle(panel.id, 'Files')
    // Run once on mount — this only fixes titles persisted under the old behavior.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ONE shallow directory read per root — the ONLY tree request on the folder-open path.
  // The shell paints immediately; cached rows (if any) render right away and revalidate in
  // the background. Never a depth-five walk, never a panel-wide loading gate.
  const prevFolderRef = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (prevFolderRef.current !== folderPath) {
      prevFolderRef.current = folderPath
      treeScrollPositionRef.current = { top: 0, left: 0 }
    }
    if (!folderPath) return
    loadDirectory(folderPath)
  }, [folderPath])

  // Load the active file from disk (text → CodeMirror, image → data URL preview). A dirty
  // buffer in the persistent editor (possibly restored from the recent-doc cache) is never
  // clobbered: disk divergence is flagged for the user to reload instead.
  useEffect(() => {
    const readId = ++fileReadRef.current
    setExternalChange(false)
    if (!activePath) {
      setFileDoc(null)
      setImage(null)
      return
    }
    let cancelled = false
    const path = activePath
    if (isImagePath(path)) {
      setFileDoc(null)
      window.plano.fs
        .readBinaryFile({ path })
        .then((r) =>
          !cancelled && readId === fileReadRef.current && setImage({ path, url: `data:${r.mime};base64,${r.base64}` }),
        )
        .catch(() => !cancelled && readId === fileReadRef.current && setImage({ path, url: '' }))
    } else {
      setImage(null)
      window.plano.fs
        .readFile({ path })
        .then((r) => {
          if (cancelled || readId !== fileReadRef.current) return
          diskValueRef.current = r.content
          if (dirtyRef.current) {
            // Unsaved edits are in the editor — keep them; only flag a divergent disk.
            if (r.content !== valueRef.current) setExternalChange(true)
            return
          }
          applyDoc(path, r.content)
        })
        .catch(() => {
          if (cancelled || readId !== fileReadRef.current) return
          diskValueRef.current = ''
          if (!dirtyRef.current) applyDoc(path, '')
        })
    }
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePath])

  // Swap the editor buffer to fresh on-disk content (live-reload + the manual Reload action).
  // Stable identity so the fs-watch subscription below doesn't re-run on every keystroke.
  const applyDoc = useCallback((path: string, content: string): void => {
    setFileDoc({ path, content })
    diskValueRef.current = content
    valueRef.current = content
    dirtyRef.current = false
    setDirty(false)
    setExternalChange(false)
    setDocRevision((revision) => revision + 1)
  }, [])

  // Live folder watching: when the agent/terminal writes to disk, refresh the open file in
  // real time and patch ONLY the affected parent directories on structural events. The main
  // watcher is ref-counted + debounced; content edits never touch tree data at all.
  useEffect(() => {
    if (!folderPath) return
    const dir = folderPath
    let disposed = false
    let watching = false
    // Pair watch/unwatch even if this StrictMode effect is cleaned up before invoke resolves.
    void window.plano.fs.watch({ dir }).then((result) => {
      if (!result.ok) return
      watching = true
      if (disposed) void window.plano.fs.unwatch({ dir })
    })

    const unsub = window.plano.fs.onChanged((e) => {
      if (comparablePath(e.dir) !== comparablePath(dir)) return
      const changes = e.changes ?? []
      // Structural/unknown (add/delete/rename/dir) → invalidate only the affected parent
      // directories (coalesced by parent; shared single-flight in the store). Never a
      // full-tree scan. Content edits — the dominant AI-agent workload — issue nothing.
      if (changes.some((c) => c.kind !== 'content')) {
        const parents = new Set<string>()
        for (const c of changes) {
          if (c.kind === 'content') continue
          if (comparablePath(c.path) === comparablePath(dir)) {
            parents.add(dir) // the watched root itself changed (renamed/deleted)
            continue
          }
          parents.add(parentDirOf(c.path) ?? dir)
        }
        for (const parent of parents) invalidateDirectory(parent)
      }

      // Re-read the OPEN file ONLY when this change event actually names it (pre-glass
      // behavior). A structural event naming it (e.g. atomic temp-file + rename) reloads it too.
      const active = activePathRef.current
      if (!active) return
      const activeHit = changes.some((c) => comparablePath(c.path) === comparablePath(active))
      if (!activeHit) return
      const readId = ++fileReadRef.current
      if (isImagePath(active)) {
        window.plano.fs
          .readBinaryFile({ path: active })
          .then((r) => {
            if (!disposed && readId === fileReadRef.current && activePathRef.current === active)
              setImage({ path: active, url: `data:${r.mime};base64,${r.base64}` })
          })
          .catch(() => undefined)
        return
      }
      window.plano.fs
        .readFile({ path: active })
        .then((r) => {
          if (disposed || readId !== fileReadRef.current || activePathRef.current !== active) return
          if (r.content === diskValueRef.current) return
          diskValueRef.current = r.content
          if (dirtyRef.current) setExternalChange(true) // don't clobber unsaved edits — flag it
          else applyDoc(active, r.content)
        })
        .catch(() => undefined)
    })

    return () => {
      disposed = true
      unsub()
      if (watching) void window.plano.fs.unwatch({ dir })
    }
  }, [folderPath, applyDoc, invalidateDirectory])

  // Manually pull the latest on-disk content into the editor (offered when it changed under us).
  const reloadFromDisk = (): void => {
    if (!activePath) return
    if (dirtyRef.current && !window.confirm('Discard your unsaved changes and reload from disk?')) return
    void window.plano.fs
      .readFile({ path: activePath })
      .then((r) => applyDoc(activePath, r.content))
      .catch(() => undefined)
  }

  const openFolder = async (): Promise<void> => {
    const { folderPath: picked } = await window.plano.fs.pickFolder()
    if (!picked) return
    updateProps<'editor'>(panel.id, { folderPath: picked })
  }

  const guardDirty = (): boolean =>
    !dirtyRef.current || window.confirm('Discard unsaved changes to this file?')

  /** Explicitly discard the CURRENT file's unsaved buffer (the user confirmed). */
  const discardCurrent = (): void => {
    if (!dirtyRef.current) return
    setDiscardedPath(activePathRef.current)
    dirtyRef.current = false
    setDirty(false)
  }

  // Stable identity (deps are all stable across renders) so the memoized FileTree keeps its
  // bail-out while the panel is dragged. It must NOT close over `panel.rect`/`activePath`
  // (which change mid-drag / on open) — it reads the live panel from the store at call time.
  // Opening a file NEVER resizes the panel: it spawns at an editor-capable size already, so
  // the click path carries no layout mutation.
  const openFile = useCallback(
    (node: FsNode): void => {
      const current = usePanelStore.getState().panels[panel.id]
      if (!current) return
      const currentActive = (current.props as EditorProps).filePath
      // Toggle: clicking the already-open file closes its preview (back to the explorer),
      // same as the file tab's X — but never changes the panel rect.
      if (node.path === currentActive) {
        if (dirtyRef.current && !window.confirm('Discard unsaved changes to this file?')) return
        discardCurrent()
        updateProps<'editor'>(panel.id, { filePath: undefined })
        return
      }
      if (dirtyRef.current && !window.confirm('Discard unsaved changes to this file?')) return
      discardCurrent()
      updateProps<'editor'>(panel.id, { filePath: node.path })
    },
    [panel.id, updateProps],
  )

  const closeFile = (): void => {
    if (!guardDirty()) return
    discardCurrent()
    updateProps<'editor'>(panel.id, { filePath: undefined })
  }

  // A disk op performed from the tree (create/rename/delete): optimistically patch the
  // affected parent directory so the change is visible immediately, then revalidate that one
  // directory from disk. Keep the open file coherent: follow a rename, close a deleted file,
  // open a freshly created one. Stable (reads live state via refs/getState) so the memoized
  // FileTree keeps its bail-out.
  const handleTreeMutated = useCallback(
    (m: TreeMutation): void => {
      const parent = parentDirOf(m.kind === 'created' ? m.path : m.kind === 'renamed' ? m.from : m.path)
      if (parent) {
        const dir = getDirectory(parent)
        if (dir.entries) {
          let entries: FsDirEntry[]
          if (m.kind === 'created') {
            entries = dir.entries.some((e) => e.path === m.path)
              ? dir.entries
              : [...dir.entries, { name: baseName(m.path), path: m.path, type: m.type }]
          } else if (m.kind === 'renamed') {
            entries = dir.entries.map((e) =>
              e.path === m.from ? { ...e, name: baseName(m.to), path: m.to } : e,
            )
          } else {
            entries = dir.entries.filter((e) => e.path !== m.path)
          }
          optimisticPatch(parent, entries)
        }
        invalidateDirectory(parent)
      }

      const active = activePathRef.current
      if (m.kind === 'created') {
        if (m.type === 'file') openFile({ name: baseName(m.path), path: m.path, type: 'file' })
        return
      }
      if (m.kind === 'renamed') {
        if (!active) return
        if (active === m.from || isPathInside(active, m.from)) {
          // The open file moved — the old buffer is stale; discard it and re-read the new path.
          discardCurrent()
          updateProps<'editor'>(panel.id, { filePath: active === m.from ? m.to : m.to + active.slice(m.from.length) })
        }
        return
      }
      // deleted — the open file (or an ancestor folder) is gone; close the editor pane.
      if (active && (active === m.path || isPathInside(active, m.path))) {
        discardCurrent()
        updateProps<'editor'>(panel.id, { filePath: undefined })
      }
    },
    [panel.id, openFile, updateProps],
  )

  const toggleSidebar = (): void => updateProps<'editor'>(panel.id, { sidebarOpen: !sidebarOpen })

  const handleChange = (value: string): void => {
    valueRef.current = value
    if (!dirtyRef.current) {
      dirtyRef.current = true
      setDirty(true)
    }
  }

  const save = async (value?: string): Promise<void> => {
    if (!activePath || activeIsImage) return
    const content = value ?? valueRef.current
    setSaving(true)
    try {
      await window.plano.fs.writeFile({ path: activePath, content })
      diskValueRef.current = content
      dirtyRef.current = false
      setDirty(false)
      setExternalChange(false)
    } finally {
      setSaving(false)
    }
  }

  // Debounce the filter so a burst of keystrokes triggers at most one round of directory loads.
  useEffect(() => {
    const timer = window.setTimeout(() => setFilterQuery(filterInput), 150)
    return () => window.clearTimeout(timer)
  }, [filterInput])

  const showSidebar = !isFile || sidebarOpen
  // The active file's content hasn't caught up to `activePath` yet → subtle header progress.
  const contentStale =
    isFile && (activeIsImage ? image?.path !== activePath : fileDoc?.path !== activePath)

  // The root directory snapshot drives the tree's scroll-restore layout pass (content height
  // changes when the root loads, which would otherwise let scroll anchoring jump).
  const rootDir = useFileTreeDirectory(folderPath ?? '')
  useLayoutEffect(() => {
    const scroller = treeScrollRef.current
    if (!scroller) return
    const { top, left } = treeScrollPositionRef.current
    scroller.scrollTop = top
    scroller.scrollLeft = left
  }, [rootDir])

  return (
    // data-wheel-own: the tree, CodeMirror and image preview own the wheel here, so scrolling
    // their content scrolls it instead of panning/zooming the canvas underneath.
    <div className="flex h-full w-full bg-transparent" data-wheel-own>
      {/* explorer / sidebar */}
      {showSidebar && (
        <div
          className={cn('flex shrink-0 flex-col bg-transparent', isFile && 'border-r border-glass')}
          style={{ width: isFile ? SIDEBAR_W : '100%' }}
        >
          <div className="flex h-8 shrink-0 items-center justify-between gap-1 px-2">
            <span className="label-caps truncate text-text-4">
              {folderPath ? baseName(folderPath) : 'Explorer'}
            </span>
            {folderPath && (
              <div className="flex shrink-0 items-center gap-0.5">
                <IconButton
                  icon="FilePlus2"
                  label="New File"
                  size={24}
                  onClick={() => treeRef.current?.startCreate('file')}
                />
                <IconButton
                  icon="FolderPlus"
                  label="New Folder"
                  size={24}
                  onClick={() => treeRef.current?.startCreate('directory')}
                />
                <IconButton icon="FolderOpen" label="Open another folder" size={24} onClick={openFolder} />
              </div>
            )}
          </div>
          {/* filter field (design) */}
          {folderPath && (
            <div
              className="mx-3 mb-2 flex h-[34px] shrink-0 items-center gap-2.5 rounded-[11px] border border-glass px-3.5 transition-colors focus-within:border-glass-hover"
              style={{ background: 'var(--inset-soft)', boxShadow: '0 1px 6px rgba(0,0,0,0.5)' }}
            >
              <Icon name="Search" size={14} className="shrink-0 text-text-3" />
              <input
                value={filterInput}
                onChange={(e) => setFilterInput(e.target.value)}
                placeholder="Filter files"
                spellCheck={false}
                className="h-full w-full bg-transparent text-[13px] text-text-1 placeholder:text-text-3 focus:outline-none"
              />
              {filterInput && (
                <button
                  type="button"
                  aria-label="Clear filter"
                  onClick={() => setFilterInput('')}
                  className="shrink-0 text-text-3 transition-colors hover:text-text-1"
                >
                  <Icon name="X" size={12} />
                </button>
              )}
            </div>
          )}
          <div
            ref={treeScrollRef}
            className="min-h-0 flex-1 overflow-auto"
            style={{ overflowAnchor: 'none' }}
            onScroll={(event) => {
              treeScrollPositionRef.current = {
                top: event.currentTarget.scrollTop,
                left: event.currentTarget.scrollLeft,
              }
            }}
          >
            {folderPath ? (
              <FileTree
                ref={treeRef}
                panelId={panel.id}
                rootPath={folderPath}
                filterQuery={filterQuery}
                onOpenFile={openFile}
                onOpenInTerminal={openTerminalAt}
                onMutated={handleTreeMutated}
                scrollRef={treeScrollRef}
              />
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-3 px-5 text-center">
                <Icon name="FolderTree" size={22} className="text-text-tertiary" />
                <p className="text-[13px] text-text-tertiary">No folder open</p>
                <button
                  type="button"
                  onClick={openFolder}
                  className={cn(
                    'app-no-drag inline-flex items-center gap-1.5 rounded-pill border border-subtle bg-surface-2',
                    'px-3 py-1.5 text-[12px] text-text-secondary transition-colors focus-caliper',
                    'hover:border-strong hover:text-text-primary',
                  )}
                >
                  <Icon name="FolderOpen" size={14} />
                  Open Folder
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* editor / preview — always mounted (ONE persistent CodeMirror view per panel), hidden
          while no file is open so the sidebar takes the full width. The view survives file
          closes/switches; only its buffer and per-file config swap. */}
      <div className="flex min-w-0 flex-1 flex-col" style={isFile ? undefined : { display: 'none' }}>
        {isFile && (
          <div className="flex h-8 shrink-0 items-center gap-0.5 border-b border-subtle bg-surface-2 px-1.5">
            <IconButton
              icon="PanelLeft"
              label={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
              size={24}
              active={sidebarOpen}
              onClick={toggleSidebar}
            />
            <div className="flex min-w-0 flex-1 items-center gap-1.5 px-1">
              <FileTypeIcon name={baseName(activePath as string)} size={13} className="shrink-0 text-text-tertiary" />
              <span className="truncate text-[12px] text-text-secondary">{baseName(activePath as string)}</span>
              {dirty && <span className="h-1.5 w-1.5 shrink-0 rounded-pill bg-text-tertiary" />}
              {contentStale && (
                <Icon name="LoaderCircle" size={12} className="shrink-0 animate-spin text-text-4" />
              )}
              <IconButton icon="X" label="Close file" size={20} onClick={closeFile} />
            </div>
            {externalChange && !activeIsImage && (
              <button
                type="button"
                onClick={reloadFromDisk}
                title="This file changed on disk"
                className={cn(
                  'app-no-drag inline-flex shrink-0 items-center gap-1 rounded-pill px-2 py-0.5 text-[11px]',
                  'bg-accent-soft text-text-secondary transition-colors hover:bg-accent-soft-strong hover:text-text-primary',
                )}
              >
                <Icon name="RotateCw" size={12} />
                Reload
              </button>
            )}
            {activeIsMarkdown ? <MarkdownModeToggle preview={markdownPreview} onChange={setMarkdownPreview} /> : null}
            {!activeIsImage && (
              <IconButton
                icon="Save"
                label={saving ? 'Saving…' : `Save (${fmtKeys('Ctrl+S')})`}
                size={24}
                active={dirty}
                disabled={saving || !dirty}
                onClick={() => void save()}
              />
            )}
          </div>
        )}

        <div className="relative min-h-0 flex-1">
          {!contentStale && activeIsImage && (
            image?.url ? (
              <div className="flex h-full w-full items-center justify-center overflow-auto bg-surface-inset p-4">
                <img
                  src={image.url}
                  alt={baseName(activePath as string)}
                  className="max-h-full max-w-full object-contain"
                  style={{ imageRendering: 'auto' }}
                />
              </div>
            ) : (
              <div className="flex h-full w-full items-center justify-center text-[13px] text-text-tertiary">
                Can’t preview this image.
              </div>
            )
          )}
          {!contentStale && activeIsMarkdown && markdownPreview && (
            <MarkdownPreview
              source={dirty ? valueRef.current : fileDoc?.content ?? ''}
              filePath={activePath}
            />
          )}
          {/* The persistent editor sits under the previews (hidden while one replaces it) so
              the same CodeMirror DOM/view identity survives file switches AND mode toggles. */}
          <div
            className={cn(
              'h-full w-full overflow-hidden bg-transparent',
              (activeIsImage || (activeIsMarkdown && markdownPreview)) && 'hidden',
            )}
          >
            <EditorMount
              doc={fileDoc?.content ?? ''}
              docRevision={docRevision}
              filePath={activePath}
              onChange={handleChange}
              onSave={(v) => void save(v)}
              dirty={dirty}
              discardPath={discardedPath}
            />
          </div>
        </div>
      </div>
    </div>
  )
}

function MarkdownModeToggle({ preview, onChange }: { preview: boolean; onChange: (value: boolean) => void }) {
  return <div className='mx-1 flex items-center gap-0.5 border-l border-subtle pl-1'>
    <IconButton icon='Code2' label='Edit source' size={24} active={!preview}
      onClick={() => onChange(false)} />
    <IconButton icon='BookOpen' label='Read Markdown' size={24} active={preview}
      onClick={() => onChange(true)} />
  </div>
}

function EditorMount({
  doc,
  docRevision,
  filePath,
  onChange,
  onSave,
  dirty,
  discardPath,
}: {
  doc: string
  docRevision: number
  filePath?: string
  onChange: (value: string) => void
  onSave?: (value: string) => void
  dirty?: boolean
  discardPath?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  useCodeMirror(ref, { doc, docRevision, filePath, onChange, onSave, dirty, discardPath })
  return <div ref={ref} className="h-full w-full overflow-hidden bg-transparent" />
}
