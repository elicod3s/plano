import { create } from 'zustand'
import type { Point } from '@shared/domain/geometry'

interface ContextMenuState {
  open: boolean
  screen: Point
  world: Point
}

interface UiState {
  contextMenu: ContextMenuState
  commandPaletteOpen: boolean
  minimapVisible: boolean
  snapping: boolean
  /** True for a short window while panels are being auto-arranged, so PanelFrame eases each panel
   *  to its new slot (tile-drop transition) instead of snapping instantly. */
  arranging: boolean

  openContextMenu: (screen: Point, world: Point) => void
  closeContextMenu: () => void
  setCommandPalette: (open: boolean) => void
  toggleCommandPalette: () => void
  toggleMinimap: () => void
  setMinimap: (visible: boolean) => void
  toggleSnapping: () => void
  setSnapping: (on: boolean) => void
  setArranging: (on: boolean) => void
}

export const useUiStore = create<UiState>((set) => ({
  contextMenu: { open: false, screen: { x: 0, y: 0 }, world: { x: 0, y: 0 } },
  commandPaletteOpen: false,
  minimapVisible: true,
  snapping: true,
  arranging: false,

  openContextMenu: (screen, world) => set({ contextMenu: { open: true, screen, world } }),
  closeContextMenu: () =>
    set((s) => ({ contextMenu: { ...s.contextMenu, open: false } })),
  setCommandPalette: (open) => set({ commandPaletteOpen: open }),
  toggleCommandPalette: () => set((s) => ({ commandPaletteOpen: !s.commandPaletteOpen })),
  toggleMinimap: () => set((s) => ({ minimapVisible: !s.minimapVisible })),
  setMinimap: (minimapVisible) => set({ minimapVisible }),
  toggleSnapping: () => set((s) => ({ snapping: !s.snapping })),
  setSnapping: (snapping) => set({ snapping }),
  setArranging: (arranging) => set({ arranging }),
}))
