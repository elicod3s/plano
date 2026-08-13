/**
 * The CLI's HTTP JSON-RPC client (plan v5 A1) — the exact shape of Orca's RuntimeClient: a
 * thin, stateless POST per command to the daemon's mesh endpoint. No app state, no PTYs.
 * Identity comes from the terminal environment: PLANO_MESH_TOKEN + PLANO_MESH_URL.
 */

import http from 'node:http'

const DEFAULT_URL = 'http://127.0.0.1:56780/cli'
const KEEPALIVE_MS = 30_000

/** A mesh result: `ok` is the only guaranteed field; commands add more. */
export interface MeshResult {
  ok: boolean
  error?: string
  detail?: string
  [key: string]: unknown
}

export class MeshClient {
  private readonly url: string
  private readonly token: string

  constructor() {
    this.url = (process.env.PLANO_MESH_URL || DEFAULT_URL).replace(/\/+$/, '')
    this.token = process.env.PLANO_MESH_TOKEN || ''
  }

  /** False when this process is not running inside a PLANO agent terminal. */
  get ready(): boolean {
    return this.token.length > 0
  }

  /** True when the mesh endpoint is reachable at all (token or not) — used by `plano status`. */
  get endpoint(): string {
    return this.url
  }

  call(method: string, params: Record<string, unknown> = {}, opts: { timeoutMs?: number; keepalive?: boolean } = {}): Promise<MeshResult> {
    const timeoutMs = opts.timeoutMs ?? 30_000
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
    const u = new URL(this.url)
    return new Promise<MeshResult>((resolve, reject) => {
      const req = http.request(
        {
          hostname: u.hostname,
          port: u.port,
          path: u.pathname || '/',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.token}`,
            'Content-Length': Buffer.byteLength(body),
          },
        },
        (res) => {
          let data = ''
          res.on('data', (chunk) => {
            data += chunk.toString('utf8')
          })
          res.on('end', () => {
            if (res.statusCode === 401) {
              reject(new MeshCliError('unauthorized', 'PLANO_MESH_TOKEN was rejected — this token is revoked or the daemon restarted with new identities. Open a fresh PLANO terminal.', 1))
              return
            }
            let parsed: { result?: MeshResult; error?: { message?: string } } | null = null
            try {
              parsed = JSON.parse(data)
            } catch {
              /* fall through */
            }
            if (res.statusCode === 200 && parsed?.result) {
              resolve(parsed.result)
              return
            }
            if (parsed?.error?.message) {
              reject(new MeshCliError('rpc-error', parsed.error.message, 1))
              return
            }
            reject(
              new MeshCliError(
                'bad-response',
                `daemon answered ${res.statusCode ?? '?'} with an unparseable body (${this.url}) — if PLANO was running before this upgrade, restart it so the new daemon serves /cli`,
                1,
              ),
            )
          })
        },
      )
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error('cli-timeout'))
      })
      req.on('error', (err) => {
        if (err.message === 'cli-timeout') {
          reject(new MeshCliError('timeout', `no answer from the mesh within ${timeoutMs} ms`, 1))
          return
        }
        reject(
          new MeshCliError(
            'unreachable',
            `cannot reach the PLANO mesh at ${this.url} — is PLANO running? (${err.message})`,
            1,
          ),
        )
      })
      let keepalive: NodeJS.Timeout | null = null
      if (opts.keepalive) {
        // A word, not a machine token. `{"_keepalive":true}` repeated on stderr read as a broken
        // command to every agent that saw it — it says nothing about what is being waited on, and
        // an agent staring at a wall of them concludes the call failed and stops waiting. Says
        // what it is doing instead, and only every 30 s.
        let ticks = 0
        keepalive = setInterval(() => {
          try {
            ticks += 1
            process.stderr.write(`plano: still listening (${ticks * (KEEPALIVE_MS / 1000)}s) — this call returns as soon as something arrives\n`)
          } catch {
            /* stderr closed — fine */
          }
        }, KEEPALIVE_MS)
        keepalive.unref?.()
      }
      req.on('close', () => {
        if (keepalive) clearInterval(keepalive)
      })
      req.write(body)
      req.end()
    })
  }
}

export class MeshCliError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly exitCode: number,
  ) {
    super(message)
    this.name = 'MeshCliError'
  }
}
