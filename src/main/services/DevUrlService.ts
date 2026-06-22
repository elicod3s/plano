/**
 * DevUrlService — "open it inside PLANO, not the whole PC".
 *
 * Watches each terminal's output for a LOCAL dev-server URL (localhost:PORT, 127.0.0.1, …)
 * the way `npm run dev`, vite, next, `netlify dev`, etc. print one, and emits it ONCE so the
 * renderer can open a browser panel on the canvas. No AI, no shell hooks: it just reads the
 * bytes already streamed to the renderer.
 *
 * Smart by construction: scans only COMPLETE lines (so a URL split across PTY writes is never
 * matched half-formed), strips ANSI first, requires a port (kills "localhost" prose matches),
 * and dedups per terminal so a server restart that reprints the same URL never re-opens it.
 *
 * Because this only runs for PLANO's own PTYs, a terminal opened OUTSIDE PLANO is untouched —
 * its URLs open in the system browser as usual.
 */

type Emit = (url: string) => void

// CSI / OSC / two-char escape sequences. URLs never contain ESC, so stripping is lossless here.
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g

// http(s)://(localhost | 127.0.0.1 | 0.0.0.0 | [::1]) : PORT (/path)?  — port is REQUIRED.
const LOCAL_URL =
  /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d{2,5}(?:\/[^\s'"<>`)\]}]*)?/gi

const MAX_PARTIAL_LINE = 8192

/** Tidy a raw match into a stable, navigable URL (also the dedup key). */
function normalize(raw: string): string {
  let u = raw.trim().replace(/[).,;\]}>]+$/, '') // drop trailing prose punctuation
  // 0.0.0.0 means "all interfaces" — not navigable; point the panel at localhost instead.
  u = u.replace(/^(https?:\/\/)0\.0\.0\.0/i, '$1localhost')
  u = u.replace(/\/+$/, '') // drop trailing slash(es) so "…:3000/" == "…:3000"
  return u
}

class TerminalUrlScanner {
  private buf = ''
  private readonly seen = new Set<string>()

  constructor(private readonly emit: Emit) {}

  feed(chunk: string): void {
    this.buf += chunk
    // Split on newlines (ANSI never contains \n), process complete lines, keep the remainder.
    const lines = this.buf.split(/\r?\n/)
    this.buf = lines.pop() ?? ''
    if (this.buf.length > MAX_PARTIAL_LINE) this.buf = this.buf.slice(-MAX_PARTIAL_LINE)
    for (const line of lines) this.scan(line)
  }

  private scan(line: string): void {
    const clean = line.replace(ANSI, '')
    const matches = clean.match(LOCAL_URL)
    if (!matches) return
    for (const raw of matches) {
      const url = normalize(raw)
      if (!url || this.seen.has(url)) continue
      this.seen.add(url)
      this.emit(url)
    }
  }
}

export class DevUrlService {
  private readonly scanners = new Map<string, TerminalUrlScanner>()

  register(ptyId: string, emit: Emit): void {
    this.scanners.set(ptyId, new TerminalUrlScanner(emit))
  }

  /** Feed the same raw PTY bytes that go to xterm + agent detection. */
  feed(ptyId: string, data: string): void {
    this.scanners.get(ptyId)?.feed(data)
  }

  unregister(ptyId: string): void {
    this.scanners.delete(ptyId)
  }

  disposeAll(): void {
    this.scanners.clear()
  }
}
