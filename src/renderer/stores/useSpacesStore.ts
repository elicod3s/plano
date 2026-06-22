import { create } from 'zustand'
import { createSpace, renumberDefaultSpaces, type Space, type Viewport } from '@shared/domain/workspace'
import type { Panel } from '@shared/domain/panel'
import { newId } from '@/lib/id'

/**
 * Holds every space in the open project plus which one is active. The active space's
 * panels/camera live in usePanelStore / useViewportStore (the editing surface); this
 * store keeps the full list + snapshots of the inactive spaces. `workspaceActions`
 * orchestrates flushing the live canvas into the active snapshot and back.
 */
interface SpacesState {
  spaces: Space[]
  activeId: string | null

  /** Replace the whole list (on workspace load). Falls back to a default space. */
  hydrate: (spaces: Space[], activeId: string) => void
  /** Snapshot the live canvas into a space. */
  writeBack: (id: string, panels: Panel[], viewport: Viewport) => void
  add: (space: Space) => void
  remove: (id: string) => void
  rename: (id: string, name: string) => void
  /** Point a workspace at its own project folder (or null to clear it). */
  setFolder: (id: string, folderPath: string | null) => void
  setActiveId: (id: string) => void
}

const initial = createSpace(newId(), 'Workspace 1')

export const useSpacesStore = create<SpacesState>((set) => ({
  spaces: [initial],
  activeId: initial.id,

  // Every list mutation re-tightens auto-named spaces to their position (see renumberDefaultSpaces),
  // so a name like "Workspace 2" can never outlive its slot. Custom names are preserved.
  hydrate: (spaces, activeId) =>
    set(() => {
      const list = renumberDefaultSpaces(spaces.length > 0 ? spaces : [createSpace(newId(), 'Workspace 1')])
      const active = list.some((s) => s.id === activeId) ? activeId : list[0].id
      return { spaces: list, activeId: active }
    }),

  writeBack: (id, panels, viewport) =>
    set((s) => ({ spaces: s.spaces.map((sp) => (sp.id === id ? { ...sp, panels, viewport } : sp)) })),

  add: (space) => set((s) => ({ spaces: renumberDefaultSpaces([...s.spaces, space]) })),

  remove: (id) => set((s) => ({ spaces: renumberDefaultSpaces(s.spaces.filter((sp) => sp.id !== id)) })),

  rename: (id, name) =>
    set((s) => ({ spaces: s.spaces.map((sp) => (sp.id === id ? { ...sp, name } : sp)) })),

  setFolder: (id, folderPath) =>
    set((s) => ({ spaces: s.spaces.map((sp) => (sp.id === id ? { ...sp, folderPath } : sp)) })),

  setActiveId: (id) => set({ activeId: id }),
}))
