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
  /**
   * Whether this selection was made ON PURPOSE — swept with the marquee, or built with
   * shift/ctrl-click — as opposed to the implicit one-panel selection every plain click creates
   * so a drag knows what it is moving.
   *
   * The distinction is what lets a marquee over a SINGLE terminal light up while clicking a panel
   * stays quiet: both end as `ids = [id]`, so the count alone cannot tell them apart, and gating
   * the highlight on `length > 1` (the old rule) meant selecting one terminal showed nothing.
   */
  explicit: boolean
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
  explicit: false,
  marquee: null,
  // Identical selections keep the previous array so subscribers (and the memoized panels that
  // read `isSelected`) do not re-render on every marquee frame.
  select: (ids) => set((s) => (sameIds(s.ids, ids) && s.explicit ? s : { ids: [...ids], explicit: true })),
  toggle: (id) =>
    set((s) => ({
      ids: s.ids.includes(id) ? s.ids.filter((x) => x !== id) : [...s.ids, id],
      explicit: true,
    })),
  selectOnly: (id) => {
    const { ids } = get()
    // Grabbing a panel that is already part of a multi-selection must not collapse it — that is
    // what makes "select three terminals, drag one, all three move" work.
    if (ids.includes(id)) return
    // Implicit: this is the click that focuses a panel, not an act of selecting it.
    set({ ids: [id], explicit: false })
  },
  clear: () => set((s) => (s.ids.length === 0 ? s : { ids: [], explicit: false })),
  setMarquee: (rect) => set({ marquee: rect }),
}))

/** Read-only helper for non-React callers (gesture handlers read this instead of subscribing). */
export function selectedPanelIds(): string[] {
  return useSelectionStore.getState().ids
}
