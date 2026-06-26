/**
 * Gemini intent path — the primary "engine". It turns free speech into a structured action so Odla
 * can open and move whatever you describe. The call is made in MAIN (key + no CORS); here we just
 * build a compact canvas snapshot for reference resolution and map the returned JSON to an Intent.
 * Anything Gemini can't do (off / unreachable / slow / invalid) falls back to the local fuzzy grammar.
 */
import type { PanelType } from '@shared/domain/panel'
import type { TerminalProps } from '@shared/domain/panel'
import type { AgentKind } from '@shared/domain/agent'
import { AGENTS } from '@shared/domain/agent'
import { usePanelStore } from '@/stores/usePanelStore'
import { useAgentStore } from '@/stores/useAgentStore'
import { useTerminalStore } from '@/stores/useTerminalStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { resolveSiteUrl } from './synonyms'
import type { Intent, Target } from './types'

const CREATABLE: PanelType[] = ['terminal', 'editor', 'browser', 'agent', 'git', 'markdown', 'todo', 'pomodoro', 'sticky', 'region', 'label']

/** Spoken agent word → its launch command + kind + display (mirrors AGENTS_SPOKEN). */
const AGENT_BY_WORD: Record<string, { command: string; kind: AgentKind; display: string }> = {
  claude: { command: 'claude', kind: 'claude-code', display: 'Claude Code' },
  codex: { command: 'codex', kind: 'codex', display: 'Codex' },
  gemini: { command: 'gemini', kind: 'gemini-cli', display: 'Gemini' },
  kiro: { command: 'kiro-cli chat', kind: 'kiro-cli', display: 'Kiro CLI' },
  opencode: { command: 'opencode', kind: 'opencode', display: 'opencode' },
  aider: { command: 'aider', kind: 'aider', display: 'Aider' },
}

function agentInfo(word?: string): { command: string; kind: AgentKind; display: string } | null {
  if (!word) return null
  const w = word.toLowerCase().trim()
  for (const key of Object.keys(AGENT_BY_WORD)) if (w.includes(key)) return AGENT_BY_WORD[key]
  return null
}

/** Active agent kind running in a terminal panel (via its active tab's ptyId), or null. */
function agentOfTerminal(panelId: string): AgentKind | null {
  const props = usePanelStore.getState().panels[panelId]?.props as TerminalProps | undefined
  const tabId = props?.activeTabId ?? props?.tabs?.[0]?.id
  const ptyId = tabId ? useTerminalStore.getState().byPanel[tabId]?.ptyId : undefined
  const v = ptyId ? useAgentStore.getState().byPty[ptyId] : undefined
  return v?.active ? v.kind : null
}

/** A compact, model-friendly description of the live canvas so Gemini can resolve references. */
export function buildContext(): string {
  const panels = Object.values(usePanelStore.getState().panels).filter((p) => !p.dockedIn && p.type !== 'region' && p.type !== 'label' && p.type !== 'group')
  const front = panels.slice().sort((a, b) => b.z - a.z)[0]
  const lines: string[] = []
  const terminals = panels.filter((p) => p.type === 'terminal')
  for (const t of terminals.sort((a, b) => ((a.props as TerminalProps).terminalNumber ?? 99) - ((b.props as TerminalProps).terminalNumber ?? 99))) {
    const n = (t.props as TerminalProps).terminalNumber
    const kind = agentOfTerminal(t.id)
    const tag = kind ? ` running ${AGENTS[kind].displayName}` : ''
    lines.push(`- terminal #${n ?? '?'}${tag}${front?.id === t.id ? ' (focused)' : ''}`)
  }
  const others = panels.filter((p) => p.type !== 'terminal')
  const counts = new Map<string, number>()
  for (const p of others) counts.set(p.type, (counts.get(p.type) ?? 0) + 1)
  for (const [type, c] of counts) lines.push(`- ${c} ${type}${c > 1 ? 's' : ''}${front?.type === type ? ' (one focused)' : ''}`)
  if (lines.length === 0) return 'The canvas is empty.'
  return lines.join('\n')
}

function toTarget(t: unknown): Target | null {
  if (!t || typeof t !== 'object') return null
  const o = t as { kind?: string; n?: number; type?: string; agent?: string; scope?: string }
  switch (o.kind) {
    case 'number':
      return typeof o.n === 'number' ? { sel: 'number', n: o.n } : null
    case 'agent': {
      const a = agentInfo(o.agent)
      return a ? { sel: 'agent', kind: a.kind } : null
    }
    case 'all':
      return { sel: 'all' }
    case 'last':
      return { sel: 'last' }
    case 'front':
      return { sel: 'front' }
    case 'type':
      return o.type && CREATABLE.includes(o.type as PanelType)
        ? { sel: 'type', type: o.type as PanelType, scope: o.scope === 'all' ? 'all' : 'one' }
        : null
    default:
      return null
  }
}

/** Map a Gemini action object to a known Intent. Returns null when it isn't actionable → fuzzy. */
export function actionToIntent(a: Record<string, unknown>): Intent | null {
  const action = String(a.action || '')
  const num = (v: unknown): number | undefined => (typeof v === 'number' && isFinite(v) ? v : undefined)
  switch (action) {
    case 'create': {
      // Gemini sometimes puts the agent under target.agent instead of top-level — accept both.
      const agentWord =
        (typeof a.agent === 'string' ? a.agent : undefined) ??
        (a.target && typeof a.target === 'object' ? (a.target as { agent?: string }).agent : undefined)
      const ag = agentInfo(agentWord)
      const count = Math.max(1, Math.min(12, num(a.count) ?? 1))
      if (ag) return { kind: 'create', type: 'terminal', count, bootCommand: ag.command, noun: ag.display }
      const panel = typeof a.panel === 'string' && CREATABLE.includes(a.panel as PanelType) ? (a.panel as PanelType) : null
      if (!panel) return null
      if (panel === 'browser') {
        const url = typeof a.url === 'string' && a.url ? a.url : typeof a.text === 'string' ? resolveSiteUrl(a.text) : undefined
        return { kind: 'create', type: 'browser', count, url }
      }
      return { kind: 'create', type: panel, count, text: typeof a.text === 'string' ? a.text : undefined }
    }
    case 'close': {
      const target = toTarget(a.target)
      return target ? { kind: 'close', target } : null
    }
    case 'focus': {
      const target = toTarget(a.target)
      return target ? { kind: 'focus', target } : null
    }
    case 'prompt': {
      const target = toTarget(a.target)
      const text = typeof a.text === 'string' ? a.text.trim() : ''
      return target && text ? { kind: 'prompt', target, text } : null
    }
    case 'arrange':
      return { kind: 'arrange' }
    case 'view':
      return ['fit', 'reset', 'zoomIn', 'zoomOut'].includes(String(a.value))
        ? { kind: 'view', action: a.value as 'fit' | 'reset' | 'zoomIn' | 'zoomOut' }
        : null
    case 'workspace':
      return ['new', 'open', 'save', 'close'].includes(String(a.workspaceAction))
        ? { kind: 'workspace', action: a.workspaceAction as 'new' | 'open' | 'save' | 'close' }
        : null
    case 'toggle':
      return ['minimap', 'snapping', 'palette', 'settings'].includes(String(a.value))
        ? { kind: 'toggle', what: a.value as 'minimap' | 'snapping' | 'palette' | 'settings' }
        : null
    case 'space': {
      const v = String(a.value)
      if (v === 'next' || v === 'prev' || v === 'new' || v === 'close') return { kind: 'space', op: v }
      const idx = num(a.count) ?? (a.target && typeof a.target === 'object' ? num((a.target as { n?: unknown }).n) : undefined)
      return typeof idx === 'number' ? { kind: 'space', op: 'goto', index: idx } : null
    }
    case 'undo':
      return { kind: 'undo' }
    case 'query':
      return ['agents', 'panels'].includes(String(a.value)) ? { kind: 'query', what: a.value as 'agents' | 'panels' } : null
    default:
      return null
  }
}

/** Ask Gemini (via main) to interpret the transcript. Returns an Intent, or null to use the fallback. */
export async function geminiInterpret(transcript: string): Promise<Intent | null> {
  const g = useSettingsStore.getState().settings.voice.gemini
  if (!g.enabled || !g.apiKey) return null
  try {
    const res = await window.plano.voice.interpret({
      transcript,
      context: buildContext(),
      apiKey: g.apiKey,
      model: g.model,
    })
    if (!res.ok || !res.action) return null
    return actionToIntent(res.action)
  } catch {
    return null
  }
}
