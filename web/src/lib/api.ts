/** REST client for the Agent Host web API. */
import type { Conn, Session, Status, Workspace } from './types'

const TIMEOUT_MS = 8000

async function timedFetch(input: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    return await fetch(input, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

export class Api {
  constructor(private conn: Conn) {}

  private url(path: string): string {
    const sep = path.includes('?') ? '&' : '?'
    return `${this.conn.base}${path}${sep}token=${encodeURIComponent(this.conn.token)}`
  }

  private async req<T>(path: string, init?: RequestInit): Promise<T> {
    let res: Response
    try {
      res = await timedFetch(this.url(path), {
        ...init,
        headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
      })
    } catch (err) {
      throw new Error(
        err instanceof Error && err.name === 'AbortError'
          ? 'PLANO did not respond (timeout) — check the address and that the PC is on.'
          : 'Could not reach PLANO at this address.',
      )
    }
    if (!res.ok) {
      const body = await res.json().catch(() => null)
      throw new Error((body as { error?: string })?.error ?? `HTTP ${res.status}`)
    }
    return (await res.json()) as T
  }

  /** Unauthenticated liveness probe — validates an address before asking for the token. */
  static async ping(base: string): Promise<{ ok: boolean; name?: string }> {
    try {
      const res = await timedFetch(`${base.replace(/\/$/, '')}/api/ping`)
      if (!res.ok) return { ok: false }
      return (await res.json()) as { ok: boolean; name?: string }
    } catch {
      return { ok: false }
    }
  }

  status = () => this.req<Status>('/api/status')
  sessions = () => this.req<{ sessions: Session[] }>('/api/sessions')
  workspaces = () => this.req<{ workspaces: Workspace[] }>('/api/workspaces')

  createSession = (body: Record<string, unknown>) =>
    this.req<{ session: Session }>('/api/sessions', { method: 'POST', body: JSON.stringify(body) })

  write = (ptyId: string, data: string) =>
    this.req<{ ok: boolean }>(`/api/sessions/${ptyId}/write`, { method: 'POST', body: JSON.stringify({ data }) })

  resize = (ptyId: string, cols: number, rows: number) =>
    this.req<{ ok: boolean }>(`/api/sessions/${ptyId}/resize`, { method: 'POST', body: JSON.stringify({ cols, rows }) })

  interrupt = (ptyId: string) =>
    this.req<{ ok: boolean }>(`/api/sessions/${ptyId}/interrupt`, { method: 'POST', body: '{}' })

  kill = (ptyId: string) =>
    this.req<{ ok: boolean }>(`/api/sessions/${ptyId}/kill`, { method: 'POST', body: '{}' })

  buffer = (ptyId: string) => this.req<{ ptyId: string; buffer: string }>(`/api/sessions/${ptyId}/buffer`)

  /** Remove a CLOSED terminal's canvas panel from the PC (no live pty needed). */
  removePanel = (panelId: string, terminalId: string) =>
    this.req<{ ok: boolean }>('/api/panels/remove', { method: 'POST', body: JSON.stringify({ panelId, terminalId }) })
}

/** Storage for the saved connection. */
const KEY = 'plano.conn.v1'

export function loadConn(): Conn | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const c = JSON.parse(raw) as Conn
    if (typeof c.base !== 'string' || typeof c.token !== 'string' || !c.base || !c.token) return null
    return c
  } catch {
    return null
  }
}

export function saveConn(c: Conn): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(c))
  } catch {
    /* ignore */
  }
}

export function clearConn(): void {
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* ignore */
  }
}
