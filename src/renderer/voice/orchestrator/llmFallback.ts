/**
 * OPTIONAL free-form fallback. Off by default — the assistant is fully local & free on the grammar
 * alone. When enabled in Settings → Voice, an utterance the grammar marks `unknown` is sent to an
 * OpenAI-compatible endpoint (a local Ollama by default, so nothing leaves the machine) which
 * returns a single JSON action. We validate it hard and map it back to a known Intent, or give up.
 */
import type { PanelType } from '@shared/domain/panel'
import { useSettingsStore } from '@/stores/useSettingsStore'
import type { Intent } from './types'

const CREATABLE: PanelType[] = ['terminal', 'editor', 'browser', 'agent', 'git', 'markdown', 'todo', 'pomodoro', 'sticky', 'region', 'label']

const SYSTEM = `You translate a user's spoken request into ONE JSON action for the PLANO canvas IDE.
Reply with ONLY a JSON object, no prose. Schemas:
{"action":"create","type":<panel>,"count":<int>}
{"action":"close","type":<panel>,"scope":"one"|"all"}  OR  {"action":"close","it":true}
{"action":"focus","type":<panel>}  OR  {"action":"focus","it":true}
{"action":"view","value":"fit"|"reset"|"zoomIn"|"zoomOut"}
{"action":"workspace","value":"new"|"open"|"save"|"close"}
{"action":"toggle","value":"minimap"|"snapping"|"palette"|"settings"}
{"action":"query","value":"agents"|"panels"}
panel is one of: terminal, editor, browser, agent, git, markdown, todo, pomodoro, sticky, region, label.
If nothing fits, reply {"action":"none"}.`

interface LlmAction {
  action?: string
  type?: string
  count?: number
  scope?: string
  it?: boolean
  value?: string
}

function toIntent(a: LlmAction): Intent | null {
  const type = a.type && CREATABLE.includes(a.type as PanelType) ? (a.type as PanelType) : null
  switch (a.action) {
    case 'create':
      return type ? { kind: 'create', type, count: Math.max(1, Math.min(12, a.count ?? 1)) } : null
    case 'close':
      if (a.it) return { kind: 'close', target: { sel: 'last' } }
      return type ? { kind: 'close', target: { sel: 'type', type, scope: a.scope === 'all' ? 'all' : 'one' } } : null
    case 'focus':
      if (a.it) return { kind: 'focus', target: { sel: 'last' } }
      return type ? { kind: 'focus', target: { sel: 'type', type, scope: 'one' } } : null
    case 'view':
      return ['fit', 'reset', 'zoomIn', 'zoomOut'].includes(a.value ?? '')
        ? { kind: 'view', action: a.value as 'fit' | 'reset' | 'zoomIn' | 'zoomOut' }
        : null
    case 'workspace':
      return ['new', 'open', 'save', 'close'].includes(a.value ?? '')
        ? { kind: 'workspace', action: a.value as 'new' | 'open' | 'save' | 'close' }
        : null
    case 'toggle':
      return ['minimap', 'snapping', 'palette', 'settings'].includes(a.value ?? '')
        ? { kind: 'toggle', what: a.value as 'minimap' | 'snapping' | 'palette' | 'settings' }
        : null
    case 'query':
      return ['agents', 'panels'].includes(a.value ?? '')
        ? { kind: 'query', what: a.value as 'agents' | 'panels' }
        : null
    default:
      return null
  }
}

/** Ask the configured LLM to interpret `text`. Returns a validated Intent, or null on any failure. */
export async function llmInterpret(text: string): Promise<Intent | null> {
  const cfg = useSettingsStore.getState().settings.voice.llmFallback
  if (!cfg.enabled || !cfg.baseUrl) return null
  try {
    const res = await fetch(`${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0,
        stream: false,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: text },
        ],
      }),
    })
    if (!res.ok) return null
    const data = await res.json()
    const content: string = data?.choices?.[0]?.message?.content ?? ''
    const match = content.match(/\{[\s\S]*\}/)
    if (!match) return null
    return toIntent(JSON.parse(match[0]) as LlmAction)
  } catch {
    return null
  }
}
