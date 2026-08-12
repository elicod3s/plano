import type { AgentSessionRef } from '@shared/domain/agent'
import type { TerminalProps, TerminalTab } from '@shared/domain/panel'
import { useAgentStore } from '@/stores/useAgentStore'
import { usePanelStore } from '@/stores/usePanelStore'
import { useSpacesStore } from '@/stores/useSpacesStore'
import { useTerminalStore } from '@/stores/useTerminalStore'

/** Read a terminal tab whether its workspace is on the canvas or currently in the background. */
export function getPersistedTerminalTab(panelId: string, termId: string): TerminalTab | undefined {
  const live = usePanelStore.getState().panels[panelId]
  if (live?.type === 'terminal') {
    const tab = (live.props as TerminalProps).tabs?.find((candidate) => candidate.id === termId)
    if (tab) return tab
  }
  for (const space of useSpacesStore.getState().spaces) {
    const panel = space.panels.find((candidate) => candidate.id === panelId)
    if (panel?.type !== 'terminal') continue
    const tab = (panel.props as TerminalProps).tabs?.find((candidate) => candidate.id === termId)
    if (tab) return tab
  }
  return undefined
}

/**
 * Resolve a detected agent's resumable conversation and patch it into its terminal tab wherever
 * the tab currently lives (live canvas + owning workspace snapshot), deduped against the value
 * already stored so a repeat signal is a no-op. Returns true when it actually persisted a fresh
 * ref, false otherwise (no runtime/panel, agent not resumable, no usable id yet, or unchanged).
 *
 * Shared by the hibernation supervisor (background-workspace terminals whose live session is
 * gone) so a terminal that keeps running in the background — across a space switch — still has
 * its agentSession captured, the same feature the live session's capture loop provides.
 */
export async function resolveAndPersistAgentSession(
  panelId: string | null,
  termId: string,
  ptyId: string,
): Promise<boolean> {
  if (!panelId) return false
  const runtime = useTerminalStore.getState().byPanel[termId]
  if (!runtime || runtime.status === 'exited') return false
  // `byPty` may not carry the verdict here (the supervisor arrives via the signal itself); read
  // the kind back from the verdict on the call site when needed. Resolve by ptyId+cwd in main.
  const cwd = runtime.cwd ?? getPersistedTerminalTab(panelId, termId)?.cwd ?? ''
  let ref: AgentSessionRef | null = null
  try {
    ref = await window.plano.agent.resolveSession(ptyId, cwd)
  } catch {
    return false
  }
  if (!ref) return false
  // The id-required agents always need a usable id; without one resolve can only be a transient
  // miss → the caller retries on the next signal (it never persists until an id exists).
  const needsId = ref.agent === 'claude' || ref.agent === 'codex' || ref.agent === 'gemini'
  if (needsId && !ref.sessionId) return false
  const cur = getPersistedTerminalTab(panelId, termId)?.agentSession
  if (cur && cur.agent === ref.agent && cur.sessionId === ref.sessionId && cur.cwd === ref.cwd) return false
  persistTerminalTabPatch(panelId, termId, { agentSession: ref })
  return true
}

/** Keep the live canvas and the owning workspace snapshot in lockstep. */
export function persistTerminalTabPatch(
  panelId: string,
  termId: string,
  partial: Partial<TerminalTab>,
): void {
  usePanelStore.getState().updateTerminalTab(panelId, termId, partial)
  useSpacesStore.getState().updateTerminalTab(panelId, termId, partial)
}

/**
 * Final close-time safety net. Main may already have resolved an exact session while the renderer's
 * Promise continuation is still queued; pull that cached/current result synchronously and patch all
 * workspace snapshots before `workspaces.saveSync` serializes them.
 */
export function reconcileAgentSessionsBeforeClose(): void {
  for (const [termId, runtime] of Object.entries(useTerminalStore.getState().byPanel)) {
    if (runtime.status === 'exited') continue
    const verdict = useAgentStore.getState().byPty[runtime.ptyId]
    if (!verdict?.active) continue
    const cwd = runtime.cwd ?? getPersistedTerminalTab(runtime.panelId, termId)?.cwd ?? ''
    let ref: AgentSessionRef | null = null
    try {
      ref = window.plano.agent.resolveSessionSync(runtime.ptyId, cwd)
    } catch {
      ref = null
    }
    if (ref) persistTerminalTabPatch(runtime.panelId, termId, { agentSession: ref })
  }
}
