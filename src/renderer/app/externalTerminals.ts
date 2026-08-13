/**
 * Mobile-web materialization — terminals/agents created from the PLANO web app (phone) show up
 * as real canvas panels:
 *
 *  - LIVE: while PLANO is running, the host broadcasts `external-terminal` → this module adds the
 *    panel to its workspace + seeds the terminal store so the panel reattaches (not respawns).
 *  - LAUNCH: created while PLANO was CLOSED, the host recorded them as pending panels → read +
 *    materialize them BEFORE `restoreSurvivingTerminals` so their live sessions are in the kept
 *    set (no orphan kill) and reattach on mount.
 */

import { useSpacesStore } from '@/stores/useSpacesStore'
import { useTerminalStore } from '@/stores/useTerminalStore'
import { usePanelStore } from '@/stores/usePanelStore'
import { useViewportStore } from '@/stores/useViewportStore'
import { useToastStore } from '@/stores/useToastStore'
import { rectsIntersect, screenToWorld } from '@shared/domain/geometry'
import { createSpace } from '@shared/domain/workspace'
import { PANEL_META, type TerminalTab } from '@shared/domain/panel'
import type { ExternalTerminalEvent } from '@shared/ipc/contracts'
import { newId } from '@/lib/id'

/** Terminal ids that WILL get a panel shortly (phone-created, pending) — reconcile must spare them. */
let protectedTerminalIds: string[] = []

export function setPendingProtectedIds(ids: string[]): void {
  protectedTerminalIds = ids
}

export function pendingProtectedIds(): string[] {
  return protectedTerminalIds
}

function folderName(folderPath: string): string {
  const cleaned = folderPath.replace(/[\\/]+$/, '')
  const seg = cleaned.split(/[\\/]/).pop() || cleaned
  return seg || 'Workspace'
}

/** Find (or create) the workspace whose folderPath matches, returning its id. */
function ensureWorkspaceFor(folderPath: string | null): string {
  const store = useSpacesStore.getState()
  if (folderPath) {
    const hit = store.spaces.find(
      (s) => s.folderPath && s.folderPath.toLowerCase() === folderPath.toLowerCase(),
    )
    if (hit) return hit.id
    const space = createSpace(newId(), folderName(folderPath), folderPath)
    store.add(space)
    return space.id
  }
  return store.spaces[0]?.id ?? store.activeId ?? ''
}

/** Seed the terminal store + add the canvas panel for one externally-created terminal. */
let externalPlaced = 0

/** Breathing room between panels, and the step used when a slot is already taken. */
const PLACE_GAP = 20

/**
 * Where a terminal created from OUTSIDE the canvas lands.
 *
 * Two very different cases:
 *  - **Mesh spawn** (an agent asked for it): anchor on the REQUESTER's panel — same size, laid
 *    out as a tidy row to its right (wrapping to a second row past 3), so the batch reads as
 *    "these belong to that one". It used to ignore the requester entirely and drop everything at
 *    the viewport centre with a fixed default size, which is why new agents landed on top of the
 *    terminal that spawned them.
 *  - **Phone-created** (no origin): the original centred grid, unchanged.
 *
 * In both cases the result is nudged until it does not overlap an existing panel, so a spawn can
 * never bury live content.
 */
function placeExternalPanel(e: ExternalTerminalEvent): { x: number; y: number; width: number; height: number } {
  const panels = usePanelStore.getState().panels
  const origin = e.originPanelId ? panels[e.originPanelId] : undefined

  let rect: { x: number; y: number; width: number; height: number }
  if (origin) {
    // Same size as the panel that asked — the newcomer reads as a sibling, not a stray window.
    const { width, height } = origin.rect
    const index = Math.max(0, e.groupIndex ?? 0)
    const perRow = Math.min(3, Math.max(1, e.groupCount ?? 1))
    const col = index % perRow
    const row = Math.floor(index / perRow)
    rect = {
      x: Math.round(origin.rect.x + (col + 1) * (width + PLACE_GAP)),
      y: Math.round(origin.rect.y + row * (height + PLACE_GAP)),
      width,
      height,
    }
  } else {
    const size = PANEL_META.terminal.defaultSize
    const vp = useViewportStore.getState()
    const center = screenToWorld({ x: window.innerWidth / 2, y: window.innerHeight / 2 }, vp)
    const COLS = 2
    const PER_CLUSTER = COLS * 3
    const slot = externalPlaced++ % PER_CLUSTER
    const cluster = Math.floor(externalPlaced / PER_CLUSTER)
    rect = {
      x: Math.round(center.x - size.width / 2 + (slot % COLS) * (size.width + PLACE_GAP) - cluster * (COLS * (size.width + PLACE_GAP))),
      y: Math.round(center.y - size.height / 2 + Math.floor(slot / COLS) * (size.height + PLACE_GAP)),
      width: size.width,
      height: size.height,
    }
  }

  // Never bury an existing panel: step down, then across, until the slot is clear. Bounded so a
  // crowded canvas still places the panel somewhere instead of looping.
  const others = Object.values(panels).filter((p) => p.type !== 'region' && p.type !== 'label' && !p.dockedIn)
  for (let attempt = 0; attempt < 24; attempt += 1) {
    if (!others.some((p) => rectsIntersect(rect, p.rect))) break
    if (attempt % 4 === 3) {
      rect = { ...rect, x: rect.x + rect.width + PLACE_GAP, y: rect.y - 3 * (rect.height + PLACE_GAP) }
    } else {
      rect = { ...rect, y: rect.y + rect.height + PLACE_GAP }
    }
  }
  return rect
}
export function materializeExternalTerminal(e: ExternalTerminalEvent): void {
  // Which canvas does this terminal belong to?
  //
  // The event carries a spaceId; this used to ignore it and re-derive the workspace from the
  // FOLDER instead. For a mesh spawn that was wrong twice over: an agent that guessed a cwd
  // ("open a codex in C:/tmp") sent its new panel to a different — sometimes freshly invented —
  // workspace, so the agent booted, joined the roster and answered prompts while being nowhere
  // on the user's canvas. It looked like the terminal "didn't open" when it had simply opened
  // somewhere invisible.
  //
  // So: an EXISTING space named by the event wins (that's the requester's canvas). Only when the
  // event names no known space do we fall back to the folder rule, which is what the phone needs.
  const known = useSpacesStore.getState().spaces.some((s) => s.id === e.spaceId)
  const spaceId = known ? e.spaceId : ensureWorkspaceFor(e.folderPath ?? null)
  const tab: TerminalTab = {
    id: e.terminalId,
    cwd: e.cwd || e.folderPath || undefined,
    bootCommand: e.bootCommand || undefined,
    title: e.name && e.name !== 'Terminal' ? e.name : undefined,
  }
  // Seed BEFORE the panel mounts so TerminalEngine.getOrCreate reattaches (byPanel hit) instead
  // of spawning a duplicate shell.
  useTerminalStore.getState().attach(e.terminalId, {
    ptyId: e.ptyId,
    pid: e.pid,
    shellName: e.shellName,
    status: 'ready',
    cwd: e.cwd || e.folderPath || undefined,
    panelId: e.panelId,
  })
  const panel = {
    id: e.panelId,
    type: 'terminal' as const,
    rect: placeExternalPanel(e),
    z: Date.now() % 1000 + 10,
    title: e.name && e.name !== 'Terminal' ? e.name : 'Terminal',
    props: { tabs: [tab], activeTabId: tab.id, terminalNumber: undefined, origin: e.origin },
  }
  const spaces = useSpacesStore.getState().spaces
  const next = spaces.map((s) =>
    s.id === spaceId ? { ...s, panels: [...s.panels, panel] } : s,
  )
  useSpacesStore.setState({ spaces: next })
  // If the materialized workspace is the active one, insert the panel into the live canvas
  // SURGICALLY — a replaceAll from the spaces copy would wipe docks/groups that live only in
  // the live store (same class of bug as removeExternalTerminal).
  const activeId = useSpacesStore.getState().activeId
  if (activeId === spaceId) usePanelStore.getState().insertPanel(panel)
  // Only the PHONE gets a toast. A mesh spawn (originPanelId set) appears right next to the agent
  // that asked for it, on the canvas the user is looking at — announcing it, and announcing it as
  // "from your phone", is both redundant and wrong.
  if (!e.originPanelId) {
    const spaceName = next.find((s) => s.id === spaceId)?.name ?? 'workspace'
    useToastStore.getState().push({
      title: activeId === spaceId ? `Created “${e.name ?? 'Agent'}” from your phone` : `Created “${e.name ?? 'Agent'}” in ${spaceName} (from your phone)`,
      kind: 'info',
      ttlMs: 5000,
    })
  }
}

/**
 * Materialize every pending panel recorded while PLANO was closed. Returns true when any were
 * materialized. Call AFTER workspaces restored (so panels join their real workspace) but the
 * sessions were already seeded by restoreSurvivingTerminals (via the extra kept ids).
 */
export async function materializePendingPanels(panels?: ExternalTerminalEvent[]): Promise<boolean> {
  try {
    const list = panels ?? (await window.plano.terminal.pendingPanels()).panels
    if (list.length === 0) return false
    for (const p of list) materializeExternalTerminal(p)
    await window.plano.terminal.clearPendingPanels()
    // Persist the new panels so the workspace files know them (autosave covers it too).
    const { saveCurrent } = await import('@/app/workspaceActions')
    await saveCurrent().catch(() => undefined)
    return true
  } catch {
    return false
  }
}

/** Live subscription: a phone created a terminal while PLANO is running. */
export function subscribeExternalTerminals(): () => void {
  const unsubs = [
    window.plano.terminal.onExternalCreated((e) => {
      materializeExternalTerminal(e)
    }),
    window.plano.terminal.onSessionRemoved((e) => {
      removeExternalTerminal(e.panelId, e.terminalId)
    }),
  ]
  return () => unsubs.forEach((u) => u())
}

/** Drop a terminal's canvas panel after it was closed from the phone (or anywhere). */
export function removeExternalTerminal(panelId: string, terminalId: string): void {
  useTerminalStore.getState().drop(terminalId)
  const next = useSpacesStore
    .getState()
    .spaces.map((s) => ({ ...s, panels: s.panels.filter((p) => p.id !== panelId) }))
  useSpacesStore.setState({ spaces: next })
  // Mirror the removal into the live canvas SURGICALLY. The spaces copy lags the live store
  // (docks/groups live only in the live store until the next flush), so replaceAll-ing from it
  // here would wipe every dock group the user built — the "closing one terminal destroys the
  // group / closes another panel" bug. removePanel touches only the closed panel.
  usePanelStore.getState().removePanel(panelId)
}
