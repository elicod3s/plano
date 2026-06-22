/**
 * Platform-aware keyboard-shortcut labels. Shortcuts are authored once in the canonical
 * Windows-ish form ("Ctrl+Shift+E"); this renders them for the host OS:
 *   - Windows / Linux → unchanged ("Ctrl+Shift+E"); Mod/Cmd normalized to "Ctrl"
 *   - macOS           → tight glyphs ("⇧⌘E"); Ctrl/Mod mapped to ⌘
 *
 * Detection is synchronous (navigator) so labels render without an async round-trip; the
 * privileged process.platform value (over IPC) stays reserved for behavioral decisions.
 */
const platformSource =
  (typeof navigator !== 'undefined' &&
    ((navigator as unknown as { userAgentData?: { platform?: string } }).userAgentData?.platform ||
      navigator.platform ||
      navigator.userAgent)) ||
  ''

export const IS_MAC = /mac/i.test(platformSource)

/** The primary modifier on its own (⌘ on macOS, "Ctrl" elsewhere). */
export const MOD = IS_MAC ? '⌘' : 'Ctrl'

// Modifier/key → macOS glyph. App shortcuts fire on Ctrl OR Cmd (see useHotkeys `mod`), so the
// canonical "Ctrl" maps to ⌘ on a Mac — the key Mac users actually press.
const MAC_GLYPH: Record<string, string> = {
  ctrl: '⌘',
  control: '⌘',
  mod: '⌘',
  cmd: '⌘',
  command: '⌘',
  meta: '⌘',
  shift: '⇧',
  alt: '⌥',
  option: '⌥',
  enter: '⏎',
  return: '⏎',
  esc: 'esc',
  escape: 'esc',
  backspace: '⌫',
}

const WIN_NORMALIZE: Record<string, string> = {
  mod: 'Ctrl',
  cmd: 'Ctrl',
  command: 'Ctrl',
  meta: 'Ctrl',
  control: 'Ctrl',
}

/** Render a "+"-separated combo (e.g. "Ctrl+Shift+E") for the current platform. */
export function fmtKeys(combo: string): string {
  const tokens = combo
    .split('+')
    .map((t) => t.trim())
    .filter(Boolean)
  if (!IS_MAC) {
    return tokens.map((t) => WIN_NORMALIZE[t.toLowerCase()] ?? t).join('+')
  }
  return tokens.map((t) => MAC_GLYPH[t.toLowerCase()] ?? t).join('')
}
