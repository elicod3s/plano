/**
 * Mesh auto-provisioning (plan v5 A1): the mesh is CLI-first. Agents orchestrate through the
 * `plano` binary on PATH (installed by `installCli` into <userData>/bin) — no MCP server config
 * is written into any harness anymore. The daemon:
 *   1. installs the CLI + launchers (mesh/cli.ts),
 *   2. installs the Claude Code skill (below) so Claude KNOWS it can orchestrate,
 *   3. cleans up the stale `plano` MCP entries that previous versions merged into harness
 *      configs (the `plano mcp` stdio server no longer exists — leaving the entry would make
 *      every harness log dead-server errors).
 *
 * None of this may ever prevent the Agent Host from starting: without the daemon there are no
 * terminals at all, so a failure here degrades the mesh, never the app.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

// The frontmatter is not decoration: a harness decides whether to OPEN a skill from its
// description alone. Shipping this file without one left it advertised as the bare title "PLANO
// Mesh", which tells a model nothing about when it applies — so the agent that most needed it
// never opened it and improvised the mesh from whatever it could infer. The description therefore
// names the situations verbatim ("wait for messages", "talk to another agent", "another terminal"),
// because those are the words that will be in the prompt when this file is the answer.
const SKILL_MD = `---
name: plano-mesh
description: >-
  Use the PLANO mesh whenever this terminal must reach, wait for, or coordinate with another agent
  or terminal on the same PLANO canvas. Triggers include being told to wait for messages, to stay
  available, to answer when someone writes, to message/ask/reply to another agent, to check who
  else is running, to read what another agent is doing, to spawn a new agent, or to hand work to
  another terminal. Also use it when a message arrives carrying a correlation id like #a3f2b, or
  when you need to know whether something you sent actually arrived. The \`plano\` CLI is already
  on PATH; receiving is a blocking \`plano check --wait\` call, never sleeping or polling.
---

# PLANO Mesh

You are running inside PLANO, an infinite-canvas workspace. Other agents (Claude Code, Codex,
Gemini CLI, OpenCode, Cursor agents…) may be running in other terminals on the same canvas —
the PLANO mesh connects you through the \`plano\` CLI, which is already on your PATH.

## How you RECEIVE — read this before anything else

\`\`\`sh
plano check --wait --timeout-ms 90000 --json
\`\`\`

This BLOCKS until mail arrives and then returns it. **This is what "wait for a message" means.**
Never sleep, never poll in a loop, never watch your own screen for something to appear, and never
tell the user you are waiting while running nothing — block on this call, and the message is handed
to you as the output of a command you are already running.

**90 seconds, not more.** Your own harness kills a shell command at around 120 s. A longer block is
killed by the caller, which looks exactly like a broken mesh. Return inside the window and go again.

### The loop, exactly

\`\`\`sh
# 1. listen
plano check --wait --timeout-ms 90000 --json

# 2a. it returned {"checkpoint": true} → nothing arrived IN THAT WINDOW.
#     Not a failure. Not proof the mesh is dead. Not a reason to stop. Run step 1 again.

# 2b. it returned {"count": N, "deliveryId": "...", "messages": [...]}
#     → handle EVERY message in the batch, then acknowledge and keep listening in one call:
plano check --ack <deliveryId> --wait --timeout-ms 90000 --json
\`\`\`

Until you acknowledge, the same batch comes back. That is deliberate: an agent that dies mid-batch
loses nothing. It also means **acknowledging before you have handled every message throws the rest
away** — process the whole batch first.

Keep looping for as long as you are supposed to be listening. Stopping after one checkpoint is the
single most common way an agent goes silent while believing it is still available.

### What to do with a message you received

1. **It carries a correlation id like \`#a3f2b\`** — a peer is BLOCKED waiting on you. Answer it:
   \`\`\`sh
   plano reply a3f2b "<your answer>"
   \`\`\`
   If you cannot answer, reply saying so. Never leave it unanswered: the other side is holding.
2. **It is a task** — do it, then report back to the sender with \`plano send <from> "<result>"\`.
3. **It is from \`plano\` itself** — that is a system outcome report about a message YOU sent
   (delivered / expired / undeliverable / peer blocked). Act on it instead of re-sending blindly.

Then go back to listening. Answering and then going quiet is the same failure as never answering.

> Mail is durable the moment \`send\` returns. A peer that is booting, mid-turn, or parked in
> \`check --wait\` still receives it. Being busy DELAYS a message; it never loses one.

## Then: the four things you will actually do

Every command is a subcommand of \`plano\`. Add \`--json\` when you want to parse instead of read.

**1. See who is here**
\`\`\`sh
plano roster
\`\`\`
One row per agent: id (short prefixes work), harness, state, workspace, folder, inbox depth, task.
Pick peers by folder/workspace — that is what tells two agents apart.

**2. Read what another agent wrote — this always works**
\`\`\`sh
plano context <agentId> --lines 60    # their conversation, like reading over their shoulder
plano status  <agentId>               # their state, task, and a short tail
\`\`\`
You do NOT need their permission, and it does not need the desktop window open. If you are about
to ask "what did you do?", read it yourself first — it is faster and it costs them nothing.

**3. Say something**
\`\`\`sh
plano send <to> "the message"
\`\`\`
The message is recorded first and routed second, so it cannot be lost by a screen that was not
ready. If the peer is blocked on \`plano check --wait\` it wakes with your message immediately
(\`channel: "check"\`). Otherwise it is typed into their terminal, and if they are mid-turn it
waits in their mailbox until they are free or until they check. **\`send\` never refuses** — not a
booting agent, not a plain shell. Never invent your own acknowledgement (do not echo sentinels):
to confirm it landed, use the id:
\`\`\`sh
plano watch <messageId>               # blocks until delivered (or expired), then answers
\`\`\`

**4. Delegate and wait for the result**
\`\`\`sh
plano send <to> "<the full task>" --wait      # types it, then blocks until that turn finishes
plano ask  <to> "<question>"                  # same, but you want an ANSWER back
\`\`\`
\`--wait\` prints what they produced in \`delta\`. \`ask\` gives them a correlation id and they must
answer it with \`plano reply\`.

### The two questions people confuse

| You want to know | Use | Not |
|---|---|---|
| Did my message arrive? | \`plano watch <messageId>\` | \`plano wait\` |
| Is the peer done with its turn? | \`plano wait <agentId>\` | \`plano watch\` |
| What did the peer actually say? | \`plano context <agentId>\` | guessing from \`status\` |

### If something looks stuck

- \`plano roster\` shows each agent's **inbox** count — a growing one means they are saturated,
  not that they are ignoring you.
- Read \`plano inbox\`: messages **from \`plano\`** are outcome reports about YOUR messages
  (delivered / expired / undeliverable / peer blocked). Act on them; do not blindly re-send.
- A peer stuck on a permission prompt reports \`awaiting-input\`. Only a human can clear it —
  say so instead of waiting forever.

## Full command reference

- **Know yourself**: \`plano whoami\` — your agent id, workspace, capabilities.
- **Discover peers**: \`plano roster\` — every agent's id (short unique prefixes work), harness,
  workspace, state (idle/working/awaiting-input/error/exited), current task, panel.
- **How is X doing**: \`plano status <agentId>\` — live state (idle/working/awaiting-input/
  error/exited), current task, redacted output tail, pending messages, exit code.
- **Read X's whole chat**: \`plano context <agentId> [--lines N]\` — the full transcript of
  another agent, exactly like reading its conversation. Bounded (~64 KiB) and redacted
  when the desktop app answers; when it is closed or slow the daemon serves its own rendered copy
  of that terminal, so this NEVER comes back empty just because the window is not open.
- **Send a message**: \`plano send <to> <text>\` — recorded first, routed second, so it cannot be
  lost by a screen that was not ready. The reply tells you which route it took:
  \`channel: "check"\` (the peer was listening and woke with it — milliseconds),
  \`status: "delivered"\` (typed into their terminal), or \`status: "queued"\` (saved in their
  mailbox; they get it on their next \`check\`, or it is typed in when their composer opens).
  All three mean *the message exists and will arrive* — none of them is a reason to re-send.
  \`send\` never refuses: not a booting agent, not an undetected harness, not a plain shell.
  Add \`--direct\` only when you want type-or-nothing instead.
- **Receive a message**: \`plano check --wait --timeout-ms 90000 --json\` — see the top of this
  file. This is the only correct way to wait for one.
- **Know it landed**: \`plano watch <messageId>\` blocks until that message is delivered (or
  expires) and answers either way. \`plano wait\` answers "is the peer done with its turn", which
  is a DIFFERENT question — do not use it to check whether your message arrived.
- **Read your system mail**: messages \`from plano\` in \`plano inbox\` are OUTCOME REPORTS about
  your own messages (delivered, expired, undeliverable, target blocked). If you get one, act on it
  — re-send or interrupt — instead of assuming your earlier message did its job.
- **Ask AND wait for the answer**: \`plano ask <to> <text> [--timeout-ms N]\` — the delivered
  line carries a short correlation id (\`#a3f2b\`). When YOU receive a line containing
  \`#xxxxx\`, you MUST answer with \`plano reply <correlationId> <summary>\` when you finish; if
  you cannot answer, reply with an empty summary instead of ignoring it.
- **Delegate and WAIT (the core pattern)**: \`plano send <to> "<the plan>" --wait
  [--timeout-ms N]\` — types the plan into the target and blocks until it finishes the turn the
  message triggers (stably idle or exited), printing what it produced in \`delta\`.
- **Waiting never hangs on you**: \`plano wait <to>\` on a peer that ALREADY finished returns its
  transcript immediately (\`alreadyIdle\`) instead of blocking on its next turn — pass
  \`--next-turn\` when you really want the next one. A peer stuck on a permission prompt comes
  back \`blocked\` (answer it, or \`plano send\` it a reply); a timeout still prints the output so
  far and exits 2. When you need a definite answer rather than "the turn ended", use
  \`plano ask\` — only the peer's own \`plano reply\` resolves it. A timeout returns
  \`status: "pending"\`: the question is still open. PLANO will never hand you a guess scraped from
  their transcript dressed up as their answer.
- **Close a terminal**: \`plano close <agentId> [--panel]\` — kills that session and removes its
  panel from the canvas; \`--panel\` closes every terminal in that panel. This is the undo of
  \`spawn\`: tidy up workers you created instead of leaving dead panels behind. Closing YOURSELF is
  allowed (the answer is sent before the terminal goes).
- **Create new agents in THIS canvas**: \`plano spawn <harness> [folder] [--prompt "<task>"]
  [--count N] [--wait]\` — fresh terminal(s) booting the harness appear in the same workspace,
  next to your panel. \`--wait\` blocks until they finish. Alias of spawn:
  \`plano worktree create <folder> --agent <harness> --prompt "<task>" --wait\`.
  **\`<harness>\` is NOT a closed list.** Known names open straight away:
  \`claude codex pi omp kiro opencode aider gemini cursor grok\`. Any OTHER name is looked up as
  an executable installed on this host (PATH plus the usual per-user install dirs), so when the
  user asks for an agent you have never heard of, **just try it** — \`plano spawn <its-cli-name>\`
  — instead of telling them it is unsupported. Only if that comes back \`unknown harness\` (the
  error lists everywhere it looked) is it genuinely not installed; then ask the user for the
  command that starts it. The name must be a bare tool name: no spaces, paths or shell
  characters, so a multi-word invocation is not spawnable this way.
- **Coordinate**: \`plano claim "<task>"\` marks you busy; \`plano handoff <to> "<task>"\` hands
  work on and goes idle.
- **Chain work forward**: \`plano chain <to> --payload "<text>"\` (or \`--payload file:<path>\`)
  with \`--when i-finish|agent-finishes|i-reply\` — when the trigger fires, the payload is
  delivered to \`to\` ONCE and it executes. List: \`plano chains\`; cancel:
  \`plano cancel-chain <chainId>\`; set the explicit payload: \`plano chain-payload <chainId> <text>\`.
- **Inbox**: \`plano inbox\` (messages queued while you were busy) and \`plano ack <messageId>\`
  after processing — exactly-once delivery.
- **Capabilities**: \`plano declare '{"vision":true,"canSpawn":true,"contextTokens":200000,"model":"...","tools":["..."]}'\`
  publishes what you can do; \`plano find vision|canSpawn|contextTokens:N|model:<substr>|tool:<name>\`
  finds peers that can do it.
- **Control**: \`plano set-model <agentId> <model>\` (idle only), \`plano interrupt <agentId>\`,
  \`plano compact <agentId>\`.
- **Audit / fan-out**: \`plano timeline\` for the recent audit trail;
  \`plano broadcast <filter> <text>\` to every matching agent (harness/cwd/workspace substring).

## The delegation pattern that always works

1. **Spawn fresh**: \`plano spawn codex packages/api --prompt "implement X; write PLAN.md first" --wait\`
   — the new terminal appears in your canvas and the prompt is typed into it. Or delegate to an
   existing peer: \`plano send <to> "<the plan>" --wait\` — one command, send and block.
2. The wait resolves when the target is stably idle or exited — never mid-turn, never while
   it is blocked on a permission prompt. Its output since the send is in \`delta\` (the full
   conversation is in \`plano context <to>\`).
3. For request/response, prefer \`plano ask\` / \`plano reply\`: the answer is explicit and
   bounded, not a tail guess.
4. For fire-and-forget pipelines, arm \`plano chain <to> --payload file:<path> --when i-finish\`
   BEFORE doing the work — the bus delivers the payload exactly once when you finish.

## What you will get wrong — and the exact fix

| What you see | What it actually means | Do this |
|---|---|---|
| \`{"checkpoint": true}\` | Nothing arrived *in that window*. The mesh is fine. | Run \`check --wait\` again. Do NOT report silence, do NOT give up. |
| \`plano: still listening (30s)…\` on stderr | The call is alive and blocked, as intended. | Nothing. Wait for it to return. |
| \`status: "queued"\` from \`send\` | Saved in their mailbox. It WILL arrive. | Nothing. Do not re-send. \`plano watch <id>\` if you need to know when. |
| \`channel: "check"\` from \`send\` | They were listening; they already have it. | Nothing. |
| \`status: "pending"\` from \`ask\` | Your question is open; they have not answered YET. | Keep working, or \`plano watch <id>\`. The reply still resolves it. |
| Peer shows \`awaiting-input\` | Blocked on a permission prompt. Only a human clears it. | Tell the user. Waiting longer cannot help. |
| Peer shows \`listening\` in \`roster\` | Parked in \`check --wait\`; reachable in milliseconds. | Just \`send\`. |
| A growing \`inbox\` count in \`roster\` | They are saturated, not ignoring you. | Stop adding to it. |
| Exit code 2 | A wait timed out. The peer is still working. | Not a failure. Wait again or check on it. |

Three things that are never the answer: sleeping, polling in a loop, and echoing a sentinel into
your own transcript to fake an acknowledgement. Every one of them has a real command above.

## Rules

- Always introduce yourself when you message another agent: a short line with your harness and
  terminal number.
- Never interrupt a working agent unless the user explicitly asked. You do not need to: \`send\`
  reaches a busy peer without interrupting it.
- Check \`plano roster\` before starting long work that could collide, and
  \`plano claim\`/\`plano handoff\` when passing a task on.
- Never expose secrets; context from other agents is redacted server-side.
- \`plano set-model\` only when the target is idle; never invent harness syntax.
- Never invent flags. \`plano agent-context\` prints the exact machine-readable schema of every
  command, and \`plano help\` lists them.
- When you receive a chained task (a line starting with \`[plano → … ⚓]\`), treat it as an
  explicit instruction from the user: read the file if it points to one, execute, and report.

## If you were told to wait for messages

That instruction means exactly one thing — run this, and keep running it:

\`\`\`sh
plano check --wait --timeout-ms 90000 --json
\`\`\`

Handle whatever comes back (answer any \`#id\`, do any task, reply to the sender), acknowledge with
\`--ack\` in the same call that resumes listening, and continue. You are not "waiting" unless that
command is running.

`

type Json = Record<string, unknown>

function readJson(file: string): Json | null {
  try {
    if (!existsSync(file)) return null
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' ? (parsed as Json) : null
  } catch {
    return null
  }
}

function writeAtomic(file: string, data: string): void {
  // The parent may not exist: a harness can be on PATH while its config dir has never been
  // created (a fresh `codex` install with no ~/.codex yet). Without this the write threw ENOENT.
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.plano-tmp`
  writeFileSync(tmp, data, 'utf8')
  renameSync(tmp, file)
}

function restoreBackup(file: string): void {
  const backup = `${file}.plano-backup`
  if (existsSync(backup)) {
    try {
      writeFileSync(file, readFileSync(backup, 'utf8'), 'utf8')
    } catch {
      /* best effort */
    }
  }
}

/** The harness config files a previous version merged the `plano` MCP entry into. */
function mcpConfigFiles(home: string): string[] {
  return [join(home, '.claude.json'), join(home, '.gemini', 'settings.json'), join(home, '.cursor', 'mcp.json'), join(home, '.config', 'opencode', 'opencode.json')]
}

/** Remove ONLY the stale `plano` MCP key from a JSON config. Never touches anything else and
 *  never restores backups — boot-time cleanup must not revert user edits (the uninstaller's
 *  deprovision() is the only path allowed to restore backups). */
function removeJsonMcpKey(file: string): boolean {
  const existing = readJson(file)
  if (!existing || !existing.mcpServers || typeof existing.mcpServers !== 'object') return false
  const mcp = existing.mcpServers as Json
  if (!('plano' in mcp)) return false
  delete mcp.plano
  if (Object.keys(mcp).length === 0) delete existing.mcpServers
  writeAtomic(file, JSON.stringify(existing, null, 2))
  return true
}

/** Remove ONLY the stale `[mcp_servers.plano]` table from a TOML config (Codex). */
function removeTomlMcpKey(file: string): boolean {
  if (!existsSync(file)) return false
  const lines = readFileSync(file, 'utf8').split(/\r?\n/)
  const out: string[] = []
  let inPlano = false
  let removed = false
  for (const line of lines) {
    if (inPlano) {
      if (/^\[/.test(line.trim())) inPlano = false
      else continue
    }
    if (/^\[mcp_servers\.plano\]/.test(line.trim())) {
      inPlano = true
      removed = true
      continue
    }
    out.push(line)
  }
  if (!removed) return false
  // Drop a trailing blank line we may have left behind.
  while (out.length > 0 && out[out.length - 1].trim() === '') out.pop()
  writeAtomic(file, out.join('\n'))
  return true
}

/**
 * Boot-time cleanup (plan v5 A1): strip the stale `plano` MCP entries that pre-v5 versions
 * merged into harness configs. The `plano mcp` stdio server is gone, so a leftover entry is
 * just a dead server every harness logs errors about. Idempotent, never touches user content,
 * never restores backups. Returns the files it cleaned.
 */
export function cleanupMcpEntries(home: string = homedir()): { cleaned: string[] } {
  const cleaned: string[] = []
  const jsonStep = (label: string, file: string): void => {
    try {
      if (removeJsonMcpKey(file)) cleaned.push(label)
    } catch {
      /* one unwritable config must not stop the rest */
    }
  }
  const tomlStep = (label: string, file: string): void => {
    try {
      if (removeTomlMcpKey(file)) cleaned.push(label)
    } catch {
      /* same */
    }
  }
  for (const file of mcpConfigFiles(home)) jsonStep(file, file)
  tomlStep(join(home, '.codex', 'config.toml'), join(home, '.codex', 'config.toml'))
  return { cleaned }
}

// ── every harness learns the mesh, not just Claude (plan v5 A2) ───────────────
//
// Under MCP each harness was told about the mesh by its own config entry, so an agent knew the
// moment it booted. Removing MCP removed that for everyone except Claude Code (which kept its
// skill), and agents ended up with the CLI on PATH but no idea it existed. Provisioning now
// writes the same briefing into each harness's own global-instructions file, in the format that
// harness actually reads — the CLI-first equivalent of the old config entry.

const BLOCK_BEGIN = '<!-- BEGIN PLANO MESH — auto-generated by PLANO; edits inside this block are overwritten -->'
const BLOCK_END = '<!-- END PLANO MESH -->'

/** The briefing merged into global instruction files. Deliberately short: it is loaded into
 *  EVERY session of that harness, so it teaches the entry points and defers the full surface to
 *  `plano agent-context` (the machine-readable schema of all commands). */
const BRIEF_MD = `# PLANO Mesh

When \`PLANO_SESSION=plano\` is set you are running in a PLANO terminal, on a canvas that may hold
other agents (Claude Code, Codex, Gemini CLI, OpenCode, Cursor, Kiro…). The \`plano\` CLI is on
your PATH and is how you talk to them. Every command takes \`--json\`; exit code 2 means a wait
timed out. Run \`plano agent-context\` for the full machine-readable command schema.

**To RECEIVE a message: \`plano check --wait --timeout-ms 90000 --json\`.** It blocks until mail
arrives and hands it to you as its output — that is what "wait for a message" means here. Never
sleep, poll, or watch the screen. \`{"checkpoint": true}\` means nothing arrived in that window,
not that the mesh is silent: run it again. Handle a batch, then acknowledge and keep listening in
one call — \`plano check --ack <deliveryId> --wait --timeout-ms 90000 --json\`. The batch replays
until you acknowledge it, so nothing is lost if you die mid-batch.

- \`plano whoami\` — who and where you are.
- \`plano roster\` — every live agent: id (unique prefixes work), harness, state, current task.
- \`plano status <id>\` / \`plano context <id> [--lines N]\` — a peer's live state / its full
  redacted transcript.
- \`plano send <id> "<text>"\` — recorded first, routed second; it never refuses and it is never
  lost. \`channel: "check"\` means the peer was listening and already has it; \`queued\` means it is
  in their mailbox and will arrive — neither is a reason to re-send. Add \`--wait\` to block until
  the peer finishes the turn your message triggers, and print its output.
- \`plano ask <id> "<question>"\` — send and wait for an explicit answer. When a message you
  receive carries a correlation id (\`#a3f2b\`), answer it with \`plano reply <id> "<summary>"\`.
- \`plano spawn <harness> [folder] [--prompt "<task>"] [--count N] [--wait]\` — open new agents in
  THIS canvas, next to your panel, and optionally block until they finish their task.
  \`<harness>\` is not a closed list: \`claude codex pi omp kiro opencode aider gemini cursor grok\`
  open straight away, and any other name is resolved as an agent CLI installed on this host. If
  the user names an agent you do not know, TRY IT before saying it is unsupported.
- \`plano wait <id>\` — block until a peer is stably idle or exits. It always answers: a peer
  that ALREADY finished returns its transcript with \`alreadyIdle\` (add \`--next-turn\` to wait
  for the next turn instead), and a peer stuck on a permission prompt returns \`blocked\` instead
  of burning the timeout. Exit code 2 means it timed out and is still working.

**Which one to use.** For "do this and tell me the result", prefer \`plano ask\` — it resolves ONLY
on an explicit \`plano reply\` from the peer. It never invents an answer out of their transcript:
a timeout comes back \`status: "pending"\`, meaning the question is still open, not lost and not
answered. Use \`send --wait\` when you only need "the turn it triggered is over". Reach for bare
\`plano wait\` to check on work already in flight; if it comes back \`blocked\`, the peer needs a
human or a message from you — waiting longer will not help.

**The mistakes that cost the most.** \`{"checkpoint": true}\` means nothing arrived in that window —
run \`check --wait\` again, do not report silence and do not stop listening. \`queued\` and
\`channel: "check"\` both mean the message WILL arrive: never re-send. Exit code 2 is a timeout, not
a failure. Never sleep, never poll in a loop, and never echo a sentinel to fake an acknowledgement —
there is a real command for each of those.
- \`plano claim "<task>"\` / \`plano handoff <id> "<task>"\` — coordinate so agents do not collide.
- \`plano chain <id> --payload "<text>" --when i-finish\` — deliver work to a peer exactly once
  when you finish. \`plano inbox\` / \`plano ack <messageId>\` for queued messages.

Rules: introduce yourself when messaging a peer; do not interrupt a working agent unless asked;
check \`plano roster\` before long work that could collide; never invent flags — read
\`plano help <command>\`.
`

/**
 * Merge the briefing into a markdown instructions file, between stable markers. Existing user
 * content is preserved: the block is replaced in place when present, appended otherwise.
 */
function upsertBlock(file: string, body: string): void {
  const block = `${BLOCK_BEGIN}\n\n${body}\n${BLOCK_END}\n`
  let existing = ''
  try {
    if (existsSync(file)) existing = readFileSync(file, 'utf8')
  } catch {
    existing = ''
  }
  const start = existing.indexOf(BLOCK_BEGIN)
  const end = existing.indexOf(BLOCK_END)
  if (start !== -1 && end > start) {
    const next = `${existing.slice(0, start)}${block}${existing.slice(end + BLOCK_END.length).replace(/^\r?\n/, '')}`
    if (next !== existing) writeAtomic(file, next)
    return
  }
  const next = existing.trim() ? `${existing.replace(/\s*$/, '')}\n\n${block}` : block
  writeAtomic(file, next)
}

/** Strip the briefing block again, leaving the user's own content untouched. */
function removeBlock(file: string): void {
  try {
    if (!existsSync(file)) return
    const existing = readFileSync(file, 'utf8')
    const start = existing.indexOf(BLOCK_BEGIN)
    const end = existing.indexOf(BLOCK_END)
    if (start === -1 || end <= start) return
    const next = `${existing.slice(0, start)}${existing.slice(end + BLOCK_END.length).replace(/^\r?\n/, '')}`.replace(/\s*$/, '\n')
    if (next.trim()) writeAtomic(file, next)
    else rmSync(file, { force: true })
  } catch {
    /* one unwritable file must not stop the rest */
  }
}

/**
 * Where each harness reads its GLOBAL instructions from. `home` is the directory that must
 * already exist for the harness to count as installed — PLANO never creates a config dir for a
 * tool the user does not have (Claude Code is the exception: its skill dir is ours to create).
 */
function briefingTargets(home: string): { label: string; dir: string; file: string }[] {
  return [
    { label: 'codex', dir: join(home, '.codex'), file: join(home, '.codex', 'AGENTS.md') },
    { label: 'gemini', dir: join(home, '.gemini'), file: join(home, '.gemini', 'GEMINI.md') },
    { label: 'opencode', dir: join(home, '.config', 'opencode'), file: join(home, '.config', 'opencode', 'AGENTS.md') },
    { label: 'cursor', dir: join(home, '.cursor'), file: join(home, '.cursor', 'AGENTS.md') },
    { label: 'pi', dir: join(home, '.pi'), file: join(home, '.pi', 'AGENTS.md') },
    // OMP was missing entirely, which is why the harness the user actually spawns learned nothing
    // about the mesh from provisioning — only from the prompt preamble.
    { label: 'omp', dir: join(home, '.omp'), file: join(home, '.omp', 'AGENTS.md') },
  ]
}

/** Harnesses that read Claude-style skill folders — they get the full SKILL.md, not the brief. */
function skillTargets(home: string): { label: string; dir: string; create: boolean }[] {
  return [
    { label: 'claude-code', dir: join(home, '.claude', 'skills', 'plano-mesh'), create: true },
    { label: 'kiro', dir: join(home, '.kiro', 'skills', 'plano-mesh'), create: existsSync(join(home, '.kiro', 'skills')) },
    // Grok keeps a Claude-style ~/.grok/skills folder, so it gets the full guide rather than the
    // short brief. Only when that folder already exists — PLANO never invents a config dir.
    { label: 'grok', dir: join(home, '.grok', 'skills', 'plano-mesh'), create: existsSync(join(home, '.grok', 'skills')) },
  ]
}

/**
 * Teach EVERY installed harness about the mesh (plan v5 A2). Runs at daemon boot, so it also
 * self-heals after an update or a harness being installed later. Idempotent; never throws.
 * Returns the labels it provisioned.
 */
export function installAgentDocs(home: string = homedir()): { provisioned: string[] } {
  const provisioned: string[] = []
  for (const target of skillTargets(home)) {
    try {
      if (!target.create) continue
      mkdirSync(target.dir, { recursive: true })
      writeAtomic(join(target.dir, 'SKILL.md'), SKILL_MD)
      provisioned.push(target.label)
    } catch {
      /* keep going: one harness failing must not skip the rest */
    }
  }
  for (const target of briefingTargets(home)) {
    try {
      if (!existsSync(target.dir)) continue
      upsertBlock(target.file, BRIEF_MD)
      provisioned.push(target.label)
    } catch {
      /* same */
    }
  }
  return { provisioned }
}

/** Remove every `plano` trace from harness configs and restore backups (plan F9 — uninstaller
 *  only). The skill dir is removed when it holds nothing but the skill. */
export function deprovision(home: string = homedir()): { ok: boolean } {
  for (const file of mcpConfigFiles(home)) {
    const existing = readJson(file)
    if (existing && existing.mcpServers && typeof existing.mcpServers === 'object') {
      delete (existing.mcpServers as Json).plano
      writeAtomic(file, JSON.stringify(existing, null, 2))
    }
    restoreBackup(file)
  }
  const codex = join(home, '.codex', 'config.toml')
  if (existsSync(codex)) {
    const lines = readFileSync(codex, 'utf8').split(/\r?\n/)
    const out: string[] = []
    let inPlano = false
    for (const line of lines) {
      if (inPlano) {
        if (/^\[/.test(line.trim())) inPlano = false
        else continue
      }
      if (/^\[mcp_servers\.plano\]/.test(line.trim())) {
        inPlano = true
        continue
      }
      out.push(line)
    }
    writeAtomic(codex, out.join('\n'))
    restoreBackup(codex)
  }
  for (const target of skillTargets(home)) {
    try {
      if (!existsSync(join(target.dir, 'SKILL.md'))) continue
      if (readdirSync(target.dir).filter((f) => f !== 'SKILL.md').length === 0) {
        rmSync(target.dir, { recursive: true, force: true })
      }
    } catch {
      /* best effort */
    }
  }
  // v5 A2: take the briefing back out of every harness's global instructions.
  for (const target of briefingTargets(home)) removeBlock(target.file)
  return { ok: true }
}
