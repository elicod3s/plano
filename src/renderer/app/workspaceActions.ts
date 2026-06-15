import { SCHEMA_VERSION, createSpace, type WorkspaceDoc } from '@shared/domain/workspace'
import { usePanelStore } from '@/stores/usePanelStore'
import { useViewportStore } from '@/stores/useViewportStore'
import { useWorkspaceStore } from '@/stores/useWorkspaceStore'
import { useSpacesStore } from '@/stores/useSpacesStore'
import { newId } from '@/lib/id'

/** Copy the live canvas (panels + camera) back into the active space's snapshot. */
function flushCanvasToActive(): void {
  const { activeId } = useSpacesStore.getState()
  if (!activeId) return
  const panels = Object.values(usePanelStore.getState().panels)
  const { x, y, zoom } = useViewportStore.getState()
  useSpacesStore.getState().writeBack(activeId, panels, { x, y, zoom })
}

/** Load the active space's snapshot into the live canvas stores. */
function loadActiveIntoCanvas(): void {
  const { spaces, activeId } = useSpacesStore.getState()
  const space = spaces.find((s) => s.id === activeId) ?? spaces[0]
  if (!space) return
  usePanelStore.getState().replaceAll(space.panels)
  useViewportStore.getState().setTransform(space.viewport)
}

/** Build the persisted document from current renderer state. */
function buildDoc(): WorkspaceDoc {
  flushCanvasToActive()
  const { spaces, activeId } = useSpacesStore.getState()
  const name = useWorkspaceStore.getState().name
  return {
    schemaVersion: SCHEMA_VERSION,
    savedAt: new Date().toISOString(),
    meta: { name },
    activeSpaceId: activeId ?? spaces[0]?.id ?? '',
    spaces,
  }
}

/** Load a workspace from disk and hydrate the renderer stores. */
export async function loadWorkspace(folderPath: string): Promise<void> {
  useWorkspaceStore.getState().setStatus('loading')
  const res = await window.plano.workspace.open({ folderPath })
  const doc = res.workspace
  useSpacesStore.getState().hydrate(doc.spaces, doc.activeSpaceId)
  loadActiveIntoCanvas()
  useWorkspaceStore.getState().setWorkspace({ folderPath: res.folderPath, name: doc.meta.name })
}

/** Native folder picker → open that workspace. */
export async function openFolder(): Promise<void> {
  const { folderPath } = await window.plano.workspace.pickFolder()
  if (folderPath) await loadWorkspace(folderPath)
}

/** Persist the current workspace (no-op until a folder is open). */
export async function saveCurrent(): Promise<void> {
  const ws = useWorkspaceStore.getState()
  if (!ws.folderPath) return
  const result = await window.plano.workspace.save({ folderPath: ws.folderPath, workspace: buildDoc() })
  useWorkspaceStore.getState().markSaved(result.savedAt)
}

/** Switch the live canvas to another space (flushing the current one first). */
export function switchSpace(id: string): void {
  const { activeId, spaces } = useSpacesStore.getState()
  if (id === activeId || !spaces.some((s) => s.id === id)) return
  flushCanvasToActive()
  useSpacesStore.getState().setActiveId(id)
  loadActiveIntoCanvas()
  void saveCurrent()
}

/** Create a fresh blank space and switch to it. Returns its id. */
export function createNewSpace(): string {
  flushCanvasToActive()
  const count = useSpacesStore.getState().spaces.length
  const space = createSpace(newId(), `Workspace ${count + 1}`)
  useSpacesStore.getState().add(space)
  useSpacesStore.getState().setActiveId(space.id)
  loadActiveIntoCanvas()
  void saveCurrent()
  return space.id
}

/** Rename a space. */
export function renameSpace(id: string, name: string): void {
  const trimmed = name.trim()
  if (!trimmed) return
  useSpacesStore.getState().rename(id, trimmed)
  void saveCurrent()
}

/** Delete a space (keeps at least one; re-activates a neighbor if the active one goes). */
export function deleteSpace(id: string): void {
  const { spaces, activeId } = useSpacesStore.getState()
  if (spaces.length <= 1) return
  const idx = spaces.findIndex((s) => s.id === id)
  if (idx < 0) return
  const wasActive = id === activeId
  useSpacesStore.getState().remove(id)
  if (wasActive) {
    const remaining = useSpacesStore.getState().spaces
    const next = remaining[Math.min(idx, remaining.length - 1)]
    useSpacesStore.getState().setActiveId(next.id)
    loadActiveIntoCanvas()
  }
  void saveCurrent()
}
