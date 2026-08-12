/**
 * Agent-done sound — a soft chime when a detected AI agent finishes its turn. This is now
 * ONE CONSUMER of the shared agentActivity detector (see agentActivity.ts); it owns only
 * its own cooldown + the agentDoneSound setting. The detector runs across ALL workspaces;
 * the chime is intentionally global (one quiet cue for the whole group).
 */

import { useSettingsStore } from '@/stores/useSettingsStore'
import { playAgentDoneChime } from '@/lib/agentChime'
import { onAgentActivity } from './agentActivity'

/** A group of agents often finishes together. One quiet cue is enough for the whole group. */
const COOLDOWN_MS = 8000

let started = false

export function startAgentDoneSound(): void {
  // Idempotent (dev HMR re-runs App's effect) — wire the subscription exactly once.
  if (started) return
  started = true
  let lastPlayedAt = 0
  onAgentActivity((e) => {
    if (e.type !== 'agent-finished') return
    if (!useSettingsStore.getState().settings.general.agentDoneSound) return
    const now = Date.now()
    if (now - lastPlayedAt < COOLDOWN_MS) return
    lastPlayedAt = now
    playAgentDoneChime()
  })
}
