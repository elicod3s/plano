/**
 * Terminal hibernation — the renderer half of the fix for "many open workspaces make PLANO
 * choke". The other halves are main (PtyManager keeps a detached PTY alive + fed to detection,
 * and STILL posts terminalExit / agentSignal so the renderer stays truthful) and this module.
 *
 * Problem being solved: every terminal that has EVER been visited keeps a live xterm `Terminal`
 * + WebGL context + PTY stream + a clutch of per-session store subscriptions alive in the
 * renderer, FOREVER — across workspace switches, until the tab is closed. With many workspaces
 * each hosting several terminal panels, that means dozens of WebGL contexts (Chromium caps the
 * number of live GL contexts per renderer process; past it they get force-evicted → churn),
 * dozens of xterm parsers all being fed continuously, and dozens of per-session subscriptions
 * firing on every unrelated panel/viewport change. The renderer (or the GPU process) eventually
 * runs out of runway and the app "se pets".
 *
 * Hibernation rests on infrastructure PLANO already ships for a different reason (dev HMR
 * reload): main's PtyManager can be `detach`ed (it stops streaming `terminal:data` to the
 * renderer, keeps the bounded 512 KB replay buffer, and keeps feeding detection/history/devUrls),
 * and re-`attach`ed (it replays the buffer once and re-posts the current agent verdict). The
 * renderer's `getOrCreate` session path already handles "store entry exists but no live
 * xterm → reattachPty → replay" exactly for the HMR case.
 *
 * So on a workspace switch we hibernate every terminal of the workspace being LEFT: tell main to
 * detach, and dispose the renderer-side xterm session (freeing its WebGL context, its parser and
 * its subscriptions) — while KEEPING the `useTerminalStore` runtime entry. Returning to that
 * workspace mounts its panels again, `getOrCreate` finds the kept entry, `reattachPty` asks main
 * to attach → replays up to 512 KB → the screen is reconstructed, and the live stream resumes.
 * Agent detection keeps running in main the whole time (work keeps going), so an agent's turn in
 * a background workspace keeps producing files/output even though its terminal panel is gone
 * from the renderer.
 *
 * The hibernation supervisor wires ONCE and applies the (rare) terminalExit / agentSignal events
 * main now posts for detached PTYs to terminals that have NO live session — keeping the
 * `useTerminalStore` exit status and the `useAgentStore` verdict (and therefore the TopBar
 * running-agents roster, which spans background workspaces) truthful while a terminal is
 * hibernated. Live sessions also receive those same events through their own session wiring, so
 * the supervisor short-circuits for any terminal the engine still has a live session for (no
 * double-apply, no double-capture).
 *
 * Gated by the `terminal.autoSuspendIdle` setting (default ON). The setting doubles as a safety
 * valve: turning it OFF restores the original "every visited terminal stays live forever"
 * behaviour should a workspace ever feel wrong on return.
 */

import { useTerminalStore } from '@/stores/useTerminalStore'
import { useAgentStore } from '@/stores/useAgentStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { usePanelStore } from '@/stores/usePanelStore'
import { terminalEngine } from '@/panels/terminal/engine'
import { resolveAndPersistAgentSession } from './agentSessionPersistence'
import type { Panel, TerminalProps } from '@shared/domain/panel'

/** Is the safety-valve setting on? (read live so a mid-session toggle takes effect.) */
function hibernationEnabled(): boolean {
  return !!useSettingsStore.getState().settings.terminal.autoSuspendIdle
}

// Even when eager background hibernation is disabled, stability wins over keeping an unlimited
// number of invisible xterm renderers alive. Shells and agents are never stopped by this budget.
const MAX_LIVE_RENDERER_TERMINALS = 6

function hibernateTerminal(termId: string): void {
  const runtime = useTerminalStore.getState().byPanel[termId]
  if (runtime) window.plano.terminal.detach(runtime.ptyId)
  terminalEngine.dispose(termId)
}

function reclaimBackgroundTerminalRenderers(force = false): void {
  const sessions = terminalEngine.liveSessions()
  const activePanels = new Set(Object.keys(usePanelStore.getState().panels))
  const background = sessions.filter(({ panelId }) => !activePanels.has(panelId))
  const reclaimCount = force
    ? background.length
    : Math.min(background.length, Math.max(0, sessions.length - MAX_LIVE_RENDERER_TERMINALS))

  for (let i = 0; i < reclaimCount; i += 1) {
    hibernateTerminal(background[i].termId)
  }
}

/** The terminal tabs of a space's terminal panels, each as { panelId, termId }. */
function spaceTerminalTabs(panels: Panel[]): Array<{ panelId: string; termId: string }> {
  const out: Array<{ panelId: string; termId: string }> = []
  for (const panel of panels) {
    if (panel.type !== 'terminal') continue
    const tabs = (panel.props as TerminalProps).tabs
    if (!tabs) continue
    for (const tab of tabs) out.push({ panelId: panel.id, termId: tab.id })
  }
  return out
}

/**
 * Hibernate every LIVE terminal session of the workspace being left. Idempotent and a no-op for
 * any terminal whose panel is ALSO present in the now-active canvas (the edge case of a workspace
 * reused in place). The PTY keeps running in main; only the renderer representation is torn down.
 * Call AFTER the new canvas has been loaded into the panel store.
 */
export function hibernateWorkspaceTerminals(leftPanels: Panel[]): void {
  const eager = hibernationEnabled()
  const stillLive = usePanelStore.getState().panels
  for (const { panelId, termId } of spaceTerminalTabs(leftPanels)) {
    if (stillLive[panelId]) continue // a panel still on the active canvas must stay live
    if (!eager) continue
    if (!terminalEngine.has(termId)) continue
    const runtime = useTerminalStore.getState().byPanel[termId]
    // Keep the store entry — it's the pointer the wake path reattaches with. Dispose only the
    // renderer session (xterm + WebGL + subscriptions) and tell main to stop streaming (the PTY
    // keeps running + keeps feeding detection). A tab that never mounted has no runtime yet, so
    // nothing live in main to detach — skip the IPC and just dispose the (phantom) session.
    if (runtime) void window.plano.terminal.detach(runtime.ptyId)
    terminalEngine.dispose(termId)
  }
  reclaimBackgroundTerminalRenderers()
}

/** Reverse-lookup the terminal id that owns a PTY — used by the supervisor to route events. */
function termIdForPty(ptyId: string): string | null {
  for (const [termId, rt] of Object.entries(useTerminalStore.getState().byPanel)) {
    if (rt.ptyId === ptyId) return termId
  }
  return null
}

let supervisorStarted = false
/** Last agent kind seen per pty, so the supervisor only (re)captures on a real kind flip. */
const supervisorSeenKind: Record<string, string | undefined> = {}

/**
 * Start the singleton hibernation supervisor. Subscribes to the (rare) terminalExit / agentSignal
 * events main posts for DETACHED PTYs and applies them to terminals with no live session. Live
 * sessions also receive these events and short-circuit the supervisor (`terminalEngine.has`), so a
 * terminal is never double-processed. Call once (from App). Idempotent.
 */
export function startHibernationSupervisor(): void {
  if (supervisorStarted) return
  supervisorStarted = true

  // Turning eager suspension on should take effect immediately, without waiting for another switch.
  useSettingsStore.subscribe((state, previous) => {
    if (
      state.settings.terminal.autoSuspendIdle &&
      !previous.settings.terminal.autoSuspendIdle
    ) reclaimBackgroundTerminalRenderers(true)
  })

  // terminalExit: a hibernated terminal's shell finished in the background. Mark its runtime
  // exited + clear the stale verdict so the running-agents roster, the TopBar, and the
  // close-confirmations stay correct (and the wake path already reports "[process exited]" from
  // main's attach() → reattachPty).
  window.plano.terminal.onExit(({ ptyId }) => {
    const termId = termIdForPty(ptyId)
    if (!termId || terminalEngine.has(termId)) return // live session owns this event
    useTerminalStore.getState().setStatus(termId, 'exited')
    useAgentStore.getState().clear(ptyId)
    delete supervisorSeenKind[ptyId]
  })

  // agentSignal: a background workspace's agent flipped verdict (gained/lost/phase). Keep the
  // store verdict live (the TopBar roster spans background workspaces) and, on a real kind flip,
  // capture the resumable session ref into the owning workspace snapshot — the feature that a
  // terminal in a background workspace keeps its agentSession patched.
  window.plano.agent.onSignal(({ ptyId, verdict }) => {
    const termId = termIdForPty(ptyId)
    if (!termId || terminalEngine.has(termId)) return // live session owns this event

    useAgentStore.getState().setVerdict(ptyId, verdict)

    if (!verdict.active || !verdict.kind) {
      delete supervisorSeenKind[ptyId]
      return
    }
    const kind = verdict.kind
    if (supervisorSeenKind[ptyId] === kind) return // capture once per conversation kind, not per phase
    const panelId = useTerminalStore.getState().byPanel[termId]?.panelId ?? null
    void resolveAndPersistAgentSession(panelId, termId, ptyId).then((ok) => {
      // Only lock the kind in once we persisted a real ref, so a transient null resolve retries
      // on the next signal (the agent's own working↔idle cycle provides those) until it converges.
      if (ok) supervisorSeenKind[ptyId] = kind
    })
  })
}