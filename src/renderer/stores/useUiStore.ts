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
  /** The "Last agent prompts" overview overlay — opened by its command (no per-panel button). */
  lastPromptsOpen: boolean
  /** The Agent Mesh (cross-workspace agent control center) overlay. */
  agentControlOpen: boolean
  /**
   * The panel currently in FOCUS MODE (filling the canvas), or null. Runtime only — a workspace
   * always reopens with the canvas whole, the way macOS never restores an app still in full screen
   * against the user's will.
   */
  focusedPanelId: string | null
  minimapVisible: boolean
  snapping: boolean
  /** True for a short window while panels are being auto-arranged, so PanelFrame eases each panel
   *  to its new slot (tile-drop transition) instead of snapping instantly. */
  arranging: boolean

  openContextMenu: (screen: Point, world: Point) => void
  closeContextMenu: () => void
  setCommandPalette: (open: boolean) => void
  toggleCommandPalette: () => void
  setLastPrompts: (open: boolean) => void
  toggleLastPrompts: () => void
  setAgentControl: (open: boolean) => void
  toggleAgentControl: () => void
  /** Enter focus mode on a panel, or leave it (null). Toggling the focused panel leaves. */
  setFocusedPanel: (panelId: string | null) => void
  toggleFocusedPanel: (panelId: string) => void
  toggleMinimap: () => void
  setMinimap: (visible: boolean) => void
  toggleSnapping: () => void
  setSnapping: (on: boolean) => void
  setArranging: (on: boolean) => void
}

export const useUiStore = create<UiState>((set) => ({
  contextMenu: { open: false, screen: { x: 0, y: 0 }, world: { x: 0, y: 0 } },
  commandPaletteOpen: false,
  lastPromptsOpen: false,
  agentControlOpen: false,
  focusedPanelId: null,
  minimapVisible: true,
  snapping: true,
  arranging: false,

  openContextMenu: (screen, world) => set({ contextMenu: { open: true, screen, world } }),
  closeContextMenu: () =>
    set((s) => ({ contextMenu: { ...s.contextMenu, open: false } })),
  setCommandPalette: (open) => set({ commandPaletteOpen: open }),
  toggleCommandPalette: () => set((s) => ({ commandPaletteOpen: !s.commandPaletteOpen })),
  setLastPrompts: (open) => set({ lastPromptsOpen: open }),
  toggleLastPrompts: () => set((s) => ({ lastPromptsOpen: !s.lastPromptsOpen })),
  setAgentControl: (open) => set({ agentControlOpen: open }),
  toggleAgentControl: () => set((s) => ({ agentControlOpen: !s.agentControlOpen })),
  setFocusedPanel: (panelId) => set({ focusedPanelId: panelId }),
  toggleFocusedPanel: (panelId) => set((s) => ({ focusedPanelId: s.focusedPanelId === panelId ? null : panelId })),
  toggleMinimap: () => set((s) => ({ minimapVisible: !s.minimapVisible })),
  setMinimap: (minimapVisible) => set({ minimapVisible }),
  toggleSnapping: () => set((s) => ({ snapping: !s.snapping })),
  setSnapping: (snapping) => set({ snapping }),
  setArranging: (arranging) => set({ arranging }),
}))
