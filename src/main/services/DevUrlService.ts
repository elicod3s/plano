/**
 * DevUrlService — "open it inside PLANO, not the whole PC".
 *
 * Watches each terminal's output for a LOCAL dev-server URL (localhost:PORT, 127.0.0.1, …)
 * the way `npm run dev`, vite, next, `netlify dev`, etc. print one. A printed URL is only a
 * candidate: before emitting it, this service confirms that its local TCP port is accepting
 * connections. That distinction matters when an agent restores a transcript: a historical
 * "http://localhost:5173" line must not create a preview when no server is running.
 *
 * Smart by construction: scans only COMPLETE lines (so a URL split across PTY writes is never
 * matched half-formed), strips ANSI first, requires a port (kills "localhost" prose matches),
 * and dedups per terminal so a server restart that reprints the same URL never re-opens it.
 *
 * Because this only runs for PLANO's own PTYs, a terminal opened OUTSIDE PLANO is untouched —
 * its URLs open in the system browser as usual.
 */

import { connect } from 'node:net'

type Emit = (url: string) => void

// CSI / OSC / two-char escape sequences. URLs never contain ESC, so stripping is lossless here.
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g

// http(s)://(localhost | 127.0.0.1 | 0.0.0.0 | [::1]) : PORT (/path)?  — port is REQUIRED.
const LOCAL_URL =
  /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d{2,5}(?:\/[^\s'"<>`)\]}]*)?/gi

const MAX_PARTIAL_LINE = 8192
/** A server commonly prints its URL just before binding; allow that small startup window. */
const PROBE_DELAYS_MS = [0, 150, 500, 1_000, 2_000]
const PROBE_TIMEOUT_MS = 500

/** Tidy a raw match into a stable, navigable URL (also the dedup key). */
function normalize(raw: string): string {
  let u = raw.trim().replace(/[).,;\]}>]+$/, '') // drop trailing prose punctuation
  // 0.0.0.0 means "all interfaces" — not navigable; point the panel at localhost instead.
  u = u.replace(/^(https?:\/\/)0\.0\.0\.0/i, '$1localhost')
  u = u.replace(/\/+$/, '') // drop trailing slash(es) so "…:3000/" == "…:3000"
  return u
}

/** Return connection details only for a valid, local TCP URL. */
function localEndpoint(url: string): { host: string; port: number } | null {
  try {
    const parsed = new URL(url)
    const port = Number(parsed.port)
    if (!Number.isInteger(port) || port < 1 || port > 65_535) return null
    // `normalize` maps 0.0.0.0 to localhost. Keep the loopback addresses explicit instead of
    // resolving arbitrary hostnames: this service must never turn terminal text into a network scan.
    const host = parsed.hostname.toLowerCase()
    if (host !== 'localhost' && host !== '127.0.0.1' && host !== '[::1]' && host !== '::1') return null
    return { host: host === '[::1]' ? '::1' : host, port }
  } catch {
    return null
  }
}

/** A successful TCP handshake is enough: HTTP, HTTPS, websocket, and framework dev servers vary. */
function isListening(endpoint: { host: string; port: number }): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: endpoint.host, port: endpoint.port })
    let settled = false
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(PROBE_TIMEOUT_MS, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

class TerminalUrlScanner {
  private buf = ''
  /** URLs already emitted during this PTY lifetime. */
  private readonly emitted = new Set<string>()
  /** URLs currently being verified. Prevents a transcript redraw from scheduling many probes. */
  private readonly pending = new Set<string>()
  private disposed = false

  constructor(private readonly emit: Emit) {}

  feed(chunk: string): void {
    if (this.disposed) return
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
      if (!url || this.emitted.has(url) || this.pending.has(url)) continue
      this.pending.add(url)
      void this.confirm(url)
    }
  }

  private async confirm(url: string): Promise<void> {
    try {
      const endpoint = localEndpoint(url)
      if (!endpoint) return
      for (const delay of PROBE_DELAYS_MS) {
        if (delay) await new Promise<void>((resolve) => setTimeout(resolve, delay))
        if (!this.disposed && (await isListening(endpoint))) {
          if (this.disposed) return
          this.emitted.add(url)
          this.emit(url)
          return
        }
      }
    } finally {
      this.pending.delete(url)
    }
  }

  dispose(): void {
    this.disposed = true
    this.buf = ''
    this.pending.clear()
  }
}

export class DevUrlService {
  private readonly scanners = new Map<string, TerminalUrlScanner>()

  register(ptyId: string, emit: Emit): void {
    this.scanners.get(ptyId)?.dispose()
    this.scanners.set(ptyId, new TerminalUrlScanner(emit))
  }

  /** Feed the same raw PTY bytes that go to xterm + agent detection. */
  feed(ptyId: string, data: string): void {
    this.scanners.get(ptyId)?.feed(data)
  }

  unregister(ptyId: string): void {
    this.scanners.get(ptyId)?.dispose()
    this.scanners.delete(ptyId)
  }

  disposeAll(): void {
    for (const scanner of this.scanners.values()) scanner.dispose()
    this.scanners.clear()
  }
}
