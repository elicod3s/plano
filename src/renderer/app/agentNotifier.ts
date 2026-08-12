/**
 * agentNotifier — the in-app awareness notifications. Consumes agentActivity (finished /
 * awaiting) and pushes toasts. Rules:
 *  - a "finished" agent in the ACTIVE workspace is already visible (tinted border, status
 *    dot, mesh link) → no toast; only backgrounded agents notify.
 *  - finishes that land together group into ONE toast ("3 agents finished") that opens the
 *    Agent Manager.
 *  - "awaiting input" notifies EVERYWHERE (also the active workspace — the most urgent
 *    case: someone is blocked waiting for you) and persists until dismissed.
 *  - clicking a toast jumps to the agent (switchSpace + focusPanel — the established route).
 *  - general.agentDoneNotify gates everything (default ON; the sound has its own setting).
 */

import { AGENTS, type AgentKind } from '@shared/domain/agent'

/**
 * Narrow a mesh/roster kind to a REAL AgentKind, or undefined.
 *
 * These call sites used `e.kind as AgentKind`, which is a lie to the compiler: the mesh roster
 * carries `AgentKind | 'unknown'`, so 'unknown' sailed through the cast into AgentLogo, where the
 * table lookup returned undefined and reading `.icon` crashed the whole renderer. A cast is not a
 * check — validate against the table instead.
 */
function asAgentKind(kind: unknown): AgentKind | undefined {
  return typeof kind === 'string' && kind in AGENTS ? (kind as AgentKind) : undefined
}
import { useToastStore } from '@/stores/useToastStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { usePanelStore } from '@/stores/usePanelStore'
import { useUiStore } from '@/stores/useUiStore'
import { switchSpace } from '@/app/workspaceActions'
import { focusPanel } from '@/app/actions'
import { buildAgentRoster, type RunningAgent } from '@/app/agentRoster'
import { useSpacesStore } from '@/stores/useSpacesStore'
import type { AgentRuntimeDescriptor } from '@shared/domain/agentMesh'
import { onAgentActivity } from './agentActivity'

/** Finishes landing within this window group into one toast. */
const GROUP_MS = 1200
/** Informational toasts auto-dismiss. */
const INFO_TTL_MS = 5000

/**
 * HMR-proof singleton guard. `let started` lives in MODULE scope, so a hot reload resets it while
 * the previous module's subscription stays registered — every reload added another listener and
 * one finish painted a stack of identical toasts. A globalThis flag survives the reload.
 */
const GUARD = '__planoAgentNotifierStarted'

/** What the agent was asked, trimmed to one readable line (the card clamps it to two). */
function promptOf(agent: RunningAgent | undefined): string | undefined {
  const raw = (agent?.lastPrompt || agent?.prompt || '').replace(/\s+/g, ' ').trim()
  if (!raw) return undefined
  return raw.length > 160 ? `${raw.slice(0, 159)}…` : raw
}

/** Where it lives: "Workspace 6 · Terminal 2" — whichever parts we actually know. */
function contextOf(agent: RunningAgent | undefined): string | undefined {
  if (!agent) return undefined
  const parts = [agent.spaceName, typeof agent.terminalNumber === 'number' ? `Terminal ${agent.terminalNumber}` : agent.title]
  const line = parts.filter(Boolean).join(' · ')
  return line || undefined
}

/** ms → "3m 12s" / "45s". Undefined when the turn length is unknown. */
function formatDuration(ms: number | undefined): string | undefined {
  if (!ms || ms < 1000) return undefined
  const total = Math.round(ms / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  return m > 0 ? `${m}m ${s}s` : `${s}s`
}

/**
 * Everything the toast needs about ONE agent, resolved from whichever source actually knows it.
 *
 * The roster is built from `useTerminalStore.byPanel`, which only holds MOUNTED terminals — i.e.
 * the active workspace. For an agent finishing in another workspace (the only case that gets a
 * notification at all) it returns nothing, which is why those toasts arrived with no logo and no
 * location. The mesh knows every live agent regardless of what is mounted, so it is the fallback:
 * its ptyId → panelId map plus the persisted spaces give identity, workspace and terminal.
 */
interface NotifyTarget {
  kind?: AgentKind
  name: string
  accent?: string
  prompt?: string
  context?: string
  inActiveSpace: boolean
  jump: () => void
}

/**
 * The mesh SNAPSHOT is the only source that sees every workspace: it carries the harness verdict,
 * the workspace name, the terminal number and the last prompt for every live agent, mounted or
 * not. The roster (built from mounted terminals) is used only for the extra it has, and the
 * snapshot fills everything else — which is why toasts for other workspaces used to arrive with
 * no logo and no location.
 */
async function resolveTarget(ptyId: string, eventKind: string): Promise<NotifyTarget> {
  let descriptor: AgentRuntimeDescriptor | undefined
  try {
    const snap = await window.plano.agentMesh.getSnapshot()
    descriptor = snap.agents.find((a) => a.ptyId === ptyId)
  } catch {
    /* main not ready — fall through to whatever the renderer knows */
  }
  const agent = buildAgentRoster().find((a) => a.ptyId === ptyId)
  const kind = asAgentKind(descriptor?.verdict?.kind) ?? asAgentKind(agent?.verdict?.kind) ?? asAgentKind(eventKind)
  const activeId = useSpacesStore.getState().activeId

  const where = descriptor
    ? [descriptor.spaceName, descriptor.terminalNumber ? `Terminal ${descriptor.terminalNumber}` : descriptor.tabTitle || descriptor.terminalTitle]
        .filter(Boolean)
        .join(' · ')
    : contextOf(agent)
  const raw = (descriptor?.lastPrompt || descriptor?.firstPrompt || '').replace(/\s+/g, ' ').trim()
  const prompt = raw ? (raw.length > 160 ? `${raw.slice(0, 159)}…` : raw) : promptOf(agent)

  return {
    kind,
    name: kind ? AGENTS[kind].displayName : 'Agent',
    accent: agent?.accent ?? (kind ? AGENTS[kind].accent : undefined),
    prompt,
    context: where || undefined,
    inActiveSpace: descriptor ? descriptor.spaceId === activeId : (agent?.inActiveSpace ?? false),
    jump: () => {
      if (agent) {
        jumpToAgent(agent)
        return
      }
      if (descriptor) {
        if (descriptor.spaceId && descriptor.spaceId !== activeId) switchSpace(descriptor.spaceId)
        if (descriptor.panelId) {
          usePanelStore.getState().setActiveTerminalTab(descriptor.panelId, descriptor.terminalId)
          focusPanel(descriptor.panelId)
        }
        return
      }
      useUiStore.getState().toggleAgentControl()
    },
  }
}

function jumpToAgent(agent: RunningAgent): void {
  if (!agent.inActiveSpace && agent.spaceId) switchSpace(agent.spaceId)
  usePanelStore.getState().setActiveTerminalTab(agent.panelId, agent.termId)
  focusPanel(agent.panelId)
}

export function startAgentNotifier(): void {
  const g = globalThis as Record<string, unknown>
  if (g[GUARD]) return
  g[GUARD] = true

  // Finished events that arrive together — grouped into a single toast.
  let group: Array<{ target: NotifyTarget; ptyId: string; durationMs?: number }> = []
  let groupTimer: ReturnType<typeof setTimeout> | null = null

  const flush = (): void => {
    groupTimer = null
    const items = group
    group = []
    if (items.length === 0) return
    const { push } = useToastStore.getState()
    if (items.length === 1) {
      const { target, ptyId, durationMs } = items[0]
      push({
        title: `${target.name} finished`,
        prompt: target.prompt,
        context: target.context,
        duration: formatDuration(durationMs),
        kind: 'finished',
        accent: target.accent,
        agentKind: target.kind,
        ttlMs: INFO_TTL_MS,
        // One live "finished" card at a time: a repeat refreshes it in place instead of stacking.
        dedupeKey: `finished:${ptyId}`,
        onClick: target.jump,
      })
    } else {
      // The group names WHO finished and WHERE — "2 agents finished" alone tells the user nothing.
      const names = [...new Set(items.map((i) => i.target.name))].join(' · ')
      const wheres = [...new Set(items.map((i) => i.target.context).filter(Boolean))] as string[]
      push({
        title: `${items.length} agents finished`,
        prompt: names,
        context: wheres.join('  ·  '),
        count: items.length,
        kind: 'finished',
        ttlMs: INFO_TTL_MS,
        dedupeKey: 'finished:group',
        onClick: () => useUiStore.getState().toggleAgentControl(),
      })
    }
  }

  onAgentActivity(async (e) => {
    // The release runs BEFORE the settings gate and without resolving a target: a "needs you" card
    // already on screen must come down even if notifications were switched off, or the panel was
    // closed, since nothing else will ever retire it.
    if (e.type === 'agent-attended') {
      useToastStore.getState().dismissKey(`awaiting:${e.ptyId}`)
      return
    }
    if (!useSettingsStore.getState().settings.general.agentDoneNotify) return
    const t = await resolveTarget(e.ptyId, e.kind)

    if (e.type === 'agent-finished') {
      // Only skip what the user can ACTUALLY see: the agent's workspace is the one on screen AND
      // the window has focus. Looking away — another app, another window — is exactly when a
      // finish is worth announcing, even for the workspace that is technically open.
      if (t.inActiveSpace && document.hasFocus()) return
      group.push({ target: t, ptyId: e.ptyId, durationMs: e.durationMs })
      if (!groupTimer) groupTimer = setTimeout(flush, GROUP_MS)
      return
    }

    // awaiting-input: the most urgent signal — notify everywhere, persist until attended.
    useToastStore.getState().push({
      title: `${t.name} needs you`,
      prompt: t.prompt,
      context: t.context,
      duration: 'waiting',
      kind: 'awaiting',
      dedupeKey: `awaiting:${e.ptyId}`,
      accent: t.accent,
      agentKind: t.kind,
      ttlMs: 0,
      onClick: t.jump,
    })
  })
}
