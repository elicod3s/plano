import { create } from 'zustand'

type WorkspaceStatus = 'no-folder' | 'loading' | 'ready'

interface WorkspaceState {
  folderPath: string | null
  name: string
  status: WorkspaceStatus
  dirty: boolean
  lastSavedAt: string | null

  setWorkspace: (info: { folderPath: string; name: string }) => void
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
  setStatus: (status) => set({ status }),
  markDirty: () => set({ dirty: true }),
  markSaved: (savedAt) => set({ dirty: false, lastSavedAt: savedAt }),
}))
