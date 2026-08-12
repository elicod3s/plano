/**
 * The bilingual, fuzzy command grammar: turn a spoken transcript into a structured Intent. Fully
 * local, instant, deterministic, FREE — and tolerant of speech-to-text noise (a multilingual model
 * mangling English product names). Exact matches win; near-misses resolve via a Levenshtein ratio.
 *
 * Order: specific phrases (arrange/view/workspace/space/toggle/query) → agents (highest-signal) →
 * generic verb + panel type (create/close/focus), with URL extraction for browsers and
 * number/agent/all targeting for close & focus.
 */
import type { PanelType } from '@shared/domain/panel'
import type { AgentKind } from '@shared/domain/agent'
import type { Intent, Target } from './types'
import {
  AGENTS_SPOKEN,
  ALL_WORDS,
  NUMBER_WORDS,
  ORDINAL_WORDS,
  PANEL_PHRASES,
  PRONOUN_WORDS,
  VERBS,
  normalize,
  resolveSiteUrl,
  type AgentSpoken,
} from './synonyms'
import { fuzzyHas, bestFuzzy } from './fuzzy'

/** Exact whole-token containment OR a fuzzy near-match. */
function near(norm: string, phrase: string): boolean {
  return fuzzyHas(norm, phrase)
}
function nearAny(norm: string, phrases: readonly string[]): boolean {
  return phrases.some((p) => near(norm, p))
}

function detectType(norm: string): PanelType | null {
  return bestFuzzy<PanelType>(norm, PANEL_PHRASES)?.key ?? null
}

// Built once from the constant vocab — rebuilding these per utterance (and per ~900ms live partial)
// was pure waste; the source data is fixed for the session.
const AGENT_ENTRIES = AGENTS_SPOKEN.map((a) => [a, a.phrases] as const)
const VERB_ENTRIES = [
  ['create', VERBS.create] as const,
  ['close', VERBS.close] as const,
  ['focus', VERBS.focus] as const,
]

function detectAgent(norm: string): AgentSpoken | null {
  const best = bestFuzzy<AgentSpoken>(norm, AGENT_ENTRIES)
  return best?.key ?? null
}

function detectVerb(norm: string): 'create' | 'close' | 'focus' | null {
  const best = bestFuzzy<'create' | 'close' | 'focus'>(norm, VERB_ENTRIES)
  if (best) return best.key
  // Spanish enclitics fused onto the verb ("ciérralo", "muéstralo").
  if (/\b(cierra|cierr|borra|elimina|quita|mata)l[oae]s?\b/.test(norm)) return 'close'
  if (/\b(enfoca|muestra|ensena|abre)l[oae]s?\b/.test(norm)) return 'focus'
  return null
}

function detectCount(norm: string): number {
  for (const tok of norm.split(' ')) {
    if (/^\d+$/.test(tok)) return Math.max(1, Math.min(12, parseInt(tok, 10)))
    if (tok in NUMBER_WORDS) return NUMBER_WORDS[tok]
  }
  return 1
}

function detectNumberRef(norm: string): number | null {
  for (const tok of norm.split(' ')) {
    if (/^\d+$/.test(tok)) return parseInt(tok, 10)
    if (tok in ORDINAL_WORDS) return ORDINAL_WORDS[tok]
    if (tok in NUMBER_WORDS) return NUMBER_WORDS[tok]
  }
  return null
}

/** A single number token → integer (digit, number word, or ordinal). */
function numToken(t: string): number | null {
  if (/^\d+$/.test(t)) return parseInt(t, 10)
  if (t in NUMBER_WORDS) return NUMBER_WORDS[t]
  if (t in ORDINAL_WORDS) return ORDINAL_WORDS[t]
  return null
}

function agentKindFromWord(w: string): AgentKind | null {
  const x = w.toLowerCase()
  if (x.startsWith('claude') || x.startsWith('clo') || x.startsWith('claud')) return 'claude-code'
  if (x.startsWith('codex')) return 'codex'
  if (x.startsWith('gemini')) return 'gemini-cli'
  if (x.startsWith('kiro')) return 'kiro-cli'
  if (x.startsWith('opencode') || x.startsWith('open code')) return 'opencode'
  if (x.startsWith('aider')) return 'aider'
  if (x === 'omp' || x.startsWith('ohmypi')) return 'omp'
  if (x === 'pi' || x === 'pai' || x === 'pii') return 'pi'
  return null
}

/**
 * A spoken prompt aimed at a specific terminal — "Terminal 1, create a React component" or
 * "dile a Claude que arregle el bug". Parsed from the RAW transcript so the prompt keeps its real
 * words/casing/accents (not the normalized form). Returns null when it's not a prompt command.
 */
function detectPrompt(raw: string): Intent | null {
  // "terminal <n> <prompt>" (a number is required + non-empty trailing text, so "ve a la terminal 2"
  // and "abre una terminal" never match).
  const tm = raw.match(
    /\bterminal(?:es)?\s+(?:n[uú]mero\s+|number\s+)?(\d{1,2}|uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|primera|primer|segunda|tercera|cuarta|quinta|one|two|three|four|five)\b[\s,:.–-]*(.*)$/i,
  )
  if (tm) {
    const n = numToken(tm[1].toLowerCase())
    // Strip only leading punctuation + a connector "que"/"to" — NOT "de"/"con", which are often part
    // of the prompt itself ("…de qué trata este folder").
    const text = (tm[2] || '')
      .replace(/^[\s,:.\-–]+/, '')
      .replace(/^(que|to)\s+/i, '')
      .trim()
    if (n !== null && text.length > 1) return { kind: 'prompt', target: { sel: 'number', n }, text }
  }
  // "dile/escribe/manda/pregunta/tell/ask … a <agent> [que] <prompt>"
  const am = raw.match(
    /\b(?:d[ií]le|d[ií]gale|escr[ií]be(?:le)?|m[aá]nda(?:le)?|env[ií]a(?:le)?|preg[uú]nta(?:le)?|tell|ask)\b[^]*?\b(claude(?:\s+code)?|codex|gemini|kiro|opencode|aider|pi)\b[\s,:]*(?:que\s+|to\s+)?(.+)$/i,
  )
  if (am) {
    const kind = agentKindFromWord(am[1])
    const text = (am[2] || '').trim()
    if (kind && text.length > 1) return { kind: 'prompt', target: { sel: 'agent', kind }, text }
  }
  return null
}

function detectText(norm: string): string | undefined {
  const markers = ['called', 'named', 'titled', 'llamado', 'llamada', 'titulado', 'que diga', 'que dice', 'with text', 'con el texto']
  for (const m of markers) {
    const at = norm.indexOf(`${m} `)
    if (at !== -1) {
      const rest = norm.slice(at + m.length).trim()
      if (rest) return rest
    }
  }
  return undefined
}

/** The site/term for a browser command: text after con/with/de, else a bare site keyword. */
function detectBrowserUrl(norm: string): string | undefined {
  const m = norm.match(/\b(?:con|with|de)\s+(.+)$/)
  if (m) {
    const term = m[1].replace(/^(la|el|los|las|the|a|an|un|una|el sitio|la pagina)\s+/, '').trim()
    if (term) return resolveSiteUrl(term)
  }
  return undefined
}

export function parseIntent(raw: string): Intent {
  const norm = normalize(raw)
  if (!norm) return { kind: 'none' }

  // ── prompt a specific terminal / agent (checked FIRST) ── "Terminal 1, <anything>" is unambiguously
  //    a prompt, so it must win even when <anything> contains words ("folder", "organiza", "cierra")
  //    that later rules would otherwise grab. Returns null for everything that isn't a prompt.
  const earlyPrompt = detectPrompt(raw)
  if (earlyPrompt) return earlyPrompt

  // ── arrange / organize ──
  if (nearAny(norm, ['organiza', 'organizar', 'organize', 'ordena', 'ordenar', 'acomoda', 'arrange', 'tile', 'alinea', 'alinear', 'tidy', 'acomodar']))
    return { kind: 'arrange' }

  // ── view ──
  if (nearAny(norm, ['zoom to fit', 'fit all', 'fit everything', 'ajusta', 'ajustar', 'encuadra', 'ver todo', 'muestra todo', 'ajusta la vista']))
    return { kind: 'view', action: 'fit' }
  if (nearAny(norm, ['reset zoom', 'zoom normal', 'actual size', 'restablece zoom', 'reinicia zoom', 'zoom al 100']))
    return { kind: 'view', action: 'reset' }
  if (nearAny(norm, ['zoom in', 'acerca', 'acercate', 'mas cerca'])) return { kind: 'view', action: 'zoomIn' }
  if (nearAny(norm, ['zoom out', 'aleja', 'alejate', 'mas lejos'])) return { kind: 'view', action: 'zoomOut' }

  // ── undo (revert the last command) ── checked early so it can't be mistaken for anything else.
  // A wide bilingual net (incl. likely ASR slips) since "deshaz" is an uncommon word the model can
  // mangle. Kept clear of space-prev words (anterior/regresa/atrás) so the two never collide.
  if (
    nearAny(norm, [
      'deshaz', 'deshazlo', 'deshacer', 'deshace', 'deshaces', 'des haz', 'desaz', 'desaceso', 'deshazme',
      'undo', 'revert', 'revierte', 'revertir', 'reviertelo',
      'cancela', 'cancela eso', 'cancelar', 'devuelvelo', 'reversa',
      'me equivoque', 'equivoque', 'equivocacion', 'eso no', 'eso esta mal', 'no era eso',
    ])
  )
    return { kind: 'undo' }

  // ── workspaces / spaces ── ("workspace" and "espacio"/"proyecto" all mean a PLANO space) ──
  const spaceWord = nearAny(norm, ['workspace', 'workspaces', 'espacio', 'espacios', 'escritorio', 'desktop'])
  const projectWord = nearAny(norm, ['proyecto', 'project'])
  const folderWord = nearAny(norm, ['folder', 'carpeta'])
  const newish = nearAny(norm, ['nuevo', 'nueva', 'new', 'crea', 'crear', 'create', 'haz', 'hazme', 'agrega', 'agregar', 'anade', 'add', 'dame', 'arma', 'monta'])
  const closeish = nearAny(norm, [...VERBS.close])
  // Open a folder/project (folder picker) — but NOT when the intent is new/close.
  if (folderWord || (projectWord && nearAny(norm, ['open', 'abre', 'abrir']) && !newish && !closeish))
    return { kind: 'workspace', action: 'open' }
  if ((spaceWord || projectWord) && newish) return { kind: 'space', op: 'new' }
  if ((spaceWord || projectWord) && closeish) return { kind: 'space', op: 'close' }
  if (spaceWord) {
    if (nearAny(norm, ['siguiente', 'siguient', 'sigant', 'sigue', 'avanza', 'adelante', 'next'])) return { kind: 'space', op: 'next' }
    if (nearAny(norm, ['anterior', 'previous', 'prev', 'regresa', 'atras'])) return { kind: 'space', op: 'prev' }
    const n = detectNumberRef(norm)
    if (n !== null) return { kind: 'space', op: 'goto', index: n }
    if (nearAny(norm, ['cambia', 'cambiar', 'switch', 'otro'])) return { kind: 'space', op: 'next' }
  }
  // NOTE: no 2-word 'save workspace' phrase — it fuzzy-collided with mis-heard "siguiente workspace"
  // ("sigant workspace" → wrongly matched "save workspace"). Bare 'save'/'guarda' still catch it.
  if (nearAny(norm, ['guarda el espacio', 'guarda', 'guardar', 'salva', 'save']))
    return { kind: 'workspace', action: 'save' }

  // ── toggles ──
  if (nearAny(norm, ['minimap', 'minimapa', 'mini mapa', 'mapa'])) return { kind: 'toggle', what: 'minimap' }
  if (nearAny(norm, ['snapping', 'snap', 'iman', 'alineado'])) return { kind: 'toggle', what: 'snapping' }
  if (nearAny(norm, ['command palette', 'paleta de comandos', 'paleta', 'comandos'])) return { kind: 'toggle', what: 'palette' }
  if (nearAny(norm, ['settings', 'ajustes', 'configuracion', 'preferencias', 'opciones', 'preferences']))
    return { kind: 'toggle', what: 'settings' }

  // ── queries ──
  if (nearAny(norm, ['what is running', 'whats running', 'running agents', 'que esta corriendo', 'que hay corriendo', 'agentes activos', 'que agentes', 'que tengo corriendo']))
    return { kind: 'query', what: 'agents' }
  if (nearAny(norm, ['what is open', 'whats open', 'list panels', 'que hay abierto', 'que tengo abierto', 'que paneles', 'cuantos paneles']))
    return { kind: 'query', what: 'panels' }

  const verb = detectVerb(norm)
  const type = detectType(norm)
  const all = nearAny(norm, ALL_WORDS)
  const enclitic = /\b(cierra|cierr|borra|elimina|quita|mata|enfoca|muestra|ensena|abre)l[oae]s?\b/.test(norm)
  const pronoun = nearAny(norm, PRONOUN_WORDS) || enclitic
  const agent = detectAgent(norm)

  // ── close everything ("cierra todo") ── Spanish "todo" (everything) collides with the To-do panel
  // synonym, so when closing with a "todo/todos/todas/everything" word and no MORE-specific type,
  // mean the whole canvas (not a single To-do list).
  const everything = nearAny(norm, ['todo', 'todos', 'todas', 'everything']) || (all && !type)
  if (verb === 'close' && everything && (type === null || type === 'todo'))
    return { kind: 'close', target: { sel: 'all' } }

  // ── agents (highest-signal): wins over an ambiguous editor/terminal match, but NOT over an
  //    explicit browser ("abre un navegador con claude" → browser to claude.ai-ish, not the CLI). ──
  if (agent && type !== 'browser') {
    if (verb === 'focus') return { kind: 'focus', target: { sel: 'agent', kind: agent.kind } }
    if (verb === 'close') return { kind: 'close', target: { sel: 'agent', kind: agent.kind } }
    // "corre claude en todas las terminales" / "run codex in every terminal" → launch it in each.
    const terminaly = type === 'terminal' || nearAny(norm, ['terminal', 'terminales', 'terminals', 'consola', 'consolas'])
    if (all && terminaly) return { kind: 'launchAll', command: agent.command, noun: agent.display }
    return { kind: 'create', type: 'terminal', count: detectCount(norm), bootCommand: agent.command, noun: agent.display }
  }

  if (verb === 'create') {
    if (!type) return { kind: 'unknown', text: raw }
    if (type === 'browser') return { kind: 'create', type, count: detectCount(norm), url: detectBrowserUrl(norm) }
    return { kind: 'create', type, count: detectCount(norm), text: detectText(norm) }
  }
  if (verb === 'close' || verb === 'focus') {
    let target: Target | null = null
    if (type === 'terminal') {
      const n = detectNumberRef(norm)
      target = n !== null ? { sel: 'number', n } : { sel: 'type', type, scope: all ? 'all' : 'one' }
    } else if (type) {
      target = { sel: 'type', type, scope: all ? 'all' : 'one' }
    } else if (pronoun) {
      target = { sel: 'last' }
    }
    if (!target) return { kind: 'unknown', text: raw }
    return verb === 'close' ? { kind: 'close', target } : { kind: 'focus', target }
  }

  // No verb, but a bare panel name ("terminal", "browser") → create one.
  if (!verb && type) {
    if (type === 'browser') return { kind: 'create', type, count: detectCount(norm), url: detectBrowserUrl(norm) }
    return { kind: 'create', type, count: detectCount(norm) }
  }

  return { kind: 'unknown', text: raw }
}
