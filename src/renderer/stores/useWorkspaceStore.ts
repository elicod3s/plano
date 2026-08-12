import { create } from 'zustand'

type WorkspaceStatus = 'no-folder' | 'loading' | 'ready'

interface WorkspaceState {
  folderPath: string | null
  name: string
  status: WorkspaceStatus
  dirty: boolean
  lastSavedAt: string | null

  /**
   * Mirror the ACTIVE workspace's folder + name here so the TopBar, git chip and terminal cwd
   * read one place. `folderPath: null` is a valid state (a blank workspace — "choose folder"); the
   * workspace is still 'ready' and autosaved (its layout persists app-globally regardless).
   */
  setWorkspace: (info: { folderPath: string | null; name: string }) => void
  /** Return to the blank "no project open" state — title reverts to PLANO, autosave goes idle. */
  clearWorkspace: () => void
  setStatus: (status: WorkspaceStatus) => void
  markDirty: () => void
  markSaved: (savedAt: string) => void
}

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  folderPath: null,
  name: 'Workspace',
  status: 'no-folder',
  dirty: false,
  lastSavedAt: null,

  setWorkspace: ({ folderPath, name }) =>
    set({ folderPath, name, status: 'ready', dirty: false }),
  clearWorkspace: () =>
    set({ folderPath: null, name: 'PLANO', status: 'no-folder', dirty: false, lastSavedAt: null }),
  setStatus: (status) => set({ status }),
  markDirty: () => set((s) => (s.dirty ? s : { dirty: true })),
  markSaved: (savedAt) => set({ dirty: false, lastSavedAt: savedAt }),
}))
