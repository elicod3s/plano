import { SCHEMA_VERSION, createSpace, type Space, type WorkspaceDoc } from '@shared/domain/workspace'
import { usePanelStore } from '@/stores/usePanelStore'
import { useViewportStore } from '@/stores/useViewportStore'
import { useWorkspaceStore } from '@/stores/useWorkspaceStore'
import { useSpacesStore } from '@/stores/useSpacesStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useTerminalStore } from '@/stores/useTerminalStore'
import { confirm } from '@/stores/useConfirmStore'
import { openFilesPanel } from '@/app/actions'
import { killTerminalSessions, reconcileTerminalSessions } from '@/app/terminalSessions'
import { setAutosaveSuspended } from '@/app/autosave'
import { reconcileDocks } from '@/app/dockActions'
import { newId } from '@/lib/id'

/**
 * Workspace lifecycle. Each "workspace" (a `Space`) is an INDEPENDENT project: its own folder (or
 * none), its own canvas, and its own terminals. Switching between them is non-destructive — PTYs
 * persist in main, so another workspace's terminals keep running while it's backgrounded. Opening a
 * folder only ever affects ONE workspace; it never stops another's work.
 *
 * The source of truth is the app-global `<userData>/workspaces.json` (every open workspace + the
 * active one). Folder-bound workspaces are ALSO mirrored to their own `<folder>/.plano/workspace.json`
 * for portability and to import an existing project's layout when you open it.
 */

/** Last path segment of a folder (Windows or POSIX), for naming a workspace after its folder. */
function folderName(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '')
  const seg = trimmed.split(/[\\/]/).pop()
  return seg || p
}

/** Copy the live canvas (panels + camera) back into the active workspace's snapshot. */
function flushCanvasToActive(): void {
  const { activeId } = useSpacesStore.getState()
  if (!activeId) return
  const panels = Object.values(usePanelStore.getState().panels)
  const { x, y, zoom } = useViewportStore.getState()
  useSpacesStore.getState().writeBack(activeId, panels, { x, y, zoom })
}

/** Load the active workspace's snapshot into the live canvas stores. */
function loadActiveIntoCanvas(): void {
  const { spaces, activeId } = useSpacesStore.getState()
  let space = spaces.find((s) => s.id === activeId)
  if (!space) {
    // The active id fell out of the list — re-point it at a real workspace so a later flush
    // (keyed on activeId) can't silently no-op and drop the canvas.
    space = spaces[0]
    if (space) useSpacesStore.getState().setActiveId(space.id)
  }
  if (!space) return
  usePanelStore.getState().replaceAll(space.panels)
  // Repair any dock groups (drop missing panes, dissolve singletons, fix dockedIn flags).
  reconcileDocks()
  useViewportStore.getState().setTransform(space.viewport)
}

/**
 * Mutate the live canvas without tripping the debounced autosave. Switching/creating/deleting a
 * workspace replaces every panel, which would otherwise schedule a save of the *incoming* workspace
 * as if the user had edited it; we persist explicitly right after instead.
 */
function withAutosaveSuspended(fn: () => void): void {
  setAutosaveSuspended(true)
  try {
    fn()
  } finally {
    setAutosaveSuspended(false)
  }
}

/** How many of the given panels currently host a live terminal/agent session. (byPanel is keyed by
 *  terminal id — a panel may host several — so count panels via each runtime's panelId.) */
function liveTerminalCount(panelIds: Iterable<string>): number {
  const { byPanel } = useTerminalStore.getState()
  const livePanels = new Set(Object.values(byPanel).map((rt) => rt.panelId))
  let n = 0
  for (const id of panelIds) if (livePanels.has(id)) n += 1
  return n
}

/**
 * Record (or clear) the live "open project" pointer in main — kept best-effort for a possible
 * downgrade to an older build; the new launch path restores from the app-global state instead.
 */
function markSessionOpen(folderPath: string | null): void {
  void window.plano.session.set(folderPath).catch(() => undefined)
}

/** Mirror the ACTIVE workspace's folder + name into useWorkspaceStore (TopBar / git / terminal cwd). */
function syncActiveMeta(): void {
  const { spaces, activeId } = useSpacesStore.getState()
  const active = spaces.find((s) => s.id === activeId) ?? spaces[0]
  const folderPath = active?.folderPath ?? null
  useWorkspaceStore.getState().setWorkspace({ folderPath, name: active?.name ?? 'Workspace' })
  markSessionOpen(folderPath)
}

/**
 * Build the per-folder document for `folderPath` from EVERY open workspace that lives in it (usually
 * one, but migration can leave several sharing a folder). Writing them all keeps the folder file
 * complete so re-opening it elsewhere never silently drops a workspace.
 */
function buildFolderDoc(spaces: Space[], folderPath: string, activeId: string): WorkspaceDoc | null {
  const inFolder = spaces.filter((s) => s.folderPath === folderPath)
  if (inFolder.length === 0) return null
  const active = inFolder.find((s) => s.id === activeId) ?? inFolder[0]
  return {
    schemaVersion: SCHEMA_VERSION,
    savedAt: new Date().toISOString(),
    meta: { name: folderName(folderPath) },
    activeSpaceId: active.id,
    spaces: inFolder,
  }
}

/**
 * Persist the full set of open workspaces app-globally, and mirror the ACTIVE folder-bound one to
 * its own folder file (best-effort). Never throws into its callers (autosave is fire-and-forget).
 */
export async function saveCurrent(): Promise<void> {
  flushCanvasToActive()
  const { spaces, activeId } = useSpacesStore.getState()
  if (!activeId || spaces.length === 0) return
  try {
    const result = await window.plano.workspaces.save({ activeId, workspaces: spaces })
    useWorkspaceStore.getState().markSaved(result.savedAt)
  } catch (err) {
    // Keep `dirty` set so the next edit / explicit save retries; never throw into a fire-and-forget
    // caller (unhandled rejections were the "many errors" on earlier rename collisions).
    console.error('[workspace] state save failed', err)
  }
  const active = spaces.find((s) => s.id === activeId)
  if (active?.folderPath) {
    const doc = buildFolderDoc(spaces, active.folderPath, activeId)
    if (doc) {
      try {
        await window.plano.workspace.save({ folderPath: active.folderPath, workspace: doc })
      } catch {
        /* the per-folder portability mirror is best-effort */
      }
    }
  }
}

/**
 * Synchronous final flush for window close / app quit (called from App's `beforeunload`). The
 * debounced autosave can't complete its async IPC before the renderer is torn down, so here we push
 * the live canvas into the active snapshot and write the app-global state to disk SYNCHRONOUSLY —
 * so the last note/todo/canvas edit is never lost on close. Respects the autosave setting and only
 * runs once a project is fully open, matching `scheduleAutosave`.
 */
export function flushWorkspaceSync(): void {
  if (useWorkspaceStore.getState().status !== 'ready') return
  if (!useSettingsStore.getState().settings.canvas.autosave) return
  flushCanvasToActive()
  const { spaces, activeId } = useSpacesStore.getState()
  if (!activeId || spaces.length === 0) return
  try {
    window.plano.workspaces.saveSync({ activeId, workspaces: spaces })
  } catch {
    /* nothing more we can do while the renderer is tearing down */
  }
}

/** Switch the live canvas to another workspace (flushing the current one first). Terminals persist. */
export function switchSpace(id: string): void {
  const { activeId, spaces } = useSpacesStore.getState()
  if (id === activeId || !spaces.some((s) => s.id === id)) return
  flushCanvasToActive()
  withAutosaveSuspended(() => {
    useSpacesStore.getState().setActiveId(id)
    loadActiveIntoCanvas()
  })
  syncActiveMeta()
  void saveCurrent()
}

/** Create a fresh blank workspace (no folder) and switch to it. Returns its id. */
export function createNewSpace(): string {
  flushCanvasToActive()
  // Name is a placeholder; the store renumbers auto-named workspaces to their slot on add.
  const space = createSpace(newId(), 'Workspace', null)
  useSpacesStore.getState().add(space)
  withAutosaveSuspended(() => {
    useSpacesStore.getState().setActiveId(space.id)
    loadActiveIntoCanvas()
  })
  syncActiveMeta()
  void saveCurrent()
  return space.id
}

/** Rename a workspace. */
export function renameSpace(id: string, name: string): void {
  const trimmed = name.trim()
  if (!trimmed) return
  useSpacesStore.getState().rename(id, trimmed)
  if (id === useSpacesStore.getState().activeId) syncActiveMeta()
  void saveCurrent()
}

/**
 * Adopt a folder into a workspace: point it at the folder, name it after the folder, and import the
 * folder's saved layout (if any). Switches to `targetId` and persists. Never clobbers on a read
 * error — it opens the folder anyway, just without importing.
 */
async function adoptFolder(targetId: string, folderPath: string): Promise<void> {
  const res = await window.plano.workspace.open({ folderPath })
  if (res.error) {
    void confirm({
      title: 'Couldn’t read this project’s layout',
      message: `${res.folderPath}\n\n${res.error.message}\n\nThe folder was opened anyway; its saved layout wasn’t imported.`,
      confirmLabel: 'OK',
      cancelLabel: 'Dismiss',
    })
  }

  useSpacesStore.getState().setFolder(targetId, folderPath)
  useSpacesStore.getState().rename(targetId, folderName(folderPath))

  // Import the saved canvas (the per-folder doc's active space) when one exists.
  const importSpace =
    !res.error && !res.isNew
      ? res.workspace.spaces.find((s) => s.id === res.workspace.activeSpaceId) ?? res.workspace.spaces[0]
      : undefined

  withAutosaveSuspended(() => {
    if (useSpacesStore.getState().activeId !== targetId) useSpacesStore.getState().setActiveId(targetId)
    if (importSpace) useSpacesStore.getState().writeBack(targetId, importSpace.panels, importSpace.viewport)
    loadActiveIntoCanvas()
    // End any PTY whose panel no longer exists anywhere (e.g. a replaced canvas's terminals).
    reconcileTerminalSessions()
  })
  syncActiveMeta()
  await saveCurrent()

  // Surface the project's files so opening visibly does something (only when nothing else is there).
  if (Object.keys(usePanelStore.getState().panels).length === 0) openFilesPanel(folderPath)
}

/**
 * Open a folder as a workspace — NON-destructively. If a workspace already has that folder, just
 * switch to it. Otherwise adopt it into the active workspace when it's still a fresh blank one, or
 * spin up a NEW workspace for it. Never stops another workspace's terminals, never shows a global
 * "switch project" prompt. Shared by the folder picker, Explorer's "Open in PLANO", and launch.
 */
export async function openWorkspaceFolder(folderPath: string): Promise<void> {
  const spaces = useSpacesStore.getState().spaces
  const existing = spaces.find((s) => s.folderPath === folderPath)
  if (existing) {
    switchSpace(existing.id)
    return
  }

  flushCanvasToActive()
  const activeId = useSpacesStore.getState().activeId
  const active = useSpacesStore.getState().spaces.find((s) => s.id === activeId)
  const liveEmpty = Object.keys(usePanelStore.getState().panels).length === 0
  const reuseActive = !!active && active.folderPath === null && active.panels.length === 0 && liveEmpty

  let targetId: string
  if (reuseActive && active) {
    targetId = active.id
  } else {
    const space = createSpace(newId(), folderName(folderPath), folderPath)
    useSpacesStore.getState().add(space)
    targetId = space.id
  }
  await adoptFolder(targetId, folderPath)
}

/** Native folder picker → open that folder as a workspace. */
export async function openFolder(): Promise<void> {
  const { folderPath } = await window.plano.workspace.pickFolder()
  if (!folderPath) return
  await openWorkspaceFolder(folderPath)
}

/**
 * Repoint the ACTIVE workspace at a different folder (the TopBar "Change Folder…"). This replaces
 * the active canvas, so it stops THIS workspace's terminals (confirmed first) — but never touches
 * any other workspace. If another workspace already has the picked folder, switch to it instead.
 */
export async function changeActiveWorkspaceFolder(): Promise<void> {
  const { folderPath } = await window.plano.workspace.pickFolder()
  if (!folderPath) return
  const { activeId, spaces } = useSpacesStore.getState()
  const active = spaces.find((s) => s.id === activeId)
  if (!active || active.folderPath === folderPath) return

  const existing = spaces.find((s) => s.folderPath === folderPath && s.id !== activeId)
  if (existing) {
    switchSpace(existing.id)
    return
  }

  const panelIds = Object.keys(usePanelStore.getState().panels)
  const running = liveTerminalCount(panelIds)
  if (running > 0) {
    const ok = await confirm({
      title: 'Change this workspace’s folder?',
      message: `${running} running terminal${running > 1 ? 's' : ''}/agent${running > 1 ? 's' : ''} in this workspace will be stopped. Other workspaces are untouched.`,
      confirmLabel: 'Change folder',
      cancelLabel: 'Stay',
      danger: true,
    })
    if (!ok) return
  }
  killTerminalSessions(panelIds)
  // Clear the canvas first so a folder with no saved layout starts empty (adoptFolder only
  // overwrites it when there's a layout to import).
  flushCanvasToActive()
  useSpacesStore.getState().writeBack(active.id, [], active.viewport)
  await adoptFolder(active.id, folderPath)
}

/**
 * Close a workspace: stop its terminals and remove it (re-activating a neighbor if it was active).
 * Closing the LAST one resets it to a fresh blank workspace — there's always at least one. Confirms
 * first when the workspace hosts running terminals/agents, since closing it stops them for good.
 */
export async function deleteSpace(id: string, opts?: { skipConfirm?: boolean }): Promise<void> {
  const { spaces, activeId } = useSpacesStore.getState()
  const idx = spaces.findIndex((s) => s.id === id)
  if (idx < 0) return

  const wasActive = id === activeId
  const panelIds = wasActive
    ? Object.keys(usePanelStore.getState().panels)
    : spaces[idx].panels.map((p) => p.id)

  const running = liveTerminalCount(panelIds)
  if (!opts?.skipConfirm && running > 0) {
    const ok = await confirm({
      title: 'Close workspace?',
      message: `“${spaces[idx].name}” has ${running} running terminal${running > 1 ? 's' : ''}/agent${running > 1 ? 's' : ''}. Closing it stops ${running > 1 ? 'them' : 'it'}.`,
      confirmLabel: 'Close',
      cancelLabel: 'Keep',
      danger: true,
    })
    if (!ok) return
  }

  // End every terminal/agent living in this workspace before it disappears.
  killTerminalSessions(panelIds)

  // The last workspace can't be removed (there's always ≥1) — reset it to a fresh blank one.
  if (spaces.length <= 1) {
    const fresh = createSpace(newId(), 'Workspace 1')
    withAutosaveSuspended(() => {
      useSpacesStore.getState().hydrate([fresh], fresh.id)
      loadActiveIntoCanvas()
    })
    syncActiveMeta()
    void saveCurrent()
    return
  }

  useSpacesStore.getState().remove(id)
  if (wasActive) {
    const remaining = useSpacesStore.getState().spaces
    const next = remaining[Math.min(idx, remaining.length - 1)]
    withAutosaveSuspended(() => {
      useSpacesStore.getState().setActiveId(next.id)
      loadActiveIntoCanvas()
    })
    syncActiveMeta()
  }
  void saveCurrent()
}

/** Close the active workspace (TopBar "Close Project" / Ctrl+Shift+W). */
export async function closeWorkspace(opts?: { skipConfirm?: boolean }): Promise<void> {
  const activeId = useSpacesStore.getState().activeId
  if (activeId) await deleteSpace(activeId, opts)
}

/**
 * Launch restore: hydrate the app-global open-workspaces state, or — on the first run of this build
 * (no app-global file yet) — migrate the project the user left open under the legacy per-folder
 * session into independent workspaces, so nothing is lost.
 */
export async function restoreWorkspaces(): Promise<void> {
  useWorkspaceStore.getState().setStatus('loading')
  let state: { activeId: string; workspaces: Space[] } | null = null
  try {
    state = (await window.plano.workspaces.get()).state
  } catch {
    state = null
  }

  if (state && state.workspaces.length > 0) {
    const restored = state
    withAutosaveSuspended(() => {
      useSpacesStore.getState().hydrate(restored.workspaces, restored.activeId)
      loadActiveIntoCanvas()
      reconcileTerminalSessions()
    })
    syncActiveMeta()
    return
  }

  await migrateFromLegacySession()
}

/** First-run migration of the legacy per-folder session into the new app-global state (once). */
async function migrateFromLegacySession(): Promise<void> {
  let folder: string | null = null
  try {
    const session = await window.plano.session.get()
    folder = session.folderPath
    if (!session.initialized) {
      const { recents } = await window.plano.workspace.listRecent()
      folder = recents[0]?.path ?? null
    }
  } catch {
    folder = null
  }

  if (folder) {
    try {
      const res = await window.plano.workspace.open({ folderPath: folder })
      if (!res.error && res.workspace.spaces.length > 0) {
        // Carry every existing space over as an independent workspace, all on that folder.
        const workspaces = res.workspace.spaces.map((s) => ({ ...s, folderPath: folder }))
        withAutosaveSuspended(() => {
          useSpacesStore.getState().hydrate(workspaces, res.workspace.activeSpaceId)
          loadActiveIntoCanvas()
          reconcileTerminalSessions()
        })
        syncActiveMeta()
        await saveCurrent()
        return
      }
    } catch {
      /* fall through to a blank start */
    }
  }

  // Nothing to migrate → keep the initial blank workspace and persist it for an instant next launch.
  syncActiveMeta()
  await saveCurrent()
}
