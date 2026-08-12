import { create } from 'zustand'

/**
 * Canvas selection — which panels a canvas gesture currently addresses.
 *
 * Deliberately runtime-only (never persisted, like the terminal runtime stores): a workspace
 * reopens with nothing selected. Selection is a SET of panel ids plus the live marquee rect in
 * SCREEN coordinates, kept here rather than in component state so the overlay can redraw during
 * a drag without re-rendering (and un-memoizing) a single panel.
 */

/** Screen-space rectangle, already normalized to a positive width/height. */
export interface MarqueeRect {
  x: number
  y: number
  width: number
  height: number
}

interface SelectionState {
  ids: string[]
  /** Non-null only while a marquee drag is in flight. */
  marquee: MarqueeRect | null
  select: (ids: string[]) => void
  toggle: (id: string) => void
  /** Make `id` the whole selection unless it is already part of a multi-selection. */
  selectOnly: (id: string) => void
  clear: () => void
  setMarquee: (rect: MarqueeRect | null) => void
}

const sameIds = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((id, i) => id === b[i])

export const useSelectionStore = create<SelectionState>((set, get) => ({
  ids: [],
  marquee: null,
  // Identical selections keep the previous array so subscribers (and the memoized panels that
  // read `isSelected`) do not re-render on every marquee frame.
  select: (ids) => set((s) => (sameIds(s.ids, ids) ? s : { ids: [...ids] })),
  toggle: (id) =>
    set((s) => ({ ids: s.ids.includes(id) ? s.ids.filter((x) => x !== id) : [...s.ids, id] })),
  selectOnly: (id) => {
    const { ids } = get()
    // Grabbing a panel that is already part of a multi-selection must not collapse it — that is
    // what makes "select three terminals, drag one, all three move" work.
    if (ids.includes(id)) return
    set({ ids: [id] })
  },
  clear: () => set((s) => (s.ids.length === 0 ? s : { ids: [] })),
  setMarquee: (rect) => set({ marquee: rect }),
}))

/** Read-only helper for non-React callers (gesture handlers read this instead of subscribing). */
export function selectedPanelIds(): string[] {
  return useSelectionStore.getState().ids
}
