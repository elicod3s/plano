# PLAN — Agent Mesh v6: communication that cannot silently die

**Status:** proposed · **Owner:** mesh daemon (`src/main/daemon/mesh/*`) · **Predecessor:** `PLAN_AGENT_MESH_V5_CLI_FIRST.md`

## The incident this plan exists for

A real 4-agent session (orchestrator + 3 Oh My Pi workers building a fighting game) died mid-flight
in a recognizable way:

1. The orchestrator `plano send`-s a contract to a worker → `failed: working — target is mid-turn`.
   It retries with `--queue` → `queued`. It then tells the user "verdicts queued to all 3 agents,
   waiting for RENDER to finish" — **and that is the last coordination that ever happens.**
2. The workers finish their turns, sometimes consume a queued line, reply into *their own*
   transcript, and idle. Nobody learns anything from anybody. The conversation is dead, with every
   participant convinced it did its part.

"Se dejan de hablar" is not one bug. It is five small truths about the current transport that
compound under load. Each is cited below; all five must go.

## Root causes (verified in code, not guessed)

| # | Failure | Where | Effect under saturation |
|---|---------|-------|--------------------------|
| R1 | **Plain `send` refuses a busy target** (`failed: working — target is mid-turn`). | `bus.ts` send, type-mode guard | Every agent must know the retry dance. Some retry with `--queue`, some retry verbatim forever, some give up. First stall of every session (screenshots 43/44). |
| R2 | **Queued messages die silently.** TTL expiry (10 min, `DEFAULT_TTL_MS`) and undeliverable-after-5-attempts (`MAX_DELIVERY_ATTEMPTS`) push a **timeline event only** — the sender's mailbox gets nothing. (`bus.ts` drainMailbox, ~558–592.) | `bus.ts:558` | The orchestrator queues 3 verdicts; a worker stays busy 11 minutes; the verdict expires; **both sides wait on each other forever.** This is the main "stopped talking" mechanism. The only outcome that notifies today is peer-exited (added in 0.2.18). |
| R3 | **No way to know a queued message was consumed.** `--queue` returns `queued` and that's the last the sender can learn: `plano wait` waits for a *turn*, not for a *message*; `confirmAsync` writes its confirmed/unconfirmed verdict to the timeline only (`bus.ts:640–658`). | `bus.ts:640` | Agents invent their own signals ("echo SENT-ENGINE") — visible in screenshot 46 — and still can't correlate them. |
| R4 | **State can wedge at `working` for hookless harnesses.** Pi/OMP (exactly what the incident ran) get no lifecycle hooks (`agentHooks.ts` installs claude/gemini/opencode only; codex often skipped) so their state comes from the output-cadence heuristic (`index.ts` startDetection). A worker that streams/repaints reads `working` indefinitely → its mailbox **never drains** → R2 kills the mail. There is no stale-state watchdog: a stuck `working` is trusted forever. | `index.ts:655` | The saturation story: three chatty TUIs keep each other's inboxes sealed. |
| R5 | **Silent truncation + inconsistent busy rules.** `MAX_MESSAGE_LEN = 4000` truncates with `…` and the sender is never told; `ask` meanwhile types into a busy target without any guard (`bus.ts:1059`) while `send` refuses — two different contracts for the same act. | `bus.ts:20,1068,1080` | Long contracts (the ENGINE handoffs in the screenshots run 700+ chars; specs can exceed 4000) lose their tail exactly where the details live. |

## What Orca does (and what we take from it)

Surveyed from the live CLI (`orca terminal --help`, orchestration skill) and repo docs — Orca's
coordination never rides on inferred terminal text:

- **Message lifecycle is explicit and lives in the bus**: threaded messages, blocking `ask`/reply
  with obligations, task rows with `worker_done` waits, escalation timeouts. A message has a
  status you can *wait on*; nothing resolves by vibes.
- **The terminal is prompt transport only.** `terminal wait --for tui-idle --timeout-ms` is a
  primitive; handoffs are `create → wait tui-idle → send --enter`, then status flows through the
  orchestration store, not through screen-scraping.
- **Every blocking flow ends in an answer** (done / timeout / escalation), never in silence.

PLANO's mesh already has the bones of this (mailboxes, timeline, waits, screen emulation as of
0.2.18). v6 closes the gaps where an outcome exists but **nobody who cares is told**.

## Design principles

1. **No silent outcome.** Every terminal state of a message (delivered+confirmed, unconfirmed,
   expired, undeliverable, peer-exited) lands in the **sender's mailbox**, not only the timeline.
   The timeline is for audit; the mailbox is for participants.
2. **Busy is never the caller's problem.** Sending to a mid-turn agent queues; the result says so.
3. **A waiting caller can wait on the thing it cares about** — a specific message, not just "a turn".
4. **State cannot wedge.** Any `working` claim must be re-earned; a stale one demotes itself.
5. Everything stays in the daemon (works with the app closed), behind the existing consent gate,
   keeping 0.2.16's tightened timings.

---

## Phase A — Transport truth (no message dies silently)

**A1. `send` auto-queues on busy.**
In `bus.ts` send: when `mode === 'type'` and `target.busy`, do not refuse — queue it and return
`{ ok: true, status: 'queued', autoQueued: true }`. Add `--direct` to the CLI for the rare caller
that truly wants refusal semantics. Update `formatSend` to print
`queued (target mid-turn — will deliver when idle; plano watch <id> to follow)`.
*Kills R1 and the retry dance.*

**A2. Sender notices for every terminal outcome.**
Factor the 0.2.18 peer-exited notice into `notifySender(message, outcome, hint)` and call it from:
- TTL expiry (`drainMailbox`) — `"your queued message to X expired undelivered after 10m (it stayed
  busy). Re-send or plano interrupt X."`
- undeliverable after retries (`drainMailbox`) — write-failed hint.
- `confirmAsync` when unconfirmed — low-priority notice (`written but no reaction observed`).
Notices are system mail (`from: 'plano'`, `sysx-` ids, existing drain types them in when the
sender idles). Cap: one notice per message id; never notify about a notice.
*Kills R2.*

**A3. TTL counts only deliverable time.**
A queued message's clock should not run while the target cannot receive. In `drainMailbox`, when
the target is `working`, refresh `message.at` (or track `busyCredit`) so expiry measures **idle
time without delivery**, capped by an absolute `MAX_QUEUE_LIFE_MS = 60 min`. Expiry then means
"the target was reachable and it still didn't land", which is a real failure worth a notice.

**A4. Honest size handling, one rule for send and ask.**
Raise `MAX_MESSAGE_LEN` 4000 → 12000 (bursted typing makes this ~6 s worst case). When truncation
happens, return `truncated: true` + the cut length in the result so the sender can re-send as two
messages. `ask` adopts the same busy rule as A1 (queue the ask line; the correlation id already
survives queuing) instead of typing into a mid-turn TUI.
*Kills R5.*

## Phase B — Conversation primitives (know when it landed)

**B1. `plano watch <messageId>` (alias: `send --queue --watch`).**
New RPC `plano_watch`: long-poll on a message id; resolves when the message reaches a terminal
status, returning `{ status, confirmed, deliveredAt, reason }`. Implemented like idle-waiters:
a `Map<messageId, Waiter[]>` resolved from the exact points A2 instruments. Timeout returns the
current status instead of failing.
*Kills R3: "send verdict, know it landed" becomes one command.*

**B2. `send --queue --wait` composes correctly.**
Today `--wait` anchors on send time; for a queued message the turn to wait for is **the one the
delivery starts**, not the current one. Wire the existing `spawnPrompts` anchor into the drain
path: when a queued message is typed, set the anchor (at, baseline) for the target, so a pending
`wait` reports the turn the message caused. (The 0.2.18 send-anchor did this for direct sends.)

**B3. Backlog visibility.**
`rosterView()` gains `pending` (mailbox depth) per agent; `formatRoster` prints it as a column.
`status` already shows `pendingMessages` — add the age of the oldest. An orchestrator can now SEE
saturation instead of deducing it.

## Phase C — State cannot wedge (the Pi/OMP fix)

**C1. Stale-`working` watchdog (bus-side, harness-agnostic).**
In the detect loop (or a 30 s bus sweep): an agent that has claimed `working` for
`STALE_WORKING_MS = 4 min` with **no screen change** (compare `readScreen` hash) and **no live
worker processes** (`hasActiveWorkers`, already computed) demotes to `idle` with a
`state-stale-demoted` timeline event. Hook-held agents (`hookHeldUntil`) are exempt while held.
Demotion drains the mailbox — the sealed-inbox death disappears even when detection is wrong.
*Kills R4's lethal half.*

**C2. Hooks for Pi/OMP if the harness supports them.**
Investigate Pi's settings surface (`~/.pi/`) for lifecycle hooks/notify equivalents; OMP is a Pi
fork and should inherit. If they exist, add installers in `agentHooks.ts` (same idempotent,
never-clobber rules). If not, C1 is the safety net and cadence remains the signal.

**C3. Long `awaiting-input` warns the humans and the peers.**
`awaiting-input` stable > 10 min with queued mail → one notice to each sender ("X is blocked on a
permission prompt; your message is parked") and the existing app toast. No auto-answering.

## Phase D — Prove it (the part that has caught every regression so far)

Extend `.plano-tests/mesh-cli-e2e.mjs`:
- **C11 — auto-queue:** send (no flag) to a busy peer → `status: queued`, delivered on idle,
  sender receives the delivered notice.
- **C12 — expiry notice:** queue to a peer pinned busy past a shrunken test TTL → sender's inbox
  carries the expiry notice; nothing lost silently.
- **C13 — watch:** `send --queue` then `plano watch <id>` resolves with `delivered, confirmed`.
- **C14 — stale demotion:** fake a hookless `working` wedge (spam repaints, no workers) → agent
  demotes ≤ `STALE_WORKING_MS`, queued mail drains.
- **C15 — saturation drill:** orchestrator + 3 scripted echo-agents exchange 20 messages in both
  directions under deliberate mid-turn collisions; assert **zero** expired/undeliverable and every
  sender saw every outcome.

Ship gate: e2e C1–C15 green, `npm run typecheck` clean, then the usual dist → install → publish.

## Explicit non-goals

- No transport change (no sockets between agents): typing into the PTY stays the delivery, because
  it is what the harness actually reads, and the screen emulator (0.2.18) made reads truthful.
- No auto-answering of permission prompts; `awaiting-input` remains a human boundary.
- No new consent model — closing/sending/spawning keep the F8 workspace gate.

## File map

| File | Changes |
|------|---------|
| `src/main/daemon/mesh/bus.ts` | A1 auto-queue · A2 `notifySender` + call sites · A3 TTL credit · A4 size/ask parity · B1 watch waiters · B2 drain anchor · B3 roster pending · C1 sweep hooks |
| `src/main/daemon/mesh/endpoint.ts` | `plano_watch` |
| `src/main/daemon/cli/commands.ts` + `spec.ts` | `watch`, `--direct`, `--watch`, roster column, new formatters |
| `src/main/daemon/index.ts` | C1 screen-hash + worker signal into the sweep · C2 hook install call |
| `src/main/daemon/agentHooks.ts` | C2 pi/omp installers (if supported) |
| `src/main/daemon/mesh/provision.ts` | SKILL/BRIEF: auto-queue semantics, `watch`, notices ("system mail from `plano` is an outcome report — read it, don't re-send blindly") |
| `.plano-tests/mesh-cli-e2e.mjs` | C11–C15 |
