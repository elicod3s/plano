/**
 * Native mesh endpoint (plan v5 A1) — the daemon's answer surface for the `plano` CLI.
 * POST /cli (and the legacy /mesh path) speaks plain JSON-RPC 2.0: `{ jsonrpc, id, method,
 * params }` → `{ jsonrpc, id, result }` where `result` IS the bus's MeshToolResult — no MCP
 * handshake, no tools/list envelope. The MCP framing (initialize → tools/list → tools/call)
 * that this replaces was removed: agents orchestrate through the CLI, which any harness can
 * run, instead of through MCP server configs.
 *
 * Identity is unchanged: Authorization: Bearer <PLANO_MESH_TOKEN>, resolved by the bus to the
 * agent. Everything the MCP endpoint could do is here, plus plano_wait (v5 A1) and the raw
 * bus surface (no content wrapper to unwrap).
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { MeshBus } from './bus'
import type { MeshToolResult } from './types'

interface JsonRpcRequest {
  jsonrpc?: '2.0'
  id?: string | number | null
  method?: string
  params?: Record<string, unknown>
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = body === undefined ? '' : JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  })
  res.end(payload)
}

function error(id: string | number | null | undefined, code: number, message: string): unknown {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }
}

export class MeshEndpoint {
  constructor(private readonly bus: MeshBus) {}

  /** Handle one POST /cli request (loopback only — enforced by the web server). */
  handle(req: IncomingMessage, res: ServerResponse): void {
    const auth = req.headers.authorization ?? ''
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
    const agentId = this.bus.resolveToken(token)
    if (!agentId) {
      sendJson(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized: unknown or revoked mesh token' } })
      return
    }

    let body = ''
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8')
      if (Buffer.byteLength(body) > 1_000_000) req.destroy()
    })
    req.on('end', () => {
      let message: JsonRpcRequest
      try {
        message = JSON.parse(body)
      } catch {
        sendJson(res, 400, error(null, -32700, 'Parse error'))
        return
      }
      const method = typeof message.method === 'string' ? message.method : ''
      const params = (message.params as Record<string, unknown> | undefined) ?? {}
      // tools/call may be async (visible typing, mailbox delivery, waits) — await before
      // replying. NOTHING here may reject: an unhandled rejection in the daemon takes every
      // terminal down with it. dispatch runs INSIDE the chain so a synchronous throw from a
      // method becomes a rejection, not a crash.
      void Promise.resolve()
        .then(() => this.dispatch(agentId, method, params))
        .then((result) => sendJson(res, 200, { jsonrpc: '2.0', id: message.id ?? null, result }))
        .catch((err) => {
          try {
            sendJson(res, 500, error(message.id, -32603, `Internal error: ${String(err)}`))
          } catch {
            try {
              res.end()
            } catch {
              /* socket already gone */
            }
          }
        })
    })
  }

  /** Method-name dispatch — one entry per bus capability. Returns a MeshToolResult. */
  private dispatch(agentId: string, name: string, args: Record<string, unknown>): Promise<MeshToolResult> | MeshToolResult {
    switch (name) {
      case 'plano_whoami':
        return this.bus.whoami(agentId)
      case 'plano_roster':
        return this.bus.rosterView()
      case 'plano_status':
        return this.bus.status(agentId, String(args.agentId ?? ''))
      case 'plano_inbox':
        return this.bus.inbox(agentId)
      case 'plano_ack':
        return this.bus.ack(agentId, String(args.id ?? ''))
      case 'plano_timeline':
        return this.bus.timelineView()
      case 'plano_send': {
        const mode = args.mode === 'queue' ? 'queue' : 'type'
        return this.bus.send(
          agentId,
          String(args.to ?? ''),
          String(args.text ?? ''),
          mode,
          0,
          typeof args.id === 'string' ? args.id : undefined,
          args.direct === true,
        )
      }
      // ── v7 orchestration ──
      case 'plano_run_create':
        return this.bus.runCreate(agentId, String(args.objective ?? ''))
      case 'plano_task_create':
        return this.bus.taskCreate(
          agentId,
          String(args.spec ?? ''),
          Array.isArray(args.deps) ? args.deps.map(String) : [],
          typeof args.parent === 'string' ? args.parent : undefined,
        )
      case 'plano_task_list':
        return this.bus.taskList(agentId, { ready: args.ready === true })
      case 'plano_dispatch':
        return this.bus.dispatchTask(
          agentId,
          String(args.taskId ?? ''),
          String(args.to ?? ''),
          typeof args.retryOf === 'string' ? args.retryOf : undefined,
        )
      case 'plano_worker_done':
        return this.bus.workerDone(
          agentId,
          typeof args.dispatchId === 'string' ? args.dispatchId : undefined,
          args.outcome === 'failed' ? 'failed' : 'succeeded',
          typeof args.summary === 'string' ? args.summary : undefined,
          Array.isArray(args.files) ? args.files.map(String) : undefined,
        )
      case 'plano_check':
        return this.bus.check(agentId, {
          types: Array.isArray(args.types) ? args.types.map(String) : undefined,
          wait: args.wait === true,
          timeoutMs: typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined,
          ack: typeof args.ack === 'string' ? args.ack : undefined,
        })
      case 'plano_watch':
        return this.bus.watchMessage(
          agentId,
          String(args.id ?? ''),
          typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined,
        )
      case 'plano_ask':
        return this.bus.ask(agentId, String(args.to ?? ''), String(args.text ?? ''), typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined)
      case 'plano_reply':
        return this.bus.reply(agentId, String(args.correlationId ?? ''), String(args.summary ?? ''))
      case 'plano_cancel':
        return this.bus.cancel(agentId, String(args.correlationId ?? ''))
      case 'plano_declare':
        return this.bus.declareCapabilities(agentId, args.capabilities)
      case 'plano_find':
        return this.bus.find(agentId, String(args.capability ?? ''))
      case 'plano_set_model':
        return this.bus.setModel(agentId, String(args.agentId ?? ''), args.model)
      case 'plano_interrupt':
        return this.bus.interrupt(agentId, String(args.agentId ?? ''))
      case 'plano_compact':
        return this.bus.compact(agentId, String(args.agentId ?? ''))
      case 'plano_chain':
        return this.bus.chain(agentId, {
          to: String(args.to ?? ''),
          payload: args.payload,
          when: typeof args.when === 'string' ? args.when : undefined,
          watch: typeof args.watch === 'string' ? args.watch : undefined,
          timeoutMs: typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined,
          onFailure: typeof args.onFailure === 'string' ? args.onFailure : undefined,
          hops: typeof args.hops === 'number' ? args.hops : undefined,
        })
      case 'plano_chain_payload':
        return this.bus.chainPayload(agentId, String(args.chainId ?? ''), String(args.text ?? ''))
      case 'plano_chains':
        return this.bus.chainsView()
      case 'plano_cancel_chain':
        return this.bus.cancelChain(agentId, String(args.chainId ?? ''))
      case 'plano_broadcast':
        return this.bus.broadcast(agentId, String(args.filter ?? ''), String(args.text ?? ''))
      case 'plano_context':
        return this.bus.context(agentId, String(args.agentId ?? ''))
      case 'plano_claim':
        return this.bus.claim(agentId, String(args.task ?? ''))
      case 'plano_handoff':
        return this.bus.handoff(agentId, String(args.to ?? ''), String(args.task ?? ''))
      case 'plano_spawn_agent':
        return this.bus.spawnAgent(agentId, {
          harness: String(args.harness ?? ''),
          cwd: String(args.cwd ?? ''),
          prompt: typeof args.prompt === 'string' ? args.prompt : undefined,
          count: typeof args.count === 'number' ? Math.max(1, Math.floor(args.count)) : 1,
        })
      case 'plano_close':
        return this.bus.closeAgent(agentId, String(args.agentId ?? ''), { panel: args.panel === true })
      case 'plano_wait':
        return this.bus.waitForIdle(agentId, String(args.agentId ?? ''), {
          timeoutMs: typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined,
          quietMs: typeof args.quietMs === 'number' ? args.quietMs : undefined,
          since: typeof args.since === 'number' ? args.since : undefined,
          nextTurn: args.nextTurn === true,
        })
      default:
        return { ok: false, error: 'unknown-tool', detail: `no mesh method named '${name}'` }
    }
  }
}
