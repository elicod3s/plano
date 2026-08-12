import { create } from 'zustand'
import { createSpace, renumberDefaultSpaces, type Space, type SpaceColor, type Viewport } from '@shared/domain/workspace'
import type { Panel, TerminalProps, TerminalTab } from '@shared/domain/panel'
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
  /** Patch a terminal tab wherever its owning workspace currently lives (including background). */
  updateTerminalTab: (panelId: string, tabId: string, partial: Partial<TerminalTab>) => void
  add: (space: Space) => void
  remove: (id: string) => void
  rename: (id: string, name: string) => void
  /** Set (or clear) the workspace's label colour — the user's own tag, never derived. */
  setColor: (id: string, color: SpaceColor | undefined) => void
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

  updateTerminalTab: (panelId, tabId, partial) =>
    set((s) => ({
      spaces: s.spaces.map((space) => {
        const panelIndex = space.panels.findIndex((panel) => panel.id === panelId)
        if (panelIndex < 0 || space.panels[panelIndex].type !== 'terminal') return space
        const panel = space.panels[panelIndex]
        const props = panel.props as TerminalProps
        const tabIndex = props.tabs?.findIndex((tab) => tab.id === tabId) ?? -1
        if (tabIndex < 0 || !props.tabs) return space
        const current = props.tabs[tabIndex]
        const changed = Object.entries(partial).some(
          ([key, value]) => current[key as keyof TerminalTab] !== value,
        )
        if (!changed) return space
        const tabs = [...props.tabs]
        tabs[tabIndex] = { ...current, ...partial }
        const panels = [...space.panels]
        panels[panelIndex] = { ...panel, props: { ...props, tabs } } as Panel
        return { ...space, panels }
      }),
    })),

  add: (space) => set((s) => ({ spaces: renumberDefaultSpaces([...s.spaces, space]) })),

  remove: (id) => set((s) => ({ spaces: renumberDefaultSpaces(s.spaces.filter((sp) => sp.id !== id)) })),

  rename: (id, name) =>
    set((s) => ({ spaces: s.spaces.map((sp) => (sp.id === id ? { ...sp, name } : sp)) })),

  setColor: (id, color) =>
    set((s) => ({ spaces: s.spaces.map((sp) => (sp.id === id ? { ...sp, color } : sp)) })),

  setFolder: (id, folderPath) =>
    set((s) => ({ spaces: s.spaces.map((sp) => (sp.id === id ? { ...sp, folderPath } : sp)) })),

  setActiveId: (id) => set({ activeId: id }),
}))
