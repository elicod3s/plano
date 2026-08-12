/**
 * Smart terminal titles — a local, dependency-free way to name a terminal tab by what the
 * agent is ACTUALLY doing. PLANO already captures the FIRST prompt the user sends to a
 * detected agent (the same signal Hermes uses to title sessions); this turns it into a
 * clean, short, readable tab title.
 *
 * No external AI is required: the title is derived from the user's own first prompt (which
 * IS the task), cleaned and compacted. A longer/messier prompt becomes a crisp label like
 * "Fix login bug" instead of "Terminal 1" or just the agent's brand name.
 */

/** Pure filler to strip from the START ("hey, can you fix…" → "fix…"). Action verbs like
 *  fix/create/check are the TASK itself and are deliberately KEPT. */
const LEADING_FILLER = [
  'por favor', 'please', 'hey', 'oye', 'oigan', 'puedes', 'puede', 'podrias', 'podrias',
  'can you', 'can u', 'quiero que', 'necesito que', 'necesito', 'hazme', 'haz', 'hagan',
  'ayudame', 'help me', 'vamos a', "let's", 'lets', 'quiero', 'i want', 'me gustaria',
  'podrias ayudarme a', 'can you please', 'porfa',
]

/** Generic first prompts that say NOTHING about a task (whole-utterance match only — a prompt
 *  that merely STARTS with "hey" is still a real task). */
const GENERIC_RE =
  /^(hi|hello|hola|hey|test|prueba|ayuda|help|que puedes hacer|what can you do|who are you|eres|ready|listo|empecemos|let's start|empezamos|buenos dias|buenas tardes|buenas noches|good morning|good afternoon|good evening)[\s,.]*$/i

/** Long → compact title: strip leading filler, collapse whitespace, cap length. */
export function makeSmartTitle(rawPrompt: string): string | null {
  let text = (rawPrompt || '').replace(/\s+/g, ' ').trim()
  if (!text) return null
  if (GENERIC_RE.test(text)) return null
  // Slash-commands are UI navigation, not tasks.
  if (text.startsWith('/')) return null

  // Strip leading filler words ("hey, can you fix the login" → "fix the login").
  let changed = true
  while (changed) {
    changed = false
    for (const noise of LEADING_FILLER) {
      const lower = text.toLowerCase()
      if (lower === noise || lower.startsWith(`${noise}, `) || lower.startsWith(`${noise} `)) {
        text = text.slice(noise.length).replace(/^[\s,.:;!?]+/, '').trim()
        changed = true
        break
      }
    }
  }
  // Drop trailing please/porfa, then trailing punctuation, then a leading article
  // ("fix the login" → "fix login").
  text = text
    .replace(/\s+(please|porfa|por favor)\s*$/i, '')
    .replace(/[.,;:!?]+$/, '')
    .replace(/^(the|a|an|el|la|los|las|un|una)\s+/i, '')
    .trim()
  if (!text) return null

  // Hard cap: keep the first ~42 chars, cut at a word boundary.
  if (text.length > 42) {
    const cut = text.slice(0, 42)
    const sp = cut.lastIndexOf(' ')
    if (sp > 18) text = cut.slice(0, sp)
    else text = cut
  }
  // Capitalize the first letter for a tidy label.
  text = text.charAt(0).toUpperCase() + text.slice(1)
  return text
}
