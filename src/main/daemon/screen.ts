/**
 * screen — what a terminal session actually SHOWS, as text.
 *
 * The mesh used to read a session by concatenating raw PTY chunks and stripping the escape
 * sequences out of them. That works for plain command output and fails completely on the TUIs the
 * agents actually run: Claude Code and Codex repaint their input box on every keystroke using
 * absolute cursor moves and erase-in-display. Stripping those escapes removes the very
 * instructions that make each repaint OVERWRITE the previous one, so the "clean" transcript ends
 * up as the union of every intermediate frame — a message typed into a peer came back as
 * "R\ne\np\nl\ny\n…", one fragment per keystroke. That is the garbled delta agents were reading.
 *
 * The fix is to stop cleaning text and start emulating the screen: every session's byte stream is
 * fed to a headless xterm — the same emulator the renderer draws with — and the mesh reads the
 * resulting buffer. Redraws overwrite, cursor moves land where they should, and what an agent
 * reads from a peer is what a human would see in that panel.
 *
 * Pure Node, no DOM: @xterm/headless exists exactly for this. It lives in the DAEMON, so peer
 * reads keep working with the desktop app closed.
 */
import { Terminal } from '@xterm/headless'

/** Geometry of the off-screen screen. Wide enough that agent TUIs don't wrap mid-word. */
const COLS = 120
const ROWS = 40
/**
 * Lines kept above the viewport. A wait returns at most WAIT_DELTA_MAX_CHARS (64 KiB), so more
 * than this is never read — it only costs memory per live agent.
 */
const SCROLLBACK = 1500

interface Screen {
  term: Terminal
  /** Bytes written but not yet parsed — xterm drains asynchronously. */
  pending: number
}

const screens = new Map<string, Screen>()

function ensure(ptyId: string): Screen {
  const existing = screens.get(ptyId)
  if (existing) return existing
  const term = new Terminal({
    cols: COLS,
    rows: ROWS,
    scrollback: SCROLLBACK,
    allowProposedApi: true,
    // Nothing renders this buffer, so a cursor blink timer would only wake the daemon.
    cursorBlink: false,
    convertEol: false,
  })
  const screen: Screen = { term, pending: 0 }
  screens.set(ptyId, screen)
  return screen
}

/** Feed a session's raw PTY output to its screen. Never throws — a screen is an observer. */
export function writeScreen(ptyId: string, data: string): void {
  try {
    const screen = ensure(ptyId)
    screen.pending++
    screen.term.write(data, () => {
      screen.pending = Math.max(0, screen.pending - 1)
    })
  } catch {
    /* a broken screen must never take down the session it is watching */
  }
}

/**
 * The session as text: scrollback + viewport, trailing blank lines dropped.
 *
 * Reads whatever the emulator has parsed so far. xterm drains its write queue asynchronously, so
 * bytes that arrived microseconds ago may not be on screen yet — every caller polls (confirm
 * windows, waits), so the next read picks them up. `flushScreen` exists for the callers that
 * need a hard guarantee.
 */
export function readScreen(ptyId: string): string {
  const screen = screens.get(ptyId)
  if (!screen) return ''
  try {
    const buffer = screen.term.buffer.active
    const lines: string[] = []
    const end = buffer.length
    for (let i = 0; i < end; i++) {
      const line = buffer.getLine(i)
      // `true` trims trailing whitespace — a terminal pads every line to the full width.
      lines.push(line ? line.translateToString(true) : '')
    }
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
    return lines.join('\n')
  } catch {
    return ''
  }
}

/** Resolve once the emulator has parsed everything written so far (bounded — never hangs). */
export function flushScreen(ptyId: string, timeoutMs = 250): Promise<void> {
  const screen = screens.get(ptyId)
  if (!screen || screen.pending === 0) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs)
    screen.term.write('', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

/** Drop a session's screen (the PTY died, or the session was closed). */
export function disposeScreen(ptyId: string): void {
  const screen = screens.get(ptyId)
  if (!screen) return
  screens.delete(ptyId)
  try {
    screen.term.dispose()
  } catch {
    /* already gone */
  }
}

/** Live screen count — diagnostics only. */
export function screenCount(): number {
  return screens.size
}
