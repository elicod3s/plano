/**
 * Command handlers (plan v5 A1). Every handler is one or two RPC calls — including the two
 * flagship orchestration flows:
 *   - `plano wait <id>`  → plano_wait long-poll (server-side, event-driven) with a retry while
 *     a newborn spawn has not been detected as an agent yet;
 *   - `plano spawn --wait` → plano_spawn_agent (returns the exact ptyIds) then plano_wait on
 *     each, printing every agent's output delta — the "send the plan, wait for it" pattern.
 */

import { MeshClient, MeshCliError, type MeshResult } from './client'
import { COMMANDS } from './spec'

export interface ParsedArgs {
  key: string
  positional: string[]
  flags: Record<string, string | boolean>
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * v5 A3: default budget for every blocking flow. A wait now always ends with an ANSWER —
 * finished, already-idle (with the transcript), blocked on a prompt, or timed out with the
 * output so far — so a 10-minute default only made a caller sit on keepalives for nothing.
 */
const WAIT_DEFAULT_TIMEOUT_MS = 180_000

function needClient(client: MeshClient): void {
  if (!client.ready) {
    throw new MeshCliError(
      'no-token',
      'PLANO_MESH_TOKEN is not set — this shell is not a PLANO agent terminal. Start a terminal in PLANO and run an AI CLI inside it.',
      1,
    )
  }
}

function jsonMode(flags: Record<string, string | boolean>, json: boolean): boolean {
  return process.env.PLANO_CLI_JSON === '1' || json || flags.json === true
}

function num(flags: Record<string, string | boolean>, name: string, fallback: number): number {
  const v = flags[name]
  if (typeof v !== 'string') return fallback
  const n = Number.parseInt(v, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/** `--payload` accepts `file:<path>`; the bus expects `{ file: path }` there. */
function chainPayload(value: string): string | { file: string } {
  if (value.startsWith('file:')) return { file: value.slice(5) }
  return value
}

/**
 * Resolve an alias to its real command. The spec has advertised aliases in `plano help` since
 * spawn shipped, but nothing ever mapped them — an agent that read the help and typed
 * `plano worker-start` got "unknown command". Reading the table here keeps the help honest by
 * construction: an alias exists exactly when it is documented.
 */
function resolveAlias(key: string): string {
  if (!key) return key
  for (const entry of COMMANDS) {
    if (entry.command === key) return key
    if (entry.aliases?.includes(key)) return entry.command
  }
  return key
}

export async function run(rawKey: string, p: ParsedArgs, client: MeshClient): Promise<{ output: string; exitCode: number }> {
  const { positional: pos, flags } = p
  const json = jsonMode(flags, false)
  const key = resolveAlias(rawKey)
  switch (key) {
    case 'whoami': {
      needClient(client)
      return finish(client, 'plano_whoami', {}, json, (r) => formatWhoami(r))
    }
    case 'roster': {
      needClient(client)
      return finish(client, 'plano_roster', {}, json, formatRoster)
    }
    case 'status': {
      needClient(client)
      const id = pos[0]
      if (!id) throw usage('status <agentId>')
      return finish(client, 'plano_status', { agentId: id }, json, formatStatus)
    }
    case 'close': {
      needClient(client)
      const id = pos[0]
      if (!id) throw usage('close <agentId> [--panel]')
      // `--panel` takes down every terminal in that panel; the default closes just this session.
      return finish(client, 'plano_close', { agentId: id, panel: flags.panel === true }, json, formatClose)
    }
    case 'watch': {
      needClient(client)
      const id = pos[0]
      if (!id) throw usage('watch <messageId> [--timeout-ms <ms>]')
      const timeoutMs = num(flags, 'timeout-ms', 300_000)
      // Long-poll: the daemon answers the moment the message reaches a terminal status.
      const res = await client.call('plano_watch', { id, timeoutMs }, { timeoutMs: timeoutMs + 30_000, keepalive: true })
      if (json) return { output: JSON.stringify(res, null, 2), exitCode: 0 }
      if (!res.ok) return { output: failText(res), exitCode: 1 }
      return { output: formatWatch(res), exitCode: res.status === 'delivered' ? 0 : 2 }
    }
    // ── v7 orchestration: the coordinator loop ──
    case 'run-create': {
      needClient(client)
      const objective = pos.join(' ')
      if (!objective) throw usage('run-create <objective>')
      return finish(client, 'plano_run_create', { objective }, json, (r) => `run ${String(r.runId)} — ${String(r.objective)}`)
    }
    case 'task-create': {
      needClient(client)
      const spec = pos.join(' ')
      if (!spec) throw usage('task-create <spec> [--deps id1,id2]')
      const deps = typeof flags.deps === 'string' ? flags.deps.split(',').map((d) => d.trim()).filter(Boolean) : []
      return finish(client, 'plano_task_create', { spec, deps }, json, (r) =>
        `task ${String(r.taskId)} (${String(r.status)})${deps.length ? ` after ${deps.join(', ')}` : ''}`,
      )
    }
    case 'task-list': {
      needClient(client)
      return finish(client, 'plano_task_list', { ready: flags.ready === true }, json, formatTasks)
    }
    case 'dispatch': {
      needClient(client)
      const taskId = pos[0]
      const to = pos[1]
      if (!taskId || !to) throw usage('dispatch <taskId> <agentId> [--retry-of <dispatchId>]')
      return finish(
        client,
        'plano_dispatch',
        { taskId, to, retryOf: typeof flags['retry-of'] === 'string' ? flags['retry-of'] : undefined },
        json,
        (r) => `dispatch ${String(r.dispatchId)} → ${String(r.to)} (${String(r.status)})`,
      )
    }
    case 'worker-done': {
      needClient(client)
      // The dispatch id is optional: a worker usually has exactly one active attempt.
      const dispatchId = pos[0] && pos[0].startsWith('disp_') ? pos[0] : undefined
      const outcome = flags.outcome === 'failed' ? 'failed' : 'succeeded'
      const summary = typeof flags.summary === 'string' ? flags.summary : pos.slice(dispatchId ? 1 : 0).join(' ')
      const files = typeof flags['files-modified'] === 'string' ? flags['files-modified'].split(',').map((f) => f.trim()) : undefined
      return finish(client, 'plano_worker_done', { dispatchId, outcome, summary, files }, json, (r) =>
        `reported ${String(r.outcome)} for task ${String(r.taskId)} — task is now ${String(r.taskStatus)}${r.circuitBroken ? ' (circuit breaker: no more attempts)' : ''}`,
      )
    }
    case 'check': {
      needClient(client)
      const types = typeof flags.types === 'string' ? flags.types.split(',').map((t) => t.trim()).filter(Boolean) : undefined
      const wait = flags.wait === true
      const timeoutMs = num(flags, 'timeout-ms', 900_000)
      const res = await client.call(
        'plano_check',
        { types, wait, timeoutMs, ack: typeof flags.ack === 'string' ? flags.ack : undefined },
        { timeoutMs: wait ? timeoutMs + 30_000 : 30_000, keepalive: wait },
      )
      if (json) return { output: JSON.stringify(res, null, 2), exitCode: 0 }
      if (!res.ok) return { output: failText(res), exitCode: 1 }
      return { output: formatCheck(res), exitCode: 0 }
    }
    case 'inbox': {
      needClient(client)
      return finish(client, 'plano_inbox', {}, json, formatInbox)
    }
    case 'ack': {
      needClient(client)
      if (!pos[0]) throw usage('ack <messageId>')
      return finish(client, 'plano_ack', { id: pos[0] }, json, (r) => (r.ok ? `acked: ${String(r.acked ?? false)}` : ''))
    }
    case 'send': {
      needClient(client)
      const to = pos[0]
      const text = pos.slice(1).join(' ')
      if (!to || !text) throw usage('send <to> <text>')
      // v5 A1: `send --wait` is the one-shot delegation pattern — type the plan, then block
      // until the target finishes the turn it triggers. `since` = before the send, so a fast
      // target whose whole turn completes in one detect-poll gap still resolves (not a hang).
      const since = flags.wait === true ? Date.now() : undefined
      const res = await client.call(
        'plano_send',
        {
          to,
          text,
          mode: flags.queue === true ? 'queue' : 'type',
          id: typeof flags.id === 'string' ? flags.id : undefined,
          direct: flags.direct === true,
        },
        { timeoutMs: since ? 60_000 : 30_000 },
      )
      if (!res.ok) return { output: failText(res), exitCode: 1 }
      if (!since) {
        if (json) return { output: JSON.stringify(res, null, 2), exitCode: 0 }
        return { output: formatSend(res, to), exitCode: 0 }
      }
      const timeoutMs = num(flags, 'timeout-ms', WAIT_DEFAULT_TIMEOUT_MS)
      const quietMs = num(flags, 'quiet-ms', 2000)
      const w = await waitFlow(client, to, { 'timeout-ms': String(timeoutMs), 'quiet-ms': String(quietMs) }, json, since)
      if (json) {
        let wJson: unknown = null
        try {
          wJson = JSON.parse(w.output)
        } catch {
          wJson = w.output
        }
        return { output: JSON.stringify({ send: res, wait: wJson }, null, 2), exitCode: w.exitCode }
      }
      return { output: `sent to ${to} (${String(res.status ?? 'delivered')})\n${w.output}`, exitCode: w.exitCode }
    }
    case 'ask': {
      needClient(client)
      const to = pos[0]
      const text = pos.slice(1).join(' ')
      if (!to || !text) throw usage('ask <to> <text>')
      const timeoutMs = num(flags, 'timeout-ms', 60_000)
      const res = await client.call('plano_ask', { to, text, timeoutMs }, { timeoutMs: timeoutMs + 30_000, keepalive: true })
      if (json) return { output: JSON.stringify(res, null, 2), exitCode: 0 }
      if (!res.ok) return { output: failText(res), exitCode: 1 }
      // Three honest outcomes, never a manufactured one: they answered, they cannot take input
      // yet (queued), or they have not answered yet (still pending).
      if (res.status === 'queued') {
        return { output: `queued for ${to}: ${String(res.detail ?? 'not ready yet')}`, exitCode: 0 }
      }
      if (res.answered === false || res.timeout) {
        const context = String(res.contextTail ?? '').trim()
        return {
          output: `${String(res.detail ?? `${to} has not answered yet — still pending.`)}${context ? `\n\n--- what they are doing (context, NOT an answer) ---\n${context}` : ''}`,
          exitCode: 2,
        }
      }
      return { output: `reply from ${to}:\n${String(res.reply ?? '')}`, exitCode: 0 }
    }
    case 'reply': {
      needClient(client)
      if (!pos[0] || pos.length < 2) throw usage('reply <correlationId> <summary>')
      return finish(client, 'plano_reply', { correlationId: pos[0], summary: pos.slice(1).join(' ') }, json)
    }
    case 'cancel': {
      needClient(client)
      if (!pos[0]) throw usage('cancel <correlationId>')
      return finish(client, 'plano_cancel', { correlationId: pos[0] }, json)
    }
    case 'declare': {
      needClient(client)
      if (!pos[0]) throw usage('declare <capabilities-json>')
      let caps: unknown
      try {
        caps = JSON.parse(pos[0])
      } catch {
        throw usage('declare <capabilities-json> — value must be valid JSON')
      }
      return finish(client, 'plano_declare', { capabilities: caps }, json)
    }
    case 'find': {
      needClient(client)
      if (!pos[0]) throw usage('find <capability>')
      return finish(client, 'plano_find', { capability: pos[0] }, json, formatFind)
    }
    case 'set-model': {
      needClient(client)
      if (!pos[0] || !pos[1]) throw usage('set-model <agentId> <model>')
      return finish(client, 'plano_set_model', { agentId: pos[0], model: pos[1] }, json)
    }
    case 'interrupt': {
      needClient(client)
      if (!pos[0]) throw usage('interrupt <agentId>')
      return finish(client, 'plano_interrupt', { agentId: pos[0] }, json)
    }
    case 'compact': {
      needClient(client)
      if (!pos[0]) throw usage('compact <agentId>')
      return finish(client, 'plano_compact', { agentId: pos[0] }, json)
    }
    case 'chain': {
      needClient(client)
      const to = pos[0]
      if (!to) throw usage('chain <to> [--payload ...]')
      const payload = typeof flags.payload === 'string' ? chainPayload(flags.payload) : undefined
      const when = typeof flags.when === 'string' ? flags.when : undefined
      const watch = typeof flags.watch === 'string' ? flags.watch : undefined
      return finish(
        client,
        'plano_chain',
        {
          to,
          payload,
          when,
          watch,
          timeoutMs: num(flags, 'timeout-ms', 0) || undefined,
          onFailure: typeof flags['on-failure'] === 'string' ? flags['on-failure'] : undefined,
          hops: typeof flags.hops === 'string' ? Number.parseInt(flags.hops, 10) : undefined,
        },
        json,
        (r) => (r.ok ? `chain armed: ${String(r.chainId ?? '')} (${String(r.when ?? 'i-finish')}) → ${to}` : ''),
      )
    }
    case 'chain-payload': {
      needClient(client)
      if (!pos[0] || pos.length < 2) throw usage('chain-payload <chainId> <text>')
      return finish(client, 'plano_chain_payload', { chainId: pos[0], text: pos.slice(1).join(' ') }, json)
    }
    case 'chains': {
      needClient(client)
      return finish(client, 'plano_chains', {}, json, formatChains)
    }
    case 'cancel-chain': {
      needClient(client)
      if (!pos[0]) throw usage('cancel-chain <chainId>')
      return finish(client, 'plano_cancel_chain', { chainId: pos[0] }, json)
    }
    case 'broadcast': {
      needClient(client)
      const filter = pos[0] ?? ''
      const text = pos.slice(1).join(' ')
      if (!text) throw usage('broadcast <filter> <text>')
      return finish(client, 'plano_broadcast', { filter, text }, json, formatBroadcast)
    }
    case 'context': {
      needClient(client)
      if (!pos[0]) throw usage('context <agentId>')
      const res = await client.call('plano_context', { agentId: pos[0] })
      if (json) return { output: JSON.stringify(res, null, 2), exitCode: 0 }
      if (!res.ok) return { output: failText(res), exitCode: 1 }
      let tail = String(res.tail ?? '')
      const lines = typeof flags.lines === 'string' ? Number.parseInt(flags.lines, 10) : NaN
      if (Number.isFinite(lines) && lines > 0) tail = tail.split('\n').slice(-lines).join('\n')
      return { output: `chat of ${String(res.agent ?? pos[0])}${tail ? `:\n${tail}` : ' (empty — nothing recorded yet)'}`, exitCode: 0 }
    }
    case 'claim': {
      needClient(client)
      const task = pos.join(' ')
      if (!task) throw usage('claim <task>')
      return finish(client, 'plano_claim', { task }, json, (r) => (r.ok ? `claimed: ${task}` : ''))
    }
    case 'handoff': {
      needClient(client)
      const to = pos[0]
      const task = pos.slice(1).join(' ')
      if (!to || !task) throw usage('handoff <to> <task>')
      return finish(client, 'plano_handoff', { to, task }, json)
    }
    case 'timeline': {
      needClient(client)
      return finish(client, 'plano_timeline', {}, json, formatTimeline)
    }
    case 'wait':
      return waitFlow(client, pos[0], flags, json)
    case 'spawn':
      return spawnFlow(client, pos, flags, json, false)
    case 'worktree create':
      return spawnFlow(client, pos, flags, json, true)
    default:
      throw usage(`unknown command: ${key || '(none)'} — run 'plano help'`)
  }
}

/** The core primitive: block until the target finishes its turn or exits. */
async function waitFlow(
  client: MeshClient,
  agentId: string | undefined,
  flags: Record<string, string | boolean>,
  json: boolean,
  since?: number,
): Promise<{ output: string; exitCode: number }> {
  needClient(client)
  if (!agentId) throw usage('wait <agentId>')
  // 5 minutes, not 10: a wait now ends with an ANSWER in every case (finished, already idle,
  // blocked on a prompt, or timed out with the output so far), so a long default only delays
  // the caller. Pass --timeout-ms for genuinely long turns.
  const timeoutMs = num(flags, 'timeout-ms', WAIT_DEFAULT_TIMEOUT_MS)
  const quietMs = num(flags, 'quiet-ms', 2000)
  const nextTurn = flags['next-turn'] === true
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const remaining = Math.max(1000, deadline - Date.now())
    const res = await client.call(
      'plano_wait',
      { agentId, timeoutMs: remaining, quietMs, nextTurn, ...(since ? { since } : {}) },
      { timeoutMs: remaining + 30_000, keepalive: true },
    )
    // A newborn spawn is 'unknown' until detection sees its harness — keep waiting for it.
    if (!res.ok && res.error === 'not-agent') {
      if (Date.now() >= deadline - 500) return { output: failText(res), exitCode: 1 }
      await sleep(1000)
      continue
    }
    if (json) return { output: JSON.stringify(res, null, 2), exitCode: res.ok && res.timedOut === true ? 2 : 0 }
    if (!res.ok) return { output: failText(res), exitCode: 1 }
    // Every outcome prints what the peer actually has: `alreadyIdle` returns its transcript
    // (the answer was there before the wait started) and `blocked` returns the prompt text.
    const body = String(res.delta ?? '') || String(res.tail ?? '')
    const why = res.alreadyIdle
      ? ` (already idle for ${Math.round(Number(res.idleFor ?? 0) / 1000)}s — this is its last turn, not a new one; use --next-turn to wait for the NEXT one)`
      : res.blocked
        ? ' (BLOCKED — waiting for input: answer the prompt in its terminal, or plano send it a reply)'
        : res.timedOut
          ? ' (TIMED OUT — still working; the output so far is above)'
          : ''
    const footer = `state: ${String(res.state)} after ${String(res.durationMs)} ms${why}${res.exitCode != null ? `, exit ${String(res.exitCode)}` : ''}`
    return { output: body ? `${body}\n\n${footer}` : footer, exitCode: res.timedOut === true ? 2 : 0 }
  }
}

/** Spawn agent(s) in this canvas, optionally waiting on each one. */
async function spawnFlow(client: MeshClient, pos: string[], flags: Record<string, string | boolean>, json: boolean, worktree: boolean): Promise<{ output: string; exitCode: number }> {
  needClient(client)
  const harness = worktree ? (typeof flags.agent === 'string' ? flags.agent : '') : (pos[0] ?? '')
  const folder = worktree ? (pos[0] ?? '') : (pos[1] ?? '')
  const prompt = typeof flags.prompt === 'string' ? flags.prompt : undefined
  const count = num(flags, 'count', 1)
  const wantWait = flags.wait === true
  if (!harness) throw usage(worktree ? 'worktree create <folder> --agent <harness> [--prompt ...]' : 'spawn <harness> [folder] [--prompt ...]')
  const res = await client.call('plano_spawn_agent', { harness, cwd: folder, prompt, count })
  // A failed spawn stays machine-readable under --json (it used to fall through to plain text
  // whenever --wait was also set, which no JSON caller can parse).
  if (!res.ok) return { output: json ? JSON.stringify(res, null, 2) : failText(res), exitCode: 1 }
  if (json && !wantWait) return { output: JSON.stringify(res, null, 2), exitCode: 0 }
  const ptyIds = Array.isArray(res.ptyIds) ? (res.ptyIds as string[]) : []
  const summary = `spawned ${String(res.spawned ?? count)}x ${harness}${folder ? ` in ${folder}` : ''}${ptyIds.length ? ` — ${ptyIds.join(', ')}` : ''}`
  if (!wantWait) return { output: json ? JSON.stringify(res, null, 2) : summary, exitCode: 0 }
  const timeoutMs = num(flags, 'timeout-ms', WAIT_DEFAULT_TIMEOUT_MS)
  const quietMs = num(flags, 'quiet-ms', 2000)
  // --json must print ONE document. It used to concatenate the spawn result and each wait
  // result, so `JSON.parse` on the output threw and every machine caller (agents, the e2e)
  // saw a spawn --wait as a failure. The waits are folded into the spawn object instead:
  // `wait` = the first agent (the single-spawn case), `waits` = every agent in ptyId order.
  const blocks: string[] = json ? [] : [summary]
  const waits: unknown[] = []
  let worst: number = 0
  for (const ptyId of ptyIds) {
    // v5 A1: with a prompt, wait until it visibly LANDS in the newborn's transcript before
    // starting the turn-wait — otherwise the newborn's initial idle resolves immediately and
    // the prompt hasn't even been typed yet (deliverPromptToSpawned waits for detection first).
    if (prompt) {
      const needle = prompt.slice(0, 40)
      const deadline = Date.now() + 60_000
      while (Date.now() < deadline) {
        let landed = false
        try {
          const ctx = await client.call('plano_context', { agentId: ptyId })
          landed = typeof ctx.tail === 'string' && ctx.tail.includes(needle)
        } catch {
          /* newborn may not be an agent yet — keep polling */
        }
        if (landed) break
        await sleep(1000)
      }
      // The prompt echo can land while the harness is still booting (codex shows boot gaps
      // that look like a finished turn). Let the boot settle, then wait with a LONG quiet
      // window so only a genuinely stable idle resolves. The turn itself cannot be missed in
      // the meantime: the daemon anchors the wait to the instant it typed the prompt, so a
      // fast agent that already answered still returns its output instead of an empty delta.
      await sleep(3000)
    }
    const w = await waitFlow(client, ptyId, { 'timeout-ms': String(timeoutMs), 'quiet-ms': String(Math.max(quietMs, 8000)) }, json)
    worst = Math.max(worst, w.exitCode)
    if (json) {
      let parsed: unknown
      try {
        parsed = JSON.parse(w.output)
      } catch {
        parsed = w.output
      }
      waits.push(parsed)
    } else {
      blocks.push(`\n${ptyId.slice(0, 8)}:\n${w.output}`)
    }
  }
  if (json) return { output: JSON.stringify({ ...res, wait: waits[0] ?? null, waits }, null, 2), exitCode: worst }
  return { output: blocks.join('\n'), exitCode: worst }
}

// ── output ──────────────────────────────────────────────────────────────────

function usage(message: string): MeshCliError {
  return new MeshCliError('usage', message, 1)
}

function failText(res: MeshResult): string {
  return `failed: ${String(res.error ?? 'error')}${res.detail ? ` — ${String(res.detail)}` : ''}`
}

async function finish(
  client: MeshClient,
  method: string,
  params: Record<string, unknown>,
  json: boolean,
  human?: (r: MeshResult) => string,
): Promise<{ output: string; exitCode: number }> {
  const res = await client.call(method, params)
  if (json) return { output: JSON.stringify(res, null, 2), exitCode: res.ok ? 0 : 1 }
  if (!res.ok) return { output: failText(res), exitCode: 1 }
  return { output: human ? human(res) : 'ok', exitCode: 0 }
}

function formatWhoami(r: MeshResult): string {
  const lines = [
    `id: ${String(r.id ?? '')}`,
    `kind: ${String(r.kind ?? 'unknown')}`,
    `workspace: ${String(r.workspace ?? '')}`,
    `cwd: ${String(r.cwd ?? '')}`,
    `capabilities: ${JSON.stringify(r.capabilities ?? {})}`,
  ]
  return lines.join('\n')
}

/** Last path segment of a cwd \u2014 the folder is what actually tells two agents apart at a glance. */
function folderOf(cwd: unknown): string {
  const path = String(cwd ?? '')
  if (!path) return ''
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] ?? ''
}

/**
 * The roster carried `workspace` and `cwd` all along and printed neither, so an agent looking at
 * three peers could not tell which canvas or which project any of them belonged to. Both are
 * columns now: the workspace id groups them, the folder says what they are working on.
 */
function formatRoster(r: MeshResult): string {
  const agents = (r.agents as Array<Record<string, unknown>> | undefined) ?? []
  if (agents.length === 0) return 'no agents on the roster'
  const rows = agents.map((a) => {
    const id = String(a.id ?? '')
    const short = id.length > 8 ? `${id.slice(0, 8)}\u2026` : id
    // v6 B3: mailbox depth, with the oldest wait when it is starting to matter. Saturation used
    // to be invisible until an orchestrator's own messages began dying.
    const pending = typeof a.pending === 'number' ? a.pending : 0
    const oldestMs = typeof a.oldestPendingMs === 'number' ? a.oldestPendingMs : 0
    const inbox = pending === 0 ? '-' : oldestMs > 60_000 ? `${pending} (${Math.round(oldestMs / 60_000)}m)` : String(pending)
    // A peer inside `plano check --wait` is reachable in milliseconds; say so where the state is
    // read, because "listening" is a stronger fact than any state we infer from a screen.
    const state = a.listening === true ? 'listening' : String(a.state ?? '?')
    return [
      short.padEnd(9),
      String(a.kind ?? '?').padEnd(11),
      state.padEnd(14),
      String(a.workspace ?? '-').slice(0, 10).padEnd(11),
      folderOf(a.cwd).slice(0, 18).padEnd(19),
      inbox.padEnd(8),
      String(a.currentTask ?? '').slice(0, 40),
    ].join(' ')
  })
  const header = [
    'id'.padEnd(9),
    'kind'.padEnd(11),
    'state'.padEnd(14),
    'workspace'.padEnd(11),
    'folder'.padEnd(19),
    'inbox'.padEnd(8),
    'task',
  ].join(' ')
  return `agents: ${agents.length}\n${header}\n${rows.join('\n')}`
}

/** v6 A1/A4: the answer says what actually happened — queued-because-busy and truncation included. */
function formatSend(r: MeshResult, to: string): string {
  const status = String(r.status ?? 'delivered')
  const lines: string[] = []
  if (status === 'queued') {
    if (r.humanActionRequired) {
      lines.push(`queued for ${to}: they are on a permission prompt; PLANO wrote 0 bytes and a human must clear it`)
    } else {
      lines.push(`queued for ${to}: the TUI is not sendable yet, so PLANO wrote 0 bytes and will retry when ready`)
    }
    lines.push(`follow it with: plano watch ${String(r.id ?? '')}`)
  } else {
    lines.push(
      `sent to ${to}: ${status}${r.confirmed ? ' (confirmed)' : ''}; accepted=${String(r.accepted === true)}, bytesWritten=${String(r.bytesWritten ?? 0)}`,
    )
  }
  if (r.truncated) lines.push('WARNING: the message was longer than the limit and was cut — send the rest as a second message')
  return lines.join('\n')
}

function formatWatch(r: MeshResult): string {
  const status = String(r.status ?? 'unknown')
  if (status === 'delivered') {
    return `delivered; accepted=${String(r.accepted === true)}, bytesWritten=${String(r.bytesWritten ?? 0)}${r.confirmed ? ' (they reacted)' : ' (no reaction observed yet)'}`
  }
  if (status === 'expired') return 'EXPIRED — never delivered; re-send it'
  if (status === 'undeliverable') return `undeliverable: ${String(r.reason ?? 'write failed')}`
  if (r.timedOut) return 'still queued — the target has not been free yet (watch again, or plano interrupt them)'
  return status
}

function formatTasks(r: MeshResult): string {
  const tasks = (r.tasks as Array<Record<string, unknown>> | undefined) ?? []
  if (tasks.length === 0) return 'no tasks yet — create one with: plano task-create "<spec>"'
  const rows = tasks.map((t) => {
    const deps = (t.deps as string[] | undefined) ?? []
    const disp = (t.dispatches as Array<Record<string, unknown>> | undefined) ?? []
    const where = disp.length > 0 ? ` · ${disp.length} attempt${disp.length === 1 ? '' : 's'}` : ''
    return `${String(t.id).padEnd(14)} ${String(t.status).padEnd(11)} ${deps.length ? `after ${deps.join(',')} ` : ''}${String(t.spec).slice(0, 70)}${where}`
  })
  const header = ['id'.padEnd(14), 'status'.padEnd(11), 'spec'].join(' ')
  return `${tasks.length} task${tasks.length === 1 ? '' : 's'}\n${header}\n${rows.join('\n')}`
}

/** A timeout must never read as a failure — that is how a healthy worker gets declared dead. */
function formatCheck(r: MeshResult): string {
  if (r.checkpoint) return String(r.detail ?? 'nothing waiting yet — checkpoint, not a failure. Keep waiting.')
  const msgs = (r.messages as Array<Record<string, unknown>> | undefined) ?? []
  // Never truncate the body. A question carries its reply instruction — `[reply with: plano reply
  // <id> …]` — at the END of the text, so clipping at 160 characters removed the one part the
  // receiver had to act on and left it holding a question it could not answer.
  const lines = msgs.map((m) => `[${String(m.kind)}] from ${String(m.from).slice(0, 8)}: ${String(m.text)}`)
  const body = lines.join('\n')
  return `${msgs.length} message${msgs.length === 1 ? '' : 's'}\n${body}\n\nack with: plano check --ack ${String(r.deliveryId)}`
}

function formatClose(r: MeshResult): string {
  const closed = (r.closed as string[] | undefined) ?? []
  const ids = closed.map((id) => id.slice(0, 8)).join(', ')
  if (r.self) return `closing this terminal (${ids})`
  return `closed ${closed.length} terminal${closed.length === 1 ? '' : 's'}${r.panel ? ' (whole panel)' : ''}: ${ids}`
}

function formatStatus(r: MeshResult): string {
  return [
    `id: ${String(r.id ?? '')}`,
    `kind: ${String(r.kind ?? '')}`,
    // Where it lives, so "which of these is the one editing my repo" is answerable without
    // guessing from the task string.
    `workspace: ${String(r.workspace ?? '(unknown)')}`,
    `cwd: ${String(r.cwd ?? '(unknown)')}`,
    `state: ${String(r.state ?? '')} (since ${String(r.since ?? '')})`,
    `task: ${String(r.currentTask ?? '(none)')}`,
    `pending messages: ${String(r.pendingMessages ?? 0)}`,
    `exit: ${String(r.exitCode ?? 'running')}`,
    r.lastOutput ? `tail: ${String(r.lastOutput).slice(-200)}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

function formatInbox(r: MeshResult): string {
  const messages = (r.messages as Array<Record<string, unknown>> | undefined) ?? []
  if (messages.length === 0) return 'inbox empty'
  return messages.map((m) => `#${String(m.id).slice(0, 8)} from ${String(m.from).slice(0, 8)}: ${String(m.text ?? '')}`).join('\n')
}

function formatFind(r: MeshResult): string {
  const agents = (r.agents as Array<Record<string, unknown>> | undefined) ?? []
  if (agents.length === 0) return 'no matches'
  return agents.map((a) => `${String(a.id).slice(0, 8)}\u2026 ${String(a.kind ?? '?')} — ${String(a.match ?? '')}`).join('\n')
}

function formatChains(r: MeshResult): string {
  const chains = (r.chains as Array<Record<string, unknown>> | undefined) ?? []
  if (chains.length === 0) return 'no chains'
  return chains
    .map((c) => `${String(c.id).slice(0, 8)} ${String(c.status ?? '?').padEnd(9)} ${String(c.when ?? '')} ${String(c.to ?? '').slice(0, 8)} payload:${String((c.payload as { source?: string })?.source ?? '?')}`)
    .join('\n')
}

function formatBroadcast(r: MeshResult): string {
  const sent = (r.sent as Array<Record<string, unknown>> | undefined) ?? []
  if (sent.length === 0) return 'no matching agents'
  return sent.map((s) => `→ ${String(s.to).slice(0, 8)}: ${String(s.status ?? 'ok')}`).join('\n')
}

function formatTimeline(r: MeshResult): string {
  const events = (r.events as Array<Record<string, unknown>> | undefined) ?? []
  if (events.length === 0) return 'no events yet'
  return events
    .map((e) => `${new Date(Number(e.at)).toISOString().slice(11, 19)} ${String(e.kind ?? '?').padEnd(14)} ${String(e.from ?? '').slice(0, 8)}${e.to ? ` → ${String(e.to).slice(0, 8)}` : ''} ${String(e.detail ?? '')}`)
    .join('\n')
}
