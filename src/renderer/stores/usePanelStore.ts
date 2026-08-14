import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import {
  PANEL_META,
  defaultProps,
  type Panel,
  type PanelType,
  type PanelPropsMap,
} from '@shared/domain/panel'
import type { FilesProps, GroupProps, TerminalProps, TerminalTab } from '@shared/domain/panel'
import type { Point, Rect } from '@shared/domain/geometry'
import type { DockNode } from '@shared/domain/dock'
import { newId } from '@/lib/id'
import { clearSize, loadSize } from '@/lib/panelSizes'

/**
 * Migrate a persisted panel forward. The legacy 'files' (File Explorer) type was merged
 * into the unified 'editor' (Files) panel, so old explorer panels become editors rooted
 * at the folder they were browsing.
 *
 * Retired types are compared as strings: they are gone from `PanelType`, so the compiler would
 * reject `p.type === 'agent'` outright — but a workspace saved before they were removed still has
 * them on disk, and a canvas must never fail to open because of a panel we deleted.
 */
function migratePanel(p: Panel): Panel | null {
  if (p.type === 'files') {
    const rootPath = (p.props as FilesProps).rootPath
    return {
      id: p.id,
      type: 'editor',
      rect: p.rect,
      z: p.z,
      title: p.title,
      props: { folderPath: rootPath, sidebarOpen: true },
    }
  }
  const legacy = p.type as string
  // The Agent panel only ever launched a CLI into a terminal, and an empty terminal already offers
  // that same launcher — so it becomes the terminal it was a detour to, keeping its place on the
  // canvas. Its `provider` is not carried over: the launcher asks, and guessing would silently
  // start an agent the user did not ask for on this open.
  if (legacy === 'agent') {
    return { id: p.id, type: 'terminal', rect: p.rect, z: p.z, title: p.title, props: {} }
  }
  // Git and Voice panels never rendered anything but "Coming soon", so there is no content to
  // preserve and nothing to convert them into. Dropping them removes an empty box, not work.
  if (legacy === 'git' || legacy === 'voice') return null
  return p
}

interface PanelState {
  panels: Record<string, Panel>
  /** monotonically increasing z to bring panels to front */
  zCounter: number

  addPanel: <T extends PanelType>(
    type: T,
    worldCenter?: Point,
    initialProps?: Partial<PanelPropsMap[T]>,
  ) => string
  removePanel: (id: string) => void
  movePanel: (id: string, x: number, y: number) => void
  /** Move several panels to absolute positions in one commit (used by region drag-together). */
  moveMany: (moves: { id: string; x: number; y: number }[]) => void
  resizePanel: (id: string, rect: Rect) => void
  /** Restore this panel and future panels of its type to the built-in default size. */
  resetPanelSize: (id: string) => void
  bringToFront: (id: string) => void
  setTitle: (id: string, title: string) => void
  /** Pin/unpin a panel in place (blocks its move + resize gestures). */
  toggleLock: (id: string) => void
  updateProps: <T extends PanelType>(id: string, partial: Partial<PanelPropsMap[T]>) => void
  /** Merge `partial` into one terminal tab's config (props.tabs[tabId]) of a terminal panel. */
  updateTerminalTab: (panelId: string, tabId: string, partial: Partial<TerminalTab>) => void
  /** Append a fresh terminal tab to a terminal panel and make it active. Returns its new id
   *  (null if the panel isn't a terminal). The PTY is spawned lazily when the tab first mounts. */
  addTerminalTab: (panelId: string) => string | null
  /** Remove one terminal tab from a panel's tab list, re-selecting a neighbor if it was active.
   *  Pure props mutation — the caller kills the tab's PTY first (see app/terminalSessions). */
  closeTerminalTab: (panelId: string, tabId: string) => void
  /** Switch which terminal tab is shown in a panel. */
  setActiveTerminalTab: (panelId: string, tabId: string) => void
  /** Create a dock-group window holding a split tree of member panels (front z). Returns its id. */
  createGroup: (rect: Rect, layout: DockNode) => string
  /** Replace a group's split-tree layout. */
  setGroupLayout: (id: string, layout: DockNode) => void
  /** Mark/unmark a panel as docked inside a group (rendered there, not as its own frame). */
  setDocked: (id: string, groupId: string | undefined) => void
  /** Insert a FULLY-FORMED panel (e.g. a phone-materialized terminal) without touching the
   *  rest of the live canvas — never rebuild the store from a snapshot here, or docks/groups
   *  that live only in the live store get wiped. */
  insertPanel: (panel: Panel) => void
  replaceAll: (panels: Panel[]) => void
  clear: () => void
}

let cascade = 0

export const usePanelStore = create<PanelState>()(
  immer((set, get) => ({
    panels: {},
    zCounter: 1,

    addPanel: (type, worldCenter, initialProps) => {
      const id = newId()
      const meta = PANEL_META[type]
      // Reopen at the user's last-used size for this type, falling back to the default.
      const { width, height } = loadSize(type, meta.defaultSize) ?? meta.defaultSize
      // Cascade new panels slightly when no explicit drop point is given.
      const offset = (cascade = (cascade + 1) % 8) * 28
      const center = worldCenter ?? { x: 240 + offset, y: 200 + offset }
      // Regions and text labels are ground, not floating windows: they stay on a low z behind
      // the panels and never bump the focus counter, so adding one doesn't steal the "front"
      // highlight (PanelLayer renders both via their own frames, not PanelFrame).
      const isGround = type === 'region' || type === 'label'
      const z = isGround ? 0 : get().zCounter + 1

      const panel = {
        id,
        type,
        rect: { x: center.x - width / 2, y: center.y - height / 2, width, height },
        z,
        title: meta.label.replace(/^New\s+/, ''),
        props: { ...defaultProps(type), ...initialProps },
      } as Panel

      set((s) => {
        s.panels[id] = panel
        if (!isGround) s.zCounter = z
      })
      return id
    },

    removePanel: (id) =>
      set((s) => {
        delete s.panels[id]
      }),

    movePanel: (id, x, y) =>
      set((s) => {
        const p = s.panels[id]
        if (p) {
          p.rect.x = x
          p.rect.y = y
        }
      }),

    moveMany: (moves) =>
      set((s) => {
        for (const m of moves) {
          const p = s.panels[m.id]
          if (p) {
            p.rect.x = m.x
            p.rect.y = m.y
          }
        }
      }),

    resizePanel: (id, rect) =>
      set((s) => {
        const p = s.panels[id]
        if (p) p.rect = rect
      }),

    resetPanelSize: (id) => {
      const panel = get().panels[id]
      if (!panel) return
      clearSize(panel.type)
      const { width, height } = PANEL_META[panel.type].defaultSize
      set((s) => {
        const p = s.panels[id]
        if (!p) return
        const centerX = p.rect.x + p.rect.width / 2
        const centerY = p.rect.y + p.rect.height / 2
        p.rect = {
          x: Math.round(centerX - width / 2),
          y: Math.round(centerY - height / 2),
          width,
          height,
        }
      })
    },

    bringToFront: (id) =>
      set((s) => {
        const p = s.panels[id]
        if (p && p.z !== s.zCounter) {
          s.zCounter += 1
          p.z = s.zCounter
        }
      }),

    setTitle: (id, title) =>
      set((s) => {
        const p = s.panels[id]
        if (p) p.title = title
      }),

    toggleLock: (id) =>
      set((s) => {
        const p = s.panels[id]
        if (p) p.locked = !p.locked
      }),

    updateProps: (id, partial) =>
      set((s) => {
        const p = s.panels[id]
        if (p) Object.assign(p.props as object, partial)
      }),

    updateTerminalTab: (panelId, tabId, partial) =>
      set((s) => {
        const p = s.panels[panelId]
        if (!p || p.type !== 'terminal') return
        const tab = (p.props as TerminalProps).tabs?.find((t) => t.id === tabId)
        if (tab) Object.assign(tab as TerminalTab, partial)
      }),

    addTerminalTab: (panelId) => {
      const p = get().panels[panelId]
      if (!p || p.type !== 'terminal') return null
      const id = newId()
      set((s) => {
        const props = s.panels[panelId].props as TerminalProps
        if (!props.tabs) props.tabs = []
        props.tabs.push({ id })
        props.activeTabId = id
      })
      return id
    },

    closeTerminalTab: (panelId, tabId) =>
      set((s) => {
        const p = s.panels[panelId]
        if (!p || p.type !== 'terminal') return
        const props = p.props as TerminalProps
        const tabs = props.tabs ?? []
        const idx = tabs.findIndex((t) => t.id === tabId)
        if (idx === -1) return
        tabs.splice(idx, 1)
        // Re-select a neighbor (prefer the one to the left) when the active tab was closed.
        if (props.activeTabId === tabId) {
          const next = tabs[idx - 1] ?? tabs[idx] ?? tabs[0]
          props.activeTabId = next?.id
        }
      }),

    setActiveTerminalTab: (panelId, tabId) =>
      set((s) => {
        const p = s.panels[panelId]
        if (!p || p.type !== 'terminal') return
        ;(p.props as TerminalProps).activeTabId = tabId
      }),

    createGroup: (rect, layout) => {
      const id = newId()
      set((s) => {
        s.zCounter += 1
        s.panels[id] = {
          id,
          type: 'group',
          rect,
          z: s.zCounter,
          title: 'Group',
          props: { layout },
        } as Panel
      })
      return id
    },

    setGroupLayout: (id, layout) =>
      set((s) => {
        const p = s.panels[id]
        if (p && p.type === 'group') (p.props as GroupProps).layout = layout
      }),

    setDocked: (id, groupId) =>
      set((s) => {
        const p = s.panels[id]
        if (p) p.dockedIn = groupId
      }),

    insertPanel: (panel) =>
      set((s) => {
        s.panels[panel.id] = panel
        if (panel.z >= s.zCounter) s.zCounter = panel.z + 1
      }),

    replaceAll: (panels) =>
      set((s) => {
        s.panels = {}
        let maxZ = 1
        for (const raw of panels) {
          const p = migratePanel(raw)
          if (!p) continue // a retired panel type — see migratePanel
          s.panels[p.id] = p
          maxZ = Math.max(maxZ, p.z)
        }
        s.zCounter = maxZ
      }),

    clear: () =>
      set((s) => {
        s.panels = {}
        s.zCounter = 1
      }),
  })),
)
