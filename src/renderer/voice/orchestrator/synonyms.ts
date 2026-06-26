/**
 * Bilingual (Spanish + English) vocabulary that maps spoken words to PLANO's domain. The HUD/chrome
 * stays 100% English (project rule), but the user speaks either language — so the grammar matches
 * against this table. Phrases are normalized (lower-case, accents stripped) before matching, and the
 * longest phrase wins so "explorador web" → browser beats "explorador" → files.
 */
import type { PanelType } from '@shared/domain/panel'
import type { AgentKind } from '@shared/domain/agent'

/** Strip accents + lowercase so "región"/"region" and "código"/"codigo" match the same entry. */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Panel types the voice assistant can create (the canvas-creatable ones; no group/files/voice). */
export const PANEL_PHRASES: ReadonlyArray<readonly [PanelType, readonly string[]]> = [
  ['terminal', ['terminal', 'terminales', 'consola', 'consolas', 'shell', 'powershell', 'cmd', 'terminar']],
  // NOTE: bare 'code' is intentionally NOT here — it collides with ASR mishears of "Claude". Files
  // is reached via "archivos"/"editor"/"files"/"explorador de archivos".
  ['editor', ['explorador de archivos', 'editor de codigo', 'archivos', 'archivo', 'editor', 'files', 'file', 'fichero', 'ficheros']],
  ['browser', ['explorador web', 'navegador', 'navegadr', 'browser', 'internet', 'chrome', 'pagina web', 'sitio web']],
  ['agent', ['agente', 'agent', 'asistente', 'ia', 'ai']],
  ['git', ['git', 'guit', 'gith', 'hit', 'control de versiones', 'repositorio', 'repo']],
  ['markdown', ['documento', 'markdown', 'nota', 'notas', 'doc', 'md']],
  ['todo', ['lista de tareas', 'tareas', 'pendientes', 'todo', 'to do', 'checklist', 'lista']],
  ['pomodoro', ['pomodoro', 'temporizador', 'timer', 'cronometro', 'reloj']],
  ['sticky', ['nota adhesiva', 'post it', 'postit', 'sticky', 'recordatorio']],
  ['region', ['region', 'regiones', 'area', 'zona', 'seccion', 'grupo']],
  ['label', ['etiqueta', 'rotulo', 'titulo', 'texto', 'label']],
]

/** Human nouns for HUD captions, e.g. create 2 terminals → "Opened 2 Terminals". */
export const PANEL_NOUN: Record<string, string> = {
  terminal: 'Terminal',
  editor: 'Files',
  browser: 'Browser',
  agent: 'Agent',
  git: 'Git',
  markdown: 'Document',
  todo: 'To-do',
  pomodoro: 'Pomodoro',
  sticky: 'Sticky Note',
  region: 'Region',
  label: 'Text',
}

export const VERBS = {
  create: ['open', 'create', 'new', 'add', 'spawn', 'launch', 'start', 'give me', 'abre', 'abrir', 'crea', 'crear', 'nueva', 'nuevo', 'nuevas', 'nuevos', 'anade', 'anadir', 'agrega', 'agregar', 'pon', 'poner', 'mete', 'dame', 'inserta'],
  close: ['close', 'remove', 'delete', 'kill', 'hide', 'dismiss', 'cierra', 'cerrar', 'quita', 'quitar', 'elimina', 'eliminar', 'borra', 'borrar', 'mata', 'matar'],
  focus: ['go to', 'jump to', 'focus', 'show', 'find', 'select', 'center', 've a', 'ir a', 'vete a', 'muestra', 'muestrame', 'ensename', 'enfoca', 'busca', 'encuentra', 'selecciona', 'centra', 'llevame'],
} as const

/** AI agent CLIs Odla can launch in a fresh terminal ("open Claude Code"). Phrases are matched
 *  longest-first; `command` is typed into the new shell. Mirrors the Terminal panel's launcher. */
export interface AgentSpoken {
  kind: AgentKind
  command: string
  display: string
  phrases: string[]
}
// Phrases include many phonetic variants a multilingual model tends to emit for a Spanish speaker
// saying these English names — so "abre clод/cloud/claud" still opens Claude. The fuzzy matcher
// (orchestrator/fuzzy.ts) catches the rest.
export const AGENTS_SPOKEN: AgentSpoken[] = [
  {
    kind: 'claude-code',
    command: 'claude',
    display: 'Claude Code',
    // NOTE: 'clode' was REMOVED — it fuzzy-collides with the very common English verb "close"
    // ("close this" → was wrongly read as "close Claude"). 'claudio'/'claudie' are real mishears.
    phrases: ['claude code', 'claude', 'claud', 'claudio', 'claudie', 'claudi', 'cloud code', 'cloud', 'claus', 'klaus', 'clou', 'glode', 'claude cod', 'cloud cod'],
  },
  {
    kind: 'codex',
    command: 'codex',
    display: 'Codex',
    phrases: ['open ai codex', 'openai codex', 'codex', 'codecs', 'codez', 'kodex', 'cortex', 'codigos'],
  },
  {
    kind: 'gemini-cli',
    command: 'gemini',
    display: 'Gemini',
    phrases: ['gemini cli', 'gemini', 'geminis', 'yemini', 'jiminy', 'gemeni', 'hemini', 'geminai'],
  },
  {
    kind: 'kiro-cli',
    command: 'kiro-cli chat',
    display: 'Kiro CLI',
    phrases: ['kiro cli', 'kiro', 'quiro', 'kira', 'kiroh', 'kyro'],
  },
  { kind: 'opencode', command: 'opencode', display: 'opencode', phrases: ['open code', 'opencode', 'open coded', 'opncode'] },
  { kind: 'aider', command: 'aider', display: 'Aider', phrases: ['aider', 'eider', 'aiden', 'eder', 'aidr'] },
]

/** Well-known sites for "open a browser with X". Anything else falls back to a domain or web search. */
export const SITES: Record<string, string> = {
  youtube: 'https://www.youtube.com',
  google: 'https://www.google.com',
  github: 'https://github.com',
  gmail: 'https://mail.google.com',
  correo: 'https://mail.google.com',
  twitter: 'https://x.com',
  x: 'https://x.com',
  chatgpt: 'https://chatgpt.com',
  reddit: 'https://www.reddit.com',
  'stack overflow': 'https://stackoverflow.com',
  stackoverflow: 'https://stackoverflow.com',
  maps: 'https://maps.google.com',
  mapas: 'https://maps.google.com',
  netflix: 'https://www.netflix.com',
  spotify: 'https://open.spotify.com',
  wikipedia: 'https://www.wikipedia.org',
  whatsapp: 'https://web.whatsapp.com',
}

/** Turn a spoken term into a URL: known site → its URL; a domain-looking term → https://term; else
 *  a Google search for the phrase. */
export function resolveSiteUrl(term: string): string {
  const t = term.trim()
  if (!t) return 'about:blank'
  if (SITES[t]) return SITES[t]
  const oneWord = t.replace(/\s+/g, '')
  if (SITES[oneWord]) return SITES[oneWord]
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(oneWord)) return `https://${oneWord}`
  return `https://www.google.com/search?q=${encodeURIComponent(t)}`
}

/** Spoken ordinals (es + en) → position. "la segunda terminal" → 2. */
export const ORDINAL_WORDS: Record<string, number> = {
  primera: 1, primer: 1, primero: 1, first: 1,
  segunda: 2, segundo: 2, second: 2,
  tercera: 3, tercer: 3, tercero: 3, third: 3,
  cuarta: 4, cuarto: 4, fourth: 4,
  quinta: 5, quinto: 5, fifth: 5,
}

/** Spoken numbers (es + en) → integer; digits are parsed separately. */
export const NUMBER_WORDS: Record<string, number> = {
  un: 1, uno: 1, una: 1, one: 1,
  dos: 2, two: 2,
  tres: 3, three: 3,
  cuatro: 4, four: 4,
  cinco: 5, five: 5,
  seis: 6, six: 6,
  siete: 7, seven: 7,
  ocho: 8, eight: 8,
  nueve: 9, nine: 9,
  diez: 10, ten: 10,
}

/** "all / every / todas / todos" — close/focus the whole set of a type. */
export const ALL_WORDS = ['all', 'every', 'todos', 'todas', 'cada']

/** Pronouns standing for the last-touched panel: "it / this / that / lo / la / eso / este". */
export const PRONOUN_WORDS = ['it', 'this', 'that', 'lo', 'la', 'eso', 'esto', 'este', 'esta', 'esa', 'ese']
