/**
 * terminalText — canonical terminal-output normalisation. ONE implementation of ANSI/OSC
 * stripping + redraw/backspace collapsing, shared by every main-process consumer
 * (AgentContextService, redaction, search, the mesh CLI) so regexes can never drift apart.
 *
 * Pure string functions — no node/electron imports, unit-testable.
 */

// eslint-disable-next-line no-control-regex
const CSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g
// eslint-disable-next-line no-control-regex
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g
// eslint-disable-next-line no-control-regex
const ESC_SHORT_RE = /\x1b[@-Z\\-_]/g
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g

/**
 * Strip ANSI CSI/OSC/short escapes and other control chars (keeps \n, \r, \t which are
 * meaningful text). Carriage returns are NOT removed here — callers that want a single
 * logical line use collapseCarriageReturns() first (or normalizeTerminalText()).
 */
export function stripAnsi(input: string): string {
  if (!input) return ''
  return input.replace(CSI_RE, '').replace(OSC_RE, '').replace(ESC_SHORT_RE, '').replace(CONTROL_RE, '')
}

/**
 * Collapse `\r`-based line redraws the way a terminal renders them: a `\r` followed by
 * more text REPLACES the current line from the start (progress bars, spinners, `npm`
 * rewrites); `\r\n` is a hard newline. After this, \r no longer appears in the output.
 */
export function collapseCarriageReturns(input: string): string {
  if (!input || !input.includes('\r')) return input
  const out: string[] = []
  let line = ''
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (ch === '\r') {
      if (input[i + 1] === '\n') {
        out.push(line)
        line = ''
        i++ // consume the \n
      } else {
        line = '' // redraw from column 0
      }
    } else if (ch === '\n') {
      out.push(line)
      line = ''
    } else {
      line += ch
    }
  }
  out.push(line)
  return out.join('\n')
}

/**
 * Apply backspaces (`\b` / `\x7f`) as destructive edits: each backspace removes the
 * previous character. Used before text analysis so `abc\x7f\x7f` reads as `a`.
 */
export function applyBackspaces(input: string): string {
  if (!input || (!input.includes('\b') && !input.includes('\x7f'))) return input
  const out: string[] = []
  for (const ch of input) {
    if (ch === '\b' || ch === '\x7f') {
      out.pop()
    } else {
      out.push(ch)
    }
  }
  return out.join('')
}

/** Normalise CRLF → LF (keeps lone \n as-is; no-op when already clean). */
export function normalizeCrlf(input: string): string {
  return input.replace(/\r\n/g, '\n')
}

/**
 * Full pipeline for TEXT ANALYSIS: strip ANSI → collapse \r redraws → apply backspaces →
 * CRLF→LF. Produces the clean, human-readable transcript used for tails, search, redaction
 * and mesh context. Keeps whitespace (tabs, multiple spaces) so code blocks survive.
 */
export function normalizeTerminalText(input: string): string {
  if (!input) return ''
  return normalizeCrlf(applyBackspaces(collapseCarriageReturns(stripAnsi(input))))
}

/**
 * Compact a block of text to at most `maxChars` chars while trying to cut at a line
 * boundary. Returns a { text, truncated } pair. Cheap, deterministic, never splits a
 * surrogate pair.
 */
export function truncateText(input: string, maxChars: number): { text: string; truncated: boolean } {
  if (input.length <= maxChars) return { text: input, truncated: false }
  let cut = input.slice(0, maxChars)
  const nl = cut.lastIndexOf('\n')
  if (nl > maxChars * 0.6) cut = cut.slice(0, nl)
  // Don't split a surrogate pair at the boundary.
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1)
  return { text: cut, truncated: true }
}
