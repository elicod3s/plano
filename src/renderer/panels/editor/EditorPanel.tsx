import { useEffect, useRef, useState } from 'react'
import type { Panel, EditorProps, FilesProps } from '@shared/domain/panel'
import type { FsNode } from '@shared/ipc/contracts'
import { usePanelStore } from '@/stores/usePanelStore'
import { openTerminalAt } from '@/app/actions'
import { Icon } from '@/design-system/Icon'
import { IconButton } from '@/design-system/IconButton'
import { cn } from '@/lib/cn'
import { useCodeMirror } from './useCodeMirror'
import { FileTree } from './FileTree'

const TREE_DEPTH = 5
const SIDEBAR_W = 200
/** Size the panel grows to when a file is opened (it collapses back when closed). */
const EXPANDED = { width: 880, height: 600 }
const COMPACT = { width: 300, height: 480 }

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

/**
 * The unified "Files" panel: an infinite-canvas file explorer that opens code, text and
 * images inline. It starts compact (tree-only); opening a file grows it and the tree
 * collapses to a left sidebar beside the editor / image preview — no second window.
 */
export function EditorPanel({ panel }: { panel: Panel }) {
  // Accept either the editor props or a (pre-migration) File Explorer panel's rootPath.
  const props = panel.props as EditorProps & Partial<FilesProps>
  const updateProps = usePanelStore((s) => s.updateProps)
  const setTitle = usePanelStore((s) => s.setTitle)
  const resize = usePanelStore((s) => s.resizePanel)

  const folderPath = props.folderPath ?? props.rootPath
  const activePath = props.filePath
  const sidebarOpen = props.sidebarOpen ?? true
  const isFile = !!activePath
  const activeIsImage = isFile && isImagePath(activePath as string)

  const [root, setRoot] = useState<FsNode | null>(null)
  const [fileDoc, setFileDoc] = useState<{ path: string; content: string } | null>(null)
  // `url: ''` is the "load failed" sentinel — keeps the path settled so we don't hang on "Loading…".
  const [image, setImage] = useState<{ path: string; url: string } | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const dirtyRef = useRef(false)
  const valueRef = useRef('')

  // Load / refresh the folder tree whenever the editor's root changes.
  useEffect(() => {
    if (!folderPath) {
      setRoot(null)
      return
    }
    let cancelled = false
    setRoot(null)
    window.plano.fs
      .readTree({ dir: folderPath, depth: TREE_DEPTH })
      .then((r) => !cancelled && setRoot(r.root))
      .catch(() => !cancelled && setRoot(null))
    return () => {
      cancelled = true
    }
  }, [folderPath])

  // Load the active file from disk (text → CodeMirror, image → data URL preview).
  useEffect(() => {
    dirtyRef.current = false
    setDirty(false)
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
        .then((r) => !cancelled && setImage({ path, url: `data:${r.mime};base64,${r.base64}` }))
        .catch(() => !cancelled && setImage({ path, url: '' }))
    } else {
      setImage(null)
      window.plano.fs
        .readFile({ path })
        .then((r) => {
          if (cancelled) return
          setFileDoc({ path, content: r.content })
          valueRef.current = r.content
        })
        .catch(() => {
          if (cancelled) return
          setFileDoc({ path, content: '' })
          valueRef.current = ''
        })
    }
    return () => {
      cancelled = true
    }
  }, [activePath])

  const openFolder = async (): Promise<void> => {
    const { folderPath: picked } = await window.plano.fs.pickFolder()
    if (!picked) return
    updateProps<'editor'>(panel.id, { folderPath: picked })
    if (!isFile) setTitle(panel.id, baseName(picked))
  }

  const guardDirty = (): boolean =>
    !dirtyRef.current || window.confirm('Discard unsaved changes to this file?')

  const openFile = (node: FsNode): void => {
    if (node.path === activePath || !guardDirty()) return
    const firstOpen = !isFile
    updateProps<'editor'>(panel.id, { filePath: node.path })
    setTitle(panel.id, node.name)
    // Grow the panel so the editor has room (the explorer collapses to a sidebar).
    if (firstOpen) {
      const { x, y, width, height } = panel.rect
      if (width < EXPANDED.width || height < EXPANDED.height) {
        resize(panel.id, {
          x,
          y,
          width: Math.max(width, EXPANDED.width),
          height: Math.max(height, EXPANDED.height),
        })
      }
    }
  }

  const closeFile = (): void => {
    if (!guardDirty()) return
    updateProps<'editor'>(panel.id, { filePath: undefined })
    setTitle(panel.id, folderPath ? baseName(folderPath) : 'Files')
    // Collapse back to the compact explorer.
    resize(panel.id, { x: panel.rect.x, y: panel.rect.y, ...COMPACT })
  }

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
    setSaving(true)
    try {
      await window.plano.fs.writeFile({ path: activePath, content: value ?? valueRef.current })
      dirtyRef.current = false
      setDirty(false)
    } finally {
      setSaving(false)
    }
  }

  const showSidebar = !isFile || sidebarOpen
  // The active file's content hasn't caught up to `activePath` yet → show a spinner.
  const contentStale =
    isFile && (activeIsImage ? image?.path !== activePath : fileDoc?.path !== activePath)

  return (
    <div className="flex h-full w-full bg-surface-1">
      {/* explorer / sidebar */}
      {showSidebar && (
        <div
          className={cn('flex shrink-0 flex-col bg-surface-1', isFile && 'border-r border-subtle')}
          style={{ width: isFile ? SIDEBAR_W : '100%' }}
        >
          <div className="flex h-8 shrink-0 items-center justify-between gap-1 border-b border-subtle px-2.5">
            <span className="label-caps truncate text-text-tertiary">
              {folderPath ? baseName(folderPath) : 'Explorer'}
            </span>
            {folderPath && (
              <IconButton icon="FolderOpen" label="Open another folder" size={22} onClick={openFolder} />
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {folderPath ? (
              <FileTree
                root={root}
                rootPath={folderPath}
                activePath={activePath}
                onOpenFile={openFile}
                onOpenInTerminal={openTerminalAt}
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

      {/* editor / preview */}
      {isFile && (
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-8 shrink-0 items-center gap-0.5 border-b border-subtle bg-surface-2 px-1.5">
            <IconButton
              icon="PanelLeft"
              label={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
              size={24}
              active={sidebarOpen}
              onClick={toggleSidebar}
            />
            <div className="flex min-w-0 flex-1 items-center gap-1.5 px-1">
              <Icon name={activeIsImage ? 'Image' : 'File'} size={13} className="shrink-0 text-text-tertiary" />
              <span className="truncate text-[12px] text-text-secondary">{baseName(activePath as string)}</span>
              {dirty && <span className="h-1.5 w-1.5 shrink-0 rounded-pill bg-text-tertiary" />}
              <IconButton icon="X" label="Close file" size={20} onClick={closeFile} />
            </div>
            {!activeIsImage && (
              <IconButton
                icon="Save"
                label={saving ? 'Saving…' : 'Save (Ctrl+S)'}
                size={24}
                active={dirty}
                disabled={saving || !dirty}
                onClick={() => void save()}
              />
            )}
          </div>

          <div className="relative min-h-0 flex-1">
            {contentStale ? (
              <div className="flex h-full items-center justify-center text-[13px] text-text-tertiary">Loading…</div>
            ) : activeIsImage ? (
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
                <div className="flex h-full items-center justify-center text-[13px] text-text-tertiary">
                  Can’t preview this image.
                </div>
              )
            ) : (
              <EditorMount
                key={activePath}
                doc={fileDoc?.content ?? ''}
                filePath={activePath}
                onChange={handleChange}
                onSave={(v) => void save(v)}
              />
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function EditorMount({
  doc,
  filePath,
  onChange,
  onSave,
}: {
  doc: string
  filePath?: string
  onChange: (value: string) => void
  onSave?: (value: string) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useCodeMirror(ref, { doc, filePath, onChange, onSave })
  return <div ref={ref} className="h-full w-full overflow-hidden bg-surface-1" />
}
