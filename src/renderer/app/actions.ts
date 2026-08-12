import type { PanelType } from '@shared/domain/panel'
import type { Point } from '@shared/domain/geometry'
import { screenToWorld } from '@shared/domain/geometry'
import { usePanelStore } from '@/stores/usePanelStore'
import { useViewportStore } from '@/stores/useViewportStore'
import { useSettingsStore } from '@/stores/useSettingsStore'

/** Apply settings-driven defaults to a freshly created panel (e.g. browser homepage). */
function applyCreateDefaults(id: string, type: PanelType): void {
  if (type === 'browser') {
    const homepage = useSettingsStore.getState().settings.browser.homepage
    if (homepage && homepage !== 'about:blank') {
      usePanelStore.getState().updateProps<'browser'>(id, { url: homepage })
    }
  }
}

/** Add a panel at a specific world point (e.g. where the user right-clicked). */
export function addPanelAtWorld(type: PanelType, world: Point): string {
  const id = usePanelStore.getState().addPanel(type, world)
  applyCreateDefaults(id, type)
  return id
}

/** Add a panel centered in the current viewport. */
export function addPanelAtCenter(type: PanelType): string {
  const { x, y, zoom } = useViewportStore.getState()
  const center = screenToWorld(
    { x: window.innerWidth / 2, y: window.innerHeight / 2 },
    { x, y, zoom },
  )
  const id = usePanelStore.getState().addPanel(type, center)
  applyCreateDefaults(id, type)
  return id
}

/** Open a new terminal panel rooted at a folder (used by the Files panel's context menu). */
export function openTerminalAt(cwd: string): string {
  const id = addPanelAtCenter('terminal')
  usePanelStore.getState().updateProps<'terminal'>(id, { cwd })
  return id
}

/**
 * Open a Files (editor) panel rooted at `folderPath`, centered in the viewport. Used when a
 * project opens so the canvas shows that folder's tree — never an empty "No folder open"
 * panel. Uses the unified 'editor' type (the modern Files panel), not the legacy 'files'.
 */
export function openFilesPanel(folderPath: string): string {
  const id = addPanelAtCenter('editor')
  usePanelStore.getState().updateProps<'editor'>(id, { folderPath, sidebarOpen: true })
  return id
}

/** Size a Files panel spawns at when a dropped file opens straight into the editor / image
 *  preview (matches the editor panel's default size — file opens never resize the panel). */
const DROP_OPEN_SIZE = { width: 880, height: 600 }

/** OS-agnostic parent directory of an absolute path (undefined at a filesystem root). */
function parentDir(p: string): string | undefined {
  const norm = p.replace(/[\\/]+$/, '')
  const idx = Math.max(norm.lastIndexOf('/'), norm.lastIndexOf('\\'))
  if (idx < 0) return undefined
  if (idx === 0) return norm.slice(0, 1) // "/file" → "/"
  const parent = norm.slice(0, idx)
  return /^[A-Za-z]:$/.test(parent) ? `${parent}\\` : parent // "C:" → "C:\"
}

/**
 * Open a file/folder dragged from the OS onto the canvas, at the drop point. A folder opens as
 * a compact Files explorer rooted there; a file opens a Files panel already grown into the
 * editor / image preview, with its parent folder in the sidebar tree — a normal IDE view.
 */
export function openDroppedPath(path: string, kind: 'file' | 'directory', world: Point): string {
  const store = usePanelStore.getState()
  const id = store.addPanel('editor', world)
  if (kind === 'directory') {
    store.updateProps<'editor'>(id, { folderPath: path, sidebarOpen: true })
    return id
  }
  store.updateProps<'editor'>(id, { folderPath: parentDir(path), filePath: path, sidebarOpen: true })
  const { width, height } = DROP_OPEN_SIZE
  store.resizePanel(id, { x: world.x - width / 2, y: world.y - height / 2, width, height })
  return id
}

/**
 * Center the viewport on one panel and raise it to the front — the "jump to" used by the agent
 * manager. A docked panel has a stale rect (its group owns the real one), so frame and raise the
 * group instead. No-op if the panel isn't on the live canvas (caller switches space first).
 */
export function focusPanel(panelId: string): void {
  const store = usePanelStore.getState()
  let target = store.panels[panelId]
  if (!target) return
  if (target.dockedIn) {
    const group = store.panels[target.dockedIn]
    if (group) target = group
  }
  store.bringToFront(target.id)
  useViewportStore
    .getState()
    .focusRect(target.rect, { width: window.innerWidth, height: window.innerHeight })
}

/** Fit every panel into view (Zoom to fit). Docked panels have a stale rect — the group holds the
 *  real rect — so skip them. */
export function zoomToFitAll(): void {
  const panels = Object.values(usePanelStore.getState().panels).filter((p) => !p.dockedIn)
  useViewportStore.getState().zoomToFit(
    panels.map((p) => p.rect),
    { width: window.innerWidth, height: window.innerHeight },
  )
}
