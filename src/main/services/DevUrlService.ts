/**
 * DevUrlService — "open it inside PLANO, not the whole PC".
 *
 * Watches each terminal's output for a LOCAL dev-server URL (localhost:PORT, 127.0.0.1, …)
 * the way `npm run dev`, vite, next, `netlify dev`, etc. print one. A printed URL is only a
 * candidate: before emitting it, this service confirms that the URL returns a browser document,
 * not merely that its TCP port is occupied. That distinction rejects APIs/websockets and also
 * "http://localhost:5173" line must not create a preview when no server is running.
 *
 * Smart by construction: scans only COMPLETE lines (so a URL split across PTY writes is never
 * matched half-formed), strips ANSI first, requires a port (kills "localhost" prose matches),
 * and dedups per terminal so a server restart that reprints the same URL never re-opens it.
 *
 * Because this only runs for PLANO's own PTYs, a terminal opened OUTSIDE PLANO is untouched —
 * its URLs open in the system browser as usual.
 */

import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'

type Emit = (url: string) => void
type ProbeResult = 'page' | 'not-page' | 'unavailable'

// CSI / OSC / two-char escape sequences. URLs never contain ESC, so stripping is lossless here.
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g

// http(s)://(localhost | 127.0.0.1 | 0.0.0.0 | [::1]) : PORT (/path)?  — port is REQUIRED.
const LOCAL_URL =
  /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d{2,5}(?:\/[^\s'"<>`)\]}]*)?/gi

const MAX_PARTIAL_LINE = 8192
/** A server commonly prints its URL just before binding; allow that small startup window. */
const PROBE_DELAYS_MS = [0, 150, 500, 1_000, 2_000]
const PROBE_TIMEOUT_MS = 900
const MAX_REDIRECTS = 3
const MAX_SNIFF_BYTES = 16 * 1024

// Service endpoints are not browser entry points. This prevents an agent mentioning Ollama's
// localhost API or an app's /api/users endpoint from opening a random preview.
const NON_PAGE_PATH = /\/(?:api(?:-docs)?|graphql|graphiql|rpc|trpc|ws|websocket|socket\.io|healthz?|readyz?|metrics|v\d+)(?:\/|$)/i
const NON_PAGE_FILE = /\.(?:json|xml|txt|map|wasm)$/i

/** Tidy a raw match into a stable, navigable URL (also the dedup key). */
function normalize(raw: string): string {
  let u = raw.trim().replace(/[).,;\]}>]+$/, '') // drop trailing prose punctuation
  // 0.0.0.0 means "all interfaces" — not navigable; point the panel at localhost instead.
  u = u.replace(/^(https?:\/\/)0\.0\.0\.0/i, '$1localhost')
  u = u.replace(/\/+$/, '') // drop trailing slash(es) so "…:3000/" == "…:3000"
  return u
}

/** Return a valid loopback browser-page candidate, rejecting obvious API/service paths. */
function localPageUrl(url: string): URL | null {
  try {
    const parsed = new URL(url)
    const port = Number(parsed.port)
    if (!Number.isInteger(port) || port < 1 || port > 65_535) return null
    // `normalize` maps 0.0.0.0 to localhost. Keep the loopback addresses explicit instead of
    // resolving arbitrary hostnames: this service must never turn terminal text into a network scan.
    const host = parsed.hostname.toLowerCase()
    if (host !== 'localhost' && host !== '127.0.0.1' && host !== '[::1]' && host !== '::1') return null
    if (NON_PAGE_PATH.test(parsed.pathname) || NON_PAGE_FILE.test(parsed.pathname)) return null
    return parsed
  } catch {
    return null
  }
}

function isHtmlResponse(res: IncomingMessage, body: string): boolean {
  const contentType = String(res.headers['content-type'] ?? '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase()

  // An explicit API/data/media type is authoritative. Do not let a JSON error containing an HTML
  // fragment pass the body sniffer.
  if (contentType && contentType !== 'text/html' && contentType !== 'application/xhtml+xml') {
    return false
  }
  if (contentType === 'text/html' || contentType === 'application/xhtml+xml') return true

  // A few tiny/custom dev servers omit Content-Type. Accept only unmistakable document markup.
  return /<!doctype\s+html\b|<html(?:\s|>)|<head(?:\s|>)|<body(?:\s|>)/i.test(body)
}

/** Read only enough of a response to recognize a document; never retain an unbounded body. */
function readForSniff(res: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let bytes = 0
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      resolve(Buffer.concat(chunks).toString('utf8'))
    }
    res.on('data', (chunk: Buffer | string) => {
      if (done) return
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      const remaining = MAX_SNIFF_BYTES - bytes
      chunks.push(buf.subarray(0, remaining))
      bytes += Math.min(buf.length, remaining)
      if (bytes >= MAX_SNIFF_BYTES) {
        finish()
        res.destroy()
      }
    })
    res.on('end', finish)
    res.on('error', finish)
  })
}

/**
 * Prove that a candidate is a browser page, not merely an occupied TCP port.
 *
 * The old TCP handshake accepted databases, websocket listeners and JSON APIs. This performs a
 * bounded HTTP GET, requires HTML, and follows only loopback-to-loopback redirects so terminal text
 * can never make PLANO probe the LAN or internet. HTTPS loopback certificates are commonly
 * self-signed, hence the local-only rejectUnauthorized exception.
 */
function probeBrowserPage(url: URL, redirectsLeft = MAX_REDIRECTS): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const request = url.protocol === 'https:' ? httpsRequest : httpRequest
    let settled = false
    const finish = (result: ProbeResult): void => {
      if (settled) return
      settled = true
      resolve(result)
    }

    const req = request(
      url,
      {
        method: 'GET',
        headers: {
          accept: 'text/html,application/xhtml+xml;q=0.9',
          'accept-encoding': 'identity',
          'user-agent': 'PLANO-Dev-Server-Probe/1.0',
        },
        ...(url.protocol === 'https:' ? { rejectUnauthorized: false } : {}),
      },
      (res) => {
        const status = res.statusCode ?? 0
        const location = res.headers.location
        if (status >= 300 && status < 400) {
          res.resume()
          if (!location || redirectsLeft <= 0) return finish('not-page')
          let target: URL | null = null
          try {
            target = localPageUrl(new URL(location, url).toString())
          } catch {
            target = null
          }
          if (!target) return finish('not-page')
          void probeBrowserPage(target, redirectsLeft - 1).then(finish)
          return
        }
        if (status < 200 || status >= 500) {
          res.resume()
          return finish('unavailable')
        }
        if (status === 204 || status === 304) {
          res.resume()
          return finish('not-page')
        }
        if (isHtmlResponse(res, '')) {
          res.destroy()
          return finish('page')
        }
        void readForSniff(res).then((body) =>
          finish(isHtmlResponse(res, body) ? 'page' : 'not-page'),
        )
      },
    )
    req.setTimeout(PROBE_TIMEOUT_MS, () => {
      req.destroy()
      finish('unavailable')
    })
    req.once('error', () => finish('unavailable'))
    req.end()
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
      const page = url ? localPageUrl(url) : null
      if (!page) continue
      // One preview per actual server origin. A framework may print several page URLs for the same
      // port; that must not fan out into several browser panels.
      const key = page.origin.toLowerCase()
      if (this.emitted.has(key) || this.pending.has(key)) continue
      this.pending.add(key)
      void this.confirm(url, page, key)
    }
  }

  private async confirm(url: string, page: URL, key: string): Promise<void> {
    try {
      for (const delay of PROBE_DELAYS_MS) {
        if (delay) await new Promise<void>((resolve) => setTimeout(resolve, delay))
        if (this.disposed) return
        const result = await probeBrowserPage(page)
        if (result === 'not-page') return
        if (result === 'page') {
          if (this.disposed) return
          this.emitted.add(key)
          this.emit(url)
          return
        }
      }
    } finally {
      this.pending.delete(key)
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
