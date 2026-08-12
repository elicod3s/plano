/** WebSocket live channel to the Agent Host, with auto-reconnect + typed events. */
import type { Conn, Session } from './types'

export interface WsEvent {
  event: string
  sessions?: Session[]
  ptyId?: string
  data?: string
  exitCode?: number
  kind?: string | null
  phase?: string | null
  active?: boolean
  ok?: boolean
  exited?: boolean
  buffer?: string
  [k: string]: unknown
}

type Listener = (e: WsEvent) => void

export class LiveChannel {
  private ws: WebSocket | null = null
  private listeners = new Set<Listener>()
  private closed = false
  private retry = 0

  constructor(private conn: Conn, private onState: (up: boolean) => void) {}

  connect(): void {
    this.closed = false
    this.open()
  }

  private open(): void {
    if (this.closed) return
    const ws = new WebSocket(
      `${this.conn.base.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(this.conn.token)}`,
    )
    this.ws = ws
    ws.onopen = () => {
      this.retry = 0
      this.onState(true)
    }
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as WsEvent
        for (const l of this.listeners) {
          try {
            l(msg)
          } catch {
            /* listener errors must not break the channel */
          }
        }
      } catch {
        /* malformed frame */
      }
    }
    ws.onclose = () => {
      this.onState(false)
      if (this.closed) return
      const delay = Math.min(5000, 800 * 2 ** this.retry++)
      setTimeout(() => {
        if (!this.closed) this.open()
      }, delay)
    }
    ws.onerror = () => ws.close()
  }

  close(): void {
    this.closed = true
    this.ws?.close()
    this.ws = null
  }

  on(l: Listener): () => void {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }

  send(method: string, ptyId?: string, params: Record<string, unknown> = {}): void {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ method, ptyId, params }))
  }

  /** Attach as a viewer (starts streaming data for this session to us). */
  attach(ptyId: string): void {
    this.send('attach', ptyId)
  }

  detach(ptyId: string): void {
    this.send('detach', ptyId)
  }

  write(ptyId: string, data: string): void {
    this.send('write', ptyId, { data })
  }

  resize(ptyId: string, cols: number, rows: number): void {
    this.send('resize', ptyId, { cols, rows })
  }
}
