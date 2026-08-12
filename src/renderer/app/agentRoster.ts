/**
 * agentRoster — the ONE cross-workspace join that turns the three runtime stores into a list of
 * running agents, each resolved to its panel/terminal/workspace. Shared by AgentManager (the
 * TopBar quick roster) and AgentControlCenter (the full mesh UI) so they can never drift apart.
 */

import { useTerminalStore } from '@/stores/useTerminalStore'
import { useAgentStore } from '@/stores/useAgentStore'
import { usePanelStore } from '@/stores/usePanelStore'
import { useSpacesStore } from '@/stores/useSpacesStore'
import { useMeshAwaiting } from '@/stores/useMeshLinks'
import { useEffect, useMemo, useState } from 'react'
import { getPersistedTerminalTab } from '@/app/agentSessionPersistence'
import { AGENTS, type AgentKind, type AgentVerdict } from '@shared/domain/agent'

/** A running agent resolved to the panel/space it lives in (its PTY may be in a backgrounded space). */
export interface RunningAgent {
  panelId: string
  /** The specific terminal (tab) inside the panel that hosts this agent. */
  termId: string
  ptyId: string
  verdict: AgentVerdict
  prompt: string
  lastPrompt: string
  /** Panel title (the terminal's name on the canvas). */
  title: string
  /** Terminal number badge (e.g. "Terminal 2"), when the panel carries one. */
  terminalNumber?: number
  spaceId: string | null
  spaceName: string | null
  inActiveSpace: boolean
  /** The agent's brand accent (for tiles/rows). */
  accent: string
}

/** Join the three runtime stores into the full running-agent roster, active-space first. */
export function buildAgentRoster(): RunningAgent[] {
  const sessions = useTerminalStore.getState().byPanel
  const verdicts = useAgentStore.getState().byPty
  const prompts = useAgentStore.getState().promptByPty
  const lastPrompts = useAgentStore.getState().lastPromptByPty
  const panels = usePanelStore.getState().panels
  const { spaces, activeId } = useSpacesStore.getState()

  const out: RunningAgent[] = []
  for (const [termId, rt] of Object.entries(sessions)) {
    const verdict = verdicts[rt.ptyId]
    if (!verdict?.active) continue

    const panelId = rt.panelId
    let title = 'Terminal'
    let terminalNumber: number | undefined
    let spaceId: string | null = null
    let spaceName: string | null = null
    let inActiveSpace = false

    const live = panels[panelId]
    if (live) {
      title = live.title || 'Terminal'
      terminalNumber = (live.props as { terminalNumber?: number }).terminalNumber
      spaceId = activeId
      spaceName = spaces.find((s) => s.id === activeId)?.name ?? null
      inActiveSpace = true
    } else {
      for (const sp of spaces) {
        const p = sp.panels.find((pp) => pp.id === panelId)
        if (p) {
          title = p.title || 'Terminal'
          terminalNumber = (p.props as { terminalNumber?: number }).terminalNumber
          spaceId = sp.id
          spaceName = sp.name
          break
        }
      }
    }
    // Prefer the terminal TAB's smart title (the task label) over the panel title, so the
    // roster/mesh shows WHAT the agent is doing, not just which panel it lives in.
    const tabTitle = getPersistedTerminalTab(panelId, termId)?.title
    if (tabTitle) title = tabTitle

    const kind = verdict.kind ?? 'generic-agent'
    out.push({
      panelId,
      termId,
      ptyId: rt.ptyId,
      verdict,
      prompt: prompts[rt.ptyId] ?? '',
      lastPrompt: lastPrompts[rt.ptyId] ?? '',
      title,
      terminalNumber,
      spaceId,
      spaceName,
      inActiveSpace,
      accent: AGENTS[kind].accent,
    })
  }
  // Active-space agents first, then alphabetical by title so the roster reads stably.
  return out.sort((a, b) => {
    if (a.inActiveSpace !== b.inActiveSpace) return a.inActiveSpace ? -1 : 1
    return a.title.localeCompare(b.title)
  })
}

/** Per-workspace REAL agent counts (awareness): total / working / awaiting-input.
 *  awaiting-input OUTRANKS working (the amber dot wins). `accent` is the first active
 *  agent's brand color, for the quiet status dot. */
export interface WorkspaceAgentCounts {
  total: number
  working: number
  awaiting: number
  accent?: string
}

export function workspaceAgentCounts(
  roster: RunningAgent[],
  awaitingByPty: ReadonlyMap<string, string>,
): Map<string, WorkspaceAgentCounts> {
  const counts = new Map<string, WorkspaceAgentCounts>()
  for (const a of roster) {
    const key = a.spaceId ?? ''
    const c = counts.get(key) ?? { total: 0, working: 0, awaiting: 0 }
    c.total += 1
    if (awaitingByPty.get(a.ptyId) === 'awaiting-input') {
      c.awaiting += 1
      c.accent ??= a.accent
    } else if (a.verdict.phase === 'working') {
      c.working += 1
      c.accent ??= a.accent
    }
    counts.set(key, c)
  }
  return counts
}

/** What a workspace row shows: WHICH harnesses live there and whether any is busy or blocked. */
export interface WorkspaceAgentSummary {
  /** Distinct harnesses present, most-recently-active first, for the row's brand marks. */
  kinds: AgentKind[]
  /** ONE entry per live agent (repeats a harness when several run) — the row draws one mark each,
   *  so the count is READ BY COUNTING, never as a numeral that could bind to the next word. */
  each: AgentKind[]
  total: number
  working: number
  awaiting: number
}

/**
 * Per-workspace agent summary from the MESH SNAPSHOT — the only source that sees workspaces whose
 * terminals are not mounted. `useWorkspaceAgentCounts` derives from the roster, so every
 * background workspace read as empty: exactly the ones the switcher exists to tell you about.
 * Refreshed on mesh traffic (throttled) rather than polled.
 */
export function useWorkspaceAgentSummaries(): Map<string, WorkspaceAgentSummary> {
  const [summaries, setSummaries] = useState<Map<string, WorkspaceAgentSummary>>(() => new Map())
  const awaiting = useMeshAwaiting()

  useEffect(() => {
    let alive = true
    const load = async (): Promise<void> => {
      try {
        const snap = await window.plano.agentMesh.getSnapshot()
        if (!alive) return
        const next = new Map<string, WorkspaceAgentSummary>()
        for (const a of snap.agents) {
          if (a.status === 'exited' || !a.verdict?.active) continue
          const key = a.spaceId ?? ''
          const entry = next.get(key) ?? { kinds: [], each: [], total: 0, working: 0, awaiting: 0 }
          entry.total += 1
          const kind = a.verdict.kind
          if (kind) {
            entry.each.push(kind)
            if (!entry.kinds.includes(kind)) entry.kinds.push(kind)
          }
          // The MESH state is the live one (the daemon fuses worker processes with content
          // change); the snapshot's own verdict is the app's detector, which for a background
          // workspace is almost always a stale `idle` — that is why "working" never showed.
          const meshState = awaiting.get(a.ptyId)
          if (meshState === 'awaiting-input') entry.awaiting += 1
          else if (meshState === 'working' || (!meshState && a.verdict.phase === 'working')) entry.working += 1
          next.set(key, entry)
        }
        setSummaries(next)
      } catch {
        /* main not ready — keep the previous summary rather than blanking the menu */
      }
    }
    void load()
    const t = setInterval(load, 4000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [awaiting])

  return summaries
}

/** Subscribe to the DERIVED per-workspace counts — never to the roster/verdict maps whole. */
export function useWorkspaceAgentCounts(): Map<string, WorkspaceAgentCounts> {
  const verdicts = useAgentStore((s) => s.byPty)
  const awaiting = useMeshAwaiting()
  return useMemo(() => workspaceAgentCounts(buildAgentRoster(), awaiting), [verdicts, awaiting])
}
