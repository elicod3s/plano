/**
 * Tiny keyboard-combo parser + matcher shared by the command registry (app/commands) and
 * useHotkeys. Combos are authored in the canonical "Ctrl+Shift+E" form (lib/hotkeys renders them
 * for display). "Ctrl" matches Ctrl OR Cmd so one table works on macOS too. Matching is
 * layout-independent: letters/digits compare against the physical KeyboardEvent.code, so e.g.
 * Alt+T still fires on layouts where holding Alt mangles the produced character.
 */

export interface ParsedCombo {
  ctrl: boolean
  shift: boolean
  alt: boolean
  /** Lower-case logical key: 'a'..'z', '0'..'9', '`', ',', 'tab', 'esc', … */
  key: string
}

const MOD_TOKENS = new Set(['ctrl', 'control', 'cmd', 'command', 'meta', 'mod'])

/** Parse "Ctrl+Shift+E" / "Alt+T" / "Ctrl+`" into modifier flags + a logical key. */
export function parseCombo(combo: string): ParsedCombo {
  const out: ParsedCombo = { ctrl: false, shift: false, alt: false, key: '' }
  for (const raw of combo.split('+')) {
    const t = raw.trim().toLowerCase()
    if (!t) continue
    if (MOD_TOKENS.has(t)) out.ctrl = true
    else if (t === 'shift') out.shift = true
    else if (t === 'alt' || t === 'option') out.alt = true
    else out.key = t
  }
  return out
}

/** The logical key for an event, preferring the physical code so it's layout/Alt-proof. */
export function eventKey(e: KeyboardEvent): string {
  const c = e.code
  if (c.startsWith('Key')) return c.slice(3).toLowerCase() // KeyT -> t
  if (c.startsWith('Digit')) return c.slice(5) // Digit1 -> 1
  if (c.startsWith('Numpad') && /\d$/.test(c)) return c.slice(-1) // Numpad1 -> 1
  switch (c) {
    case 'Backquote':
      return '`'
    case 'Comma':
      return ','
    case 'Period':
      return '.'
    case 'Slash':
      return '/'
    case 'Minus':
      return '-'
    case 'Equal':
      return '='
    case 'Tab':
      return 'tab'
    case 'Escape':
      return 'esc'
    case 'Space':
      return 'space'
    default:
      return e.key.toLowerCase()
  }
}

/** Does this keydown match the combo? "Ctrl" matches Ctrl OR Cmd; other modifiers must match exactly. */
export function matchesCombo(e: KeyboardEvent, combo: ParsedCombo): boolean {
  if (combo.ctrl !== (e.ctrlKey || e.metaKey)) return false
  if (combo.shift !== e.shiftKey) return false
  if (combo.alt !== e.altKey) return false
  return eventKey(e) === combo.key
}
