/**
 * agentActivity — the ONE agent-turn detector, extracted from agentDoneSound (awareness).
 * It watches every detected agent across ALL workspaces and emits two life-cycle events:
 *
 *   agent-finished — the Working → Done transition (phase working→idle while still
 *                    active, confirmed by a hold window). This is the "turn ended" signal.
 *   agent-awaiting  — the mesh reports awaiting-input (the agent is BLOCKED on a
 *                    permission prompt and waiting for someone). Comes from the mesh
 *                    stream (v3 B), not the verdict.
 *
 * Consumers subscribe via onAgentActivity(): the chime is one consumer, the in-app
 * notification is another. The detector itself applies NO cooldown — consumers own their
 * own (the sound groups with a cooldown, the notifier groups with a window).
 *
 * False-positive guards (kept from the original machine):
 *  - a "finished" only fires after the idle phase has HELD for a confirmation window,
 *  - a terminal is only armed once it has actually WORKED in this session,
 *  - each working turn is consumed exactly once when it first reaches idle.
 */

import { useAgentStore } from '@/stores/useAgentStore'
import { subscribeRawMeshEvent, meshPanelFor } from '@/stores/useMeshLinks'

/** How long "idle" must hold before we trust it as a finished turn (~4s continuous quiet). */
const CONFIRM_MS = 4000
/**
 * A turn must have WORKED at least this long to count as one.
 *
 * The mesh state can flap working↔idle on a TUI that repaints its own chrome, and each blip armed
 * a finish. Kept deliberately SHORT: the duplicate storm turned out to be stacked HMR listeners,
 * not flapping, and a 3-second answer is still a real turn worth announcing.
 */
const MIN_WORK_MS = 3000
/** After a finish, the same agent cannot report another one for this long. */
const FINISH_COOLDOWN_MS = 20_000

export interface AgentActivityEvent {
  type: 'agent-finished' | 'agent-awaiting'
  ptyId: string
  /** Canvas panel id hosting the agent ('' when the panel is gone). */
  panelId: string
  kind: string
  /** How long the turn worked, in ms (finished events only). */
  durationMs?: number
}

const listeners = new Set<(e: AgentActivityEvent) => void>()

export function onAgentActivity(cb: (e: AgentActivityEvent) => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

function emit(e: AgentActivityEvent): void {
  for (const listener of listeners) {
    try {
      listener(e)
    } catch {
      /* a broken consumer never takes the detector down */
    }
  }
}

/** Same HMR-proof guard as the notifier: a reloaded module must not add a second detector. */
const GUARD = '__planoAgentActivityStarted'

export function startAgentActivity(): void {
  // Idempotent across BOTH App re-mounts and HMR module reloads — see GUARD.
  const g = globalThis as Record<string, unknown>
  if (g[GUARD]) return
  g[GUARD] = true

  // ── finished: the confirmed working→idle transition ──
  const armed = new Set<string>()
  const pending = new Map<string, ReturnType<typeof setTimeout>>()
  /**
   * Agents whose turns the MESH reports. The daemon's state machine is the honest signal: it
   * fuses worker processes with a content fingerprint (a repainting spinner does NOT count as
   * work) and knows `awaiting-input`. The renderer's `phase` is derived from raw output cadence,
   * which flickers idle mid-turn on any CLI that pauses for an API call — that is what made the
   * chime fire while the agent was still thinking. Once an agent appears on the mesh stream, its
   * verdict is ignored here and only the mesh drives its finish.
   */
  const meshTracked = new Set<string>()

  const cancelPending = (ptyId: string): void => {
    const t = pending.get(ptyId)
    if (t) {
      clearTimeout(t)
      pending.delete(ptyId)
    }
  }

  useAgentStore.subscribe((state) => {
    const cur = state.byPty
    for (const ptyId in cur) {
      const v = cur[ptyId]
      if (!v) continue

      if (!v.active) {
        armed.delete(ptyId)
        cancelPending(ptyId)
        continue
      }

      if (meshTracked.has(ptyId)) continue // the mesh owns this agent's turn boundaries

      if (v.phase === 'working') {
        armed.add(ptyId)
        cancelPending(ptyId) // it resumed — a pending "done" is void
        continue
      }

      // v.active && v.phase === 'idle' — a candidate "done".
      if (!armed.has(ptyId)) continue // never saw a fresh turn work → not a finish
      if (pending.has(ptyId)) continue // already confirming this turn
      armed.delete(ptyId)
      const timer = setTimeout(() => {
        pending.delete(ptyId)
        const still = useAgentStore.getState().byPty[ptyId]
        if (!still?.active || still.phase !== 'idle') return
        emit({ type: 'agent-finished', ptyId, panelId: meshPanelFor(ptyId).panelId, kind: still.kind ?? 'generic-agent' })
      }, CONFIRM_MS)
      pending.set(ptyId, timer)
    }
  })

  // ── the mesh state stream: the authoritative turn boundary + the awaiting-input block ──
  let prevAwaiting = new Set<string>()
  /**
   * Last state we know per agent, INCLUDING agents that were already working before this window
   * opened. Waiting to witness a `working` event meant every app restart (or reload) disarmed
   * every in-flight turn: the agent finished, the mesh said `idle`, and we ignored it because we
   * had never seen it start. The snapshot seeds this map so a turn already under way still ends.
   */
  const lastState = new Map<string, string>()
  const workStartedAt = new Map<string, number>()
  const lastFinishAt = new Map<string, number>()
  void window.plano.agentMesh
    .getSnapshot()
    .then((snap) => {
      for (const a of snap.agents) {
        const phase = a.verdict?.active ? (a.verdict.phase ?? 'idle') : 'idle'
        lastState.set(a.ptyId, phase)
        if (phase === 'working') workStartedAt.set(a.ptyId, Date.now())
      }
    })
    .catch(() => {
      /* no snapshot (main not ready) — live events still populate the map */
    })
  const meshArmed = new Set<string>()
  const meshPending = new Map<string, ReturnType<typeof setTimeout>>()

  subscribeRawMeshEvent((ev) => {
    if (ev.kind !== 'state' || !ev.from) return
    const ptyId = ev.from
    const state = ev.detail

    if (typeof state === 'string' && state) lastState.set(ptyId, state)

    if (state === 'working') {
      // Ownership passes to the mesh ONLY once it has proven it reports this agent's turns —
      // i.e. when we see a real `working`. Claiming it on any state (the `idle` every terminal
      // emits at registration) silenced agents whose busy signal the daemon never raises: the
      // verdict path was switched off and the mesh path never armed. Neither fired.
      meshTracked.add(ptyId)
      armed.delete(ptyId)
      cancelPending(ptyId)
      if (!meshArmed.has(ptyId)) workStartedAt.set(ptyId, Date.now())
      meshArmed.add(ptyId)
      const t = meshPending.get(ptyId)
      if (t) {
        clearTimeout(t)
        meshPending.delete(ptyId)
      }
    } else if (state === 'idle') {
      // Only a turn we SAW work counts, and only once it has held idle for the confirm window —
      // the same rule the wait primitive uses server-side. Plus the two guards that stop a
      // repainting TUI from manufacturing finishes: it must have worked long enough to be a turn,
      // and the same agent cannot finish twice inside the cooldown.
      // A turn ended if the LAST state we knew was `working` — whether we witnessed the start or
      // inherited it from the snapshot. `meshArmed` alone missed every turn already in flight.
      const wasWorking = meshArmed.has(ptyId) || lastState.get(ptyId) === 'working'
      const started = workStartedAt.get(ptyId)
      const workedMs = started ? Date.now() - started : MIN_WORK_MS
      const cooling = Date.now() - (lastFinishAt.get(ptyId) ?? 0) < FINISH_COOLDOWN_MS
      if (wasWorking && !meshPending.has(ptyId) && workedMs >= MIN_WORK_MS && !cooling) {
        meshArmed.delete(ptyId)
        const timer = setTimeout(() => {
          meshPending.delete(ptyId)
          lastFinishAt.set(ptyId, Date.now())
          const verdict = useAgentStore.getState().byPty[ptyId]
          emit({
            type: 'agent-finished',
            ptyId,
            panelId: meshPanelFor(ptyId).panelId,
            kind: verdict?.kind ?? meshPanelFor(ptyId).kind ?? 'generic-agent',
            durationMs: workedMs,
          })
        }, CONFIRM_MS)
        meshPending.set(ptyId, timer)
      } else if (wasWorking && workedMs < MIN_WORK_MS) {
        // A blip, not a turn — drop the arm so the next real `working` restarts the clock.
        meshArmed.delete(ptyId)
      }
    } else if (state === 'exited') {
      meshArmed.delete(ptyId)
      meshTracked.delete(ptyId)
      const t = meshPending.get(ptyId)
      if (t) {
        clearTimeout(t)
        meshPending.delete(ptyId)
      }
    } else if (state === 'awaiting-input') {
      // Blocked is never finished (the chain/wait rule): cancel any pending confirmation.
      const t = meshPending.get(ptyId)
      if (t) {
        clearTimeout(t)
        meshPending.delete(ptyId)
      }
    }

    const nowAwaiting = new Set(prevAwaiting)
    if (state === 'awaiting-input') nowAwaiting.add(ptyId)
    else nowAwaiting.delete(ptyId)
    for (const ptyId of nowAwaiting) {
      if (!prevAwaiting.has(ptyId)) {
        emit({ type: 'agent-awaiting', ptyId, panelId: meshPanelFor(ptyId).panelId, kind: meshPanelFor(ptyId).kind })
      }
    }
    prevAwaiting = nowAwaiting
  })
}
