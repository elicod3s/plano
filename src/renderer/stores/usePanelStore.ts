import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import {
  PANEL_META,
  defaultProps,
  type Panel,
  type PanelType,
  type PanelPropsMap,
} from '@shared/domain/panel'
import type { FilesProps } from '@shared/domain/panel'
import type { Point, Rect } from '@shared/domain/geometry'
import { newId } from '@/lib/id'

/**
 * Migrate a persisted panel forward. The legacy 'files' (File Explorer) type was merged
 * into the unified 'editor' (Files) panel, so old explorer panels become editors rooted
 * at the folder they were browsing.
 */
function migratePanel(p: Panel): Panel {
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
  return p
}

interface PanelState {
  panels: Record<string, Panel>
  /** monotonically increasing z to bring panels to front */
  zCounter: number

  addPanel: (type: PanelType, worldCenter?: Point) => string
  removePanel: (id: string) => void
  movePanel: (id: string, x: number, y: number) => void
  /** Move several panels to absolute positions in one commit (used by region drag-together). */
  moveMany: (moves: { id: string; x: number; y: number }[]) => void
  resizePanel: (id: string, rect: Rect) => void
  bringToFront: (id: string) => void
  setTitle: (id: string, title: string) => void
  updateProps: <T extends PanelType>(id: string, partial: Partial<PanelPropsMap[T]>) => void
  replaceAll: (panels: Panel[]) => void
  clear: () => void
}

let cascade = 0

export const usePanelStore = create<PanelState>()(
  immer((set, get) => ({
    panels: {},
    zCounter: 1,

    addPanel: (type, worldCenter) => {
      const id = newId()
      const meta = PANEL_META[type]
      const { width, height } = meta.defaultSize
      // Cascade new panels slightly when no explicit drop point is given.
      const offset = (cascade = (cascade + 1) % 8) * 28
      const center = worldCenter ?? { x: 240 + offset, y: 200 + offset }
      // Regions are ground, not floating windows: they stay on a low z behind panels and
      // never bump the focus counter, so adding one doesn't steal the "front" highlight.
      const isRegion = type === 'region'
      const z = isRegion ? 0 : get().zCounter + 1

      const panel = {
        id,
        type,
        rect: { x: center.x - width / 2, y: center.y - height / 2, width, height },
        z,
        title: meta.label.replace(/^New\s+/, ''),
        props: defaultProps(type),
      } as Panel

      set((s) => {
        s.panels[id] = panel
        if (!isRegion) s.zCounter = z
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

    updateProps: (id, partial) =>
      set((s) => {
        const p = s.panels[id]
        if (p) Object.assign(p.props as object, partial)
      }),

    replaceAll: (panels) =>
      set((s) => {
        s.panels = {}
        let maxZ = 1
        for (const raw of panels) {
          const p = migratePanel(raw)
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
