import { create } from 'zustand'
import { usePanelStore } from './usePanelStore'
import { useSpacesStore } from './useSpacesStore'
import { paneIds } from '@shared/domain/dock'
import type { GroupProps, TerminalProps } from '@shared/domain/panel'

/**
 * Transient canvas focus. Exactly ONE logical top-level "surface" is focused at a
 * time: a standalone panel focuses itself; a dock group focuses as ONE outer surface with the
 * clicked member pane recorded for keyboard routing. Ephemeral UI state ONLY — never persisted,
 * never autosaved, never part of usePanelStore / useSpacesStore / the workspace document (App's
 * autosave subscription watches usePanelStore, so a focus change must never touch it).
 *
 * `focusEpoch` is a monotonically increasing counter bumped by EVERY focusSurface() call — even
 * when the ids are unchanged. It is the "re-run the focus routine" signal: a same-terminal refocus
 * after an overlay/palette stole DOM focus, an active terminal-tab switch inside a focused panel,
 * or a dock/undock transfer all need a fresh epoch so the terminal hook re-targets the xterm
 * textarea without any other state churn. PTYs are never touched by focus.
 *
 * Self-healing lifecycle (wired here, not in usePanelStore/useSpacesStore — this file owns the
 * focus lifecycle so the persisted stores stay untouched):
 *  - workspace/space switch or hydration resets focus (activeId change → clearFocus);
 *  - the focused panel/group closes, or the canvas is replaced wholesale → clearFocus;
 *  - docking turns the focused panel into a group member → transfer to the destination group,
 *    keeping the clicked member;
 *  - undocking / dissolving a group moves the focused member out → transfer to its new surface;
 *  - the focused member pane is removed from a group → redirect to a remaining live pane;
 *  - the focused terminal panel switches its active tab → bump the epoch (member id unchanged).
 */
export type CanvasFocus = { surfaceId: string; panelId: string } | null

export interface CanvasFocusState {
  focus: CanvasFocus
  focusEpoch: number
  focusSurface: (surfaceId: string, panelId: string) => void
  clearFocus: () => void
  removeFocusForSurface: (surfaceId: string) => void
}

export const useCanvasFocusStore = create<CanvasFocusState>((set) => ({
  focus: null,
  focusEpoch: 0,

  focusSurface: (surfaceId, panelId) =>
    set((s) => ({ focus: { surfaceId, panelId }, focusEpoch: s.focusEpoch + 1 })),

  clearFocus: () => set({ focus: null }),

  removeFocusForSurface: (surfaceId) =>
    set((s) => (s.focus?.surfaceId === surfaceId ? { focus: null } : s)),
}))

/**
 * Last active terminal tab observed for the focused member. Used to detect a tab switch inside a
 * focused terminal panel and bump the epoch (the terminal focus routine then targets the NEW tab's
 * xterm). Recorded silently on first observation — the focusSurface that established focus already
 * bumped — so a plain click never double-bumps.
 */
let lastSeenActiveTab: { panelId: string; tabId: string | undefined } | null = null

/** Re-validate `focus` against the live panel set after every panel mutation. Cheap no-op when
 *  nothing focused or nothing relevant changed; bails before any store write otherwise. */
function reconcileFocusWithPanels(): void {
  const fs = useCanvasFocusStore.getState()
  if (!fs.focus) {
    lastSeenActiveTab = null
    return
  }
  const { focus, focusSurface, clearFocus, removeFocusForSurface } = fs
  const panels = usePanelStore.getState().panels
  const surface = panels[focus.surfaceId]
  const member = panels[focus.panelId]

  // Focused top-level surface is gone: panel/group closed, group dissolved, or the whole canvas
  // was replaced by a workspace switch/hydration. Nothing is focused anymore.
  if (!surface || surface.type === 'region' || surface.type === 'label') {
    lastSeenActiveTab = null
    removeFocusForSurface(focus.surfaceId)
    return
  }

  // The focused surface is now a member of a dock group: docking changed its top-level id.
  // Transfer focus to the destination group, keeping the clicked member (epoch bumps).
  if (surface.dockedIn) {
    focusSurface(surface.dockedIn, focus.panelId)
    return
  }

  if (surface.type === 'group') {
    // Focused member pane moved out of this group (undocked / group dissolved): transfer focus to
    // the member's new home — a standalone panel or, if it was re-docked, another group.
    if (member && member.dockedIn !== surface.id) {
      focusSurface(member.dockedIn ?? member.id, member.id)
      return
    }
    // Focused member pane was removed: redirect to a remaining live pane of the same group.
    if (!member) {
      const layout = (surface.props as GroupProps).layout
      const next = paneIds(layout).find((id) => panels[id] && panels[id].dockedIn === surface.id)
      lastSeenActiveTab = null
      if (next) focusSurface(surface.id, next)
      else clearFocus()
      return
    }
  }

  // Active terminal-tab switch inside the focused member: bump the epoch so the terminal focus
  // routine re-targets the new tab. This file never touches TerminalEngine — just the signal.
  if (member && member.type === 'terminal') {
    const tabId = (member.props as TerminalProps).activeTabId ?? undefined
    const prev = lastSeenActiveTab
    lastSeenActiveTab = { panelId: member.id, tabId }
    if (prev && prev.panelId === member.id && prev.tabId !== tabId) {
      focusSurface(focus.surfaceId, focus.panelId)
    }
  } else {
    lastSeenActiveTab = null
  }
}

// Lifecycle wiring: fire on every panel mutation (teardown, dock/undock, tab switch, hydration).
usePanelStore.subscribe(reconcileFocusWithPanels)

// Also re-validate when focus ITSELF changes: keeps lastSeenActiveTab in sync right after a
// focus action (so a terminal tab switch is detected on the NEXT panel mutation instead of
// being silently recorded), and keeps dock/undock transfers made through focusSurface consistent.
useCanvasFocusStore.subscribe(reconcileFocusWithPanels)

// Workspace switch / hydration replaces the canvas — reset focus (never persisted, no disk write).
useSpacesStore.subscribe((state, prev) => {
  if (state.activeId !== prev.activeId) useCanvasFocusStore.getState().clearFocus()
})
