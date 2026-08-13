/**
 * Command spec table (plan v5 A1) — the single source of truth for `plano help`,
 * `plano agent-context --json` (a machine-readable schema so agents can discover the surface,
 * the same trick as Orca's agent-context) and the usage errors in commands.ts.
 */

/**
 * The spawnable harnesses. MUST mirror the keys of AGENT_LAUNCH_COMMANDS in
 * @shared/domain/agentLaunch — `grok` was bootable by the daemon yet invisible here, so agents
 * reading `plano help` / `plano agent-context --json` never tried it.
 *
 * Deliberately a literal and NOT an import: installCli() copies out/main/cli.js into
 * <userData>/bin as a SINGLE standalone file, so any import that rollup splits into
 * ./chunks/* makes the installed CLI die with MODULE_NOT_FOUND. Keep this bundle
 * dependency-free; when you add a harness, add it in both places.
 */
const HARNESSES = 'claude | codex | pi | omp | kiro | opencode | aider | gemini | cursor | grok'

/**
 * Named harnesses are not a closed set: anything else is looked up as an executable on this
 * host (PATH plus the usual per-user install dirs), so an agent CLI installed here can be
 * opened even when this list predates it.
 */
const HARNESS_HINT = `${HARNESSES} — or any other agent CLI installed on this host`

export interface FlagSpec {
  flag: string
  /** When present, the flag takes a value (separate token or --flag=value). */
  arg?: string
  desc: string
}

export interface CommandSpec {
  /** Primary command key (may contain a space, e.g. "worktree create"). */
  command: string
  summary: string
  usage: string
  args: string[]
  flags?: FlagSpec[]
  aliases?: string[]
}

const F_TIMEOUT: FlagSpec = { flag: '--timeout-ms', arg: '<ms>', desc: 'max wait in ms (default 300000; every outcome answers, so raise it only for genuinely long turns)' }
const F_JSON: FlagSpec = { flag: '--json', desc: 'machine-readable JSON output' }

export const COMMANDS: CommandSpec[] = [
  {
    command: 'whoami',
    summary: 'My mesh identity, workspace, cwd and capabilities',
    usage: 'plano whoami',
    args: [],
    aliases: ['me'],
  },
  {
    command: 'roster',
    summary: 'Every live agent: id, harness, workspace, state, current task, panel',
    usage: 'plano roster',
    args: [],
    aliases: ['agents', 'list'],
  },
  {
    command: 'status',
    summary: 'One agent\'s state, current task, redacted tail, mailbox depth, exit code',
    usage: 'plano status <agentId>',
    args: ['<agentId>'],
  },
  {
    command: 'send',
    summary: 'Type a message into another agent\'s terminal, optionally blocking until it finishes the turn it triggers',
    usage: 'plano send <to> <text> [--queue] [--wait] [--timeout-ms <ms>] [--id <uuid>] [--json]',
    args: ['<to>', '<text...>'],
    flags: [
      { flag: '--queue', desc: 'deliver when the target is idle instead of typing now' },
      { flag: '--direct', desc: 'refuse if the target is mid-turn instead of queuing (pre-v6 behaviour)' },
      { flag: '--wait', desc: 'block until the target finishes the turn this message triggers (or exits)' },
      F_TIMEOUT,
      { flag: '--id', arg: '<uuid>', desc: 'idempotency key — replaying it never duplicates' },
      F_JSON,
    ],
  },
  {
    command: 'ask',
    summary: 'Send a question/task AND wait for the answer (correlation + explicit reply)',
    usage: 'plano ask <to> <text> [--timeout-ms <ms>] [--json]',
    args: ['<to>', '<text...>'],
    flags: [F_TIMEOUT, F_JSON],
  },
  {
    command: 'reply',
    summary: 'Answer an ask I received (the correlation id from the incoming #xxxxx line)',
    usage: 'plano reply <correlationId> <summary>',
    args: ['<correlationId>', '<summary...>'],
  },
  {
    command: 'cancel',
    summary: 'Cancel one of my pending asks; the caller stops waiting immediately',
    usage: 'plano cancel <correlationId>',
    args: ['<correlationId>'],
  },
  {
    command: 'inbox',
    summary: 'Messages queued for me (ack each after processing — exactly-once)',
    usage: 'plano inbox',
    args: [],
  },
  {
    command: 'ack',
    summary: 'Acknowledge a delivered inbox message',
    usage: 'plano ack <messageId>',
    args: ['<messageId>'],
  },
  {
    command: 'watch',
    summary: 'Block until a specific message is delivered (or expires) — the acknowledgement `wait` cannot give you',
    usage: 'plano watch <messageId> [--timeout-ms <ms>] [--json]',
    args: ['<messageId>'],
    flags: [F_TIMEOUT, F_JSON],
    aliases: ['track'],
  },
  {
    command: 'close',
    summary: 'Close a terminal: kill its session and remove its panel from the canvas (the undo of spawn)',
    usage: 'plano close <agentId> [--panel] [--json]',
    args: ['<agentId>'],
    flags: [
      { flag: '--panel', desc: 'close EVERY terminal in that panel, not just this session' },
      F_JSON,
    ],
    aliases: ['kill', 'worker-stop'],
  },
  {
    command: 'spawn',
    summary: 'Create new agent(s) in THIS canvas: fresh terminal(s) booting a harness, placed next to my panel',
    usage: 'plano spawn <harness> [folder] [--prompt <text>] [--count N] [--wait] [--timeout-ms <ms>] [--json]',
    args: [`<harness: ${HARNESS_HINT}>`, '[folder]'],
    flags: [
      { flag: '--prompt', arg: '<text>', desc: 'task typed into each new agent once it is up' },
      { flag: '--count', arg: '<n>', desc: 'how many agents to open (max 6)' },
      { flag: '--wait', desc: 'block until every spawned agent finishes its turn (or exits); with --json the results are folded in as wait (first) and waits (all)' },
      F_TIMEOUT,
      F_JSON,
    ],
    aliases: ['worker-start', 'dispatch'],
  },
  {
    command: 'worktree create',
    summary: 'Orca-style alias of spawn: boot an agent in a folder of this canvas',
    usage: 'plano worktree create <folder> --agent <harness> [--prompt <text>] [--wait] [--json]',
    args: ['<folder>'],
    flags: [
      { flag: '--agent', arg: '<harness>', desc: HARNESS_HINT },
      { flag: '--prompt', arg: '<text>', desc: 'task typed into the new agent once it is up' },
      { flag: '--wait', desc: 'block until the agent finishes its turn (or exits); with --json the result is folded in as wait' },
      F_TIMEOUT,
      F_JSON,
    ],
  },
  {
    command: 'wait',
    summary:
      'Block until an agent finishes its turn (stably idle) or exits; prints its output. Never hangs on a peer that already finished (returns its transcript with alreadyIdle) or is stuck on a permission prompt (returns blocked)',
    usage: 'plano wait <agentId> [--next-turn] [--timeout-ms <ms>] [--quiet-ms <ms>] [--json]',
    args: ['<agentId>'],
    flags: [
      { flag: '--next-turn', desc: 'wait for the NEXT turn even if the target is idle right now (default: an idle target answers immediately)' },
      F_TIMEOUT,
      { flag: '--quiet-ms', arg: '<ms>', desc: 'how long the target must stay idle to count as done (default 2000)' },
      F_JSON,
    ],
  },
  {
    command: 'claim',
    summary: 'Mark myself busy with a task so peers coordinate instead of stepping on me',
    usage: 'plano claim <task>',
    args: ['<task...>'],
  },
  {
    command: 'handoff',
    summary: 'Hand a task to another agent and go idle',
    usage: 'plano handoff <to> <task>',
    args: ['<to>', '<task...>'],
  },
  {
    command: 'chain',
    summary: 'Arm a chained task: when the trigger fires, the payload is delivered to <to> once',
    usage: 'plano chain <to> [--payload <text|file:path>] [--when i-finish|agent-finishes|i-reply] [--watch <agentId>] [--timeout-ms <ms>] [--on-failure notify|fire-anyway|ask-user] [--hops <n>]',
    args: ['<to>'],
    flags: [
      { flag: '--payload', arg: '<text|file:path>', desc: 'delivered text, or file:<path> to deliver the file path' },
      { flag: '--when', arg: '<when>', desc: 'i-finish (default) | agent-finishes (with --watch) | i-reply' },
      { flag: '--watch', arg: '<agentId>', desc: 'agent to watch when --when agent-finishes' },
      F_TIMEOUT,
      { flag: '--on-failure', arg: '<mode>', desc: 'notify (default) | fire-anyway | ask-user' },
      { flag: '--hops', arg: '<n>', desc: 'chain depth cap' },
    ],
  },
  {
    command: 'chain-payload',
    summary: 'Set the explicit payload of my armed chain before finishing (the reliable path)',
    usage: 'plano chain-payload <chainId> <text>',
    args: ['<chainId>', '<text...>'],
  },
  {
    command: 'chains',
    summary: 'List every chain (armed/fired/cancelled/expired/failed)',
    usage: 'plano chains',
    args: [],
  },
  {
    command: 'cancel-chain',
    summary: 'Cancel one of my armed chains; it never fires afterwards',
    usage: 'plano cancel-chain <chainId>',
    args: ['<chainId>'],
  },
  {
    command: 'broadcast',
    summary: 'Send to every agent matching a filter (harness/cwd/workspace substring), capped at 12',
    usage: 'plano broadcast <filter> <text>',
    args: ['<filter>', '<text...>'],
  },
  {
    command: 'context',
    summary: 'Another agent\'s full redacted chat transcript (bounded server-side, ~64 KiB) — read it like a conversation, as Orca\'s terminal read',
    usage: 'plano context <agentId> [--lines <n>] [--json]',
    args: ['<agentId>'],
    flags: [
      { flag: '--lines', arg: '<n>', desc: 'only the last N lines of the transcript (paging)' },
      F_JSON,
    ],
  },
  {
    command: 'declare',
    summary: 'Publish what I can do (authoritative capability declaration)',
    usage: 'plano declare \'{"vision":true,"canSpawn":true,"contextTokens":200000,"model":"...","tools":["..."]}\'',
    args: ['<capabilities-json>'],
  },
  {
    command: 'find',
    summary: 'Find agents with a capability: vision | canSpawn | contextTokens:<n> | model:<substr> | tool:<name>',
    usage: 'plano find <capability>',
    args: ['<capability>'],
  },
  {
    command: 'set-model',
    summary: 'Switch another agent\'s model via its own /model command (idle only)',
    usage: 'plano set-model <agentId> <model>',
    args: ['<agentId>', '<model>'],
  },
  {
    command: 'interrupt',
    summary: 'Interrupt another agent\'s current turn (Esc/Ctrl-C per harness)',
    usage: 'plano interrupt <agentId>',
    args: ['<agentId>'],
  },
  {
    command: 'compact',
    summary: 'Run the harness\'s compaction command (claude-code only today)',
    usage: 'plano compact <agentId>',
    args: ['<agentId>'],
  },
  {
    command: 'timeline',
    summary: 'Recent mesh events (messages, spawns, claims) — the audit trail',
    usage: 'plano timeline',
    args: [],
  },
  {
    command: 'agent-context',
    summary: 'Machine-readable spec of every command — for agents discovering the CLI',
    usage: 'plano agent-context [--json]',
    args: [],
    flags: [F_JSON],
  },
  {
    command: 'help',
    summary: 'This help, or help for one command',
    usage: 'plano help [command]',
    args: ['[command]'],
  },
  {
    command: 'version',
    summary: 'Print the CLI version',
    usage: 'plano version',
    args: [],
  },
]

/** Canonical key → spec. Handles the "worktree create" two-word keys. */
export function specFor(argv: string[]): { key: string; spec?: CommandSpec } {
  const one = argv[0] ?? ''
  const two = `${argv[0] ?? ''} ${argv[1] ?? ''}`
  const byKey = new Map(COMMANDS.map((c) => [c.command, c]))
  const byAlias = new Map(COMMANDS.flatMap((c) => (c.aliases ?? []).map((a) => [a, c])))
  if (byKey.has(two)) return { key: two, spec: byKey.get(two) }
  if (byKey.has(one)) return { key: one, spec: byKey.get(one) }
  if (byAlias.has(one)) return { key: byAlias.get(one)!.command, spec: byAlias.get(one) }
  if (byAlias.has(two)) return { key: byAlias.get(two)!.command, spec: byAlias.get(two) }
  return { key: one || '' }
}

export function agentContextJson(): string {
  return JSON.stringify(
    {
      cli: 'plano',
      protocol: 'jsonrpc-2.0',
      endpoint: 'PLANO_MESH_URL (default http://127.0.0.1:56780/cli)',
      auth: 'Authorization: Bearer $PLANO_MESH_TOKEN',
      commands: COMMANDS.map((c) => ({
        command: c.command,
        usage: c.usage,
        summary: c.summary,
        args: c.args,
        flags: (c.flags ?? []).map((f) => ({ flag: f.flag, arg: f.arg ?? null, desc: f.desc })),
        aliases: c.aliases ?? [],
      })),
      note: 'Agent ids: unique prefixes of the full id are accepted by every <to>/<agentId> argument.',
    },
    null,
    2,
  )
}

export function helpText(forKey?: string): string {
  if (forKey) {
    const spec = COMMANDS.find((c) => c.command === forKey)
    if (!spec) return `unknown command: ${forKey}\n\n${helpText()}`
    const flags = (spec.flags ?? []).map((f) => `  ${f.flag}${f.arg ? ` ${f.arg}` : ''}\t${f.desc}`).join('\n')
    return `${spec.command} — ${spec.summary}\n\nusage: ${spec.usage}\n${flags ? `\nflags:\n${flags}\n` : ''}`
  }
  const groups = [
    'identity', 'whoami', 'roster', 'status', 'find', 'declare',
    'messaging', 'send', 'ask', 'reply', 'cancel', 'inbox', 'ack', 'broadcast',
    'orchestration', 'spawn', 'worktree create', 'wait', 'claim', 'handoff', 'chain', 'chain-payload', 'chains', 'cancel-chain',
    'context', 'context', 'timeline',
    'control', 'set-model', 'interrupt', 'compact',
    'meta', 'agent-context', 'help', 'version',
  ]
  const lines: string[] = []
  for (let i = 0; i < groups.length; i += 2) {
    lines.push(`${groups[i + 1].padEnd(14)} ${groups[i]}`)
  }
  return `plano — PLANO mesh CLI: orchestrate agents from any terminal (v5)\n\nCommands:\n${lines.join('\n')}\n\nRun 'plano help <command>' for details. Add --json for machine output; exit code 2 means a wait timed out.`
}
