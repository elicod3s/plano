import { create } from 'zustand'
import type { Rect } from '@shared/domain/geometry'
import type { DockSide } from '@shared/domain/dock'
import type { Guide, SnapZone } from '@shared/domain/snapping'

/** The "merge here" dock preview: where the dragged panel will land + which side, for the label. */
export interface DockPreview {
  rect: Rect
  side: DockSide
}

/**
 * Transient feedback for an in-progress snap (alignment guides, the target container(s) being
 * joined, and any active Windows-style zone preview). Deliberately its OWN store: PanelFrame writes
 * to it imperatively (getState) during a drag, and ONLY the SnapOverlay subscribes — so publishing
 * snap feedback never re-renders the memoized panels. Cleared the instant a gesture ends.
 */
interface SnapState {
  active: boolean
  guides: Guide[]
  /** World rects of panels the dragged panel is aligning/joining to (highlighted as containers). */
  targets: Rect[]
  /** The armed Windows-style zone preview (canvas-local screen px), or null. */
  zone: SnapZone | null
  /** The dock-merge preview region (canvas-local screen px) + side, or null. */
  dock: DockPreview | null

  show: (data: { guides?: Guide[]; targets?: Rect[]; zone?: SnapZone | null; dock?: DockPreview | null }) => void
  clear: () => void
}

export const useSnapStore = create<SnapState>((set) => ({
  active: false,
  guides: [],
  targets: [],
  zone: null,
  dock: null,

  show: ({ guides = [], targets = [], zone = null, dock = null }) =>
    set({ active: true, guides, targets, zone, dock }),
  clear: () => set({ active: false, guides: [], targets: [], zone: null, dock: null }),
}))
