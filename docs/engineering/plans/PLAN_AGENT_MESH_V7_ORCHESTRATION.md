# PLAN — Agent Mesh v7: orchestration that never loses a worker

**Status:** proposed · **Owner:** mesh daemon (`src/main/daemon/mesh/*`) · **Predecessor:** `PLAN_AGENT_MESH_V6_RELIABLE_COMMS.md`

## Where we actually are

v6 + the guarded-send work completed the **transport** layer, and that part is verified
in code, not claimed:

| Capability | PLANO today |
|---|---|
| Readiness checked before writing | `agentReadiness()`; a permission prompt is a zero-byte boundary |
| Atomic delivery | bracketed paste, **gated on the PTY actually enabling DECSET ?2004** |
| Write receipt | `accepted` + `bytesWritten` from node-pty |
| Post-write proof | verifies the line left the composer |
| Real executable on PATH | `plano.exe` compiled on the machine |
| Outcome reporting to the sender | mailbox notices (delivered/expired/undeliverable/blocked) |

What is missing is everything **above** the wire. PLANO can carry a message between two agents; it
cannot yet run a *project* across five of them. Concretely, from the field report:

- `plano send` answering `ok: true` while `bytesWritten: 0` — correct, but the caller had no
  structured notion of "this task is now owned by that worker".
- `plano wait` returning `exited` for both "finished the job" and "died at boot with nothing
  written". The reporter's rule of thumb became *"verify artifacts on disk, don't trust the state"*.
- A dead agent purged from the roster, so `status`/`context` answer `not-found` and there is no
  post-mortem.
- Coordination invented by hand: `echo SENT-ENGINE` sentinels, roster polling to infer delivery,
  and a coordinator that could only guess who was still alive.

## The orchestration model

Three objects, and the separation between them is the whole design:

- **Run** — a durable namespace and the coordinator's inbox. *It never schedules or places workers.*
- **Task** — the work item. Carries `--deps` (a real DAG), `--parent`, and a status:
  `pending | ready | dispatched | completed | failed | blocked`.
- **Dispatch** — ONE attempt of one Task on one terminal. **Lifecycle authority lives here**, not in
  the terminal handle, which is "routing metadata rather than durable identity".

And the semantics that make it survive real sessions:

1. **Delivery batches with ack-replay.** `check` returns the oldest FIFO batch and *replays that
   exact batch* until `--ack <delivery_id>`. A message cannot be lost by a worker that crashed
   mid-processing.
2. **`check --wait --types worker_done,escalation,question`** — a rolling long-poll instead of
   sleep/poll loops. One wait covers every worker.
3. **A timeout is a checkpoint, not a failure.** In practice: *"Long coding tasks routinely run 15-60
   minutes; keep using rolling waits."* And: *"Heartbeats and visible terminal activity mean the
   worker is alive, not done."*
4. **`worker_done --outcome succeeded|failed`** with `--files-modified`. *"never encode failure only
   in prose."* A valid `worker_done` settles the Task AND the Dispatch automatically.
5. **Explicit post-completion lifecycle**: `worker-release` (cleanup, preserves output first),
   `worker-retain` (records a deliberate exception), `worker-stop`, `worker-abandon`, and
   `worker-start --retry-of <dispatch>`. Recovery is *conditional on proven state*, never a fixed
   destructive sequence.
6. **Circuit breaker**: three consecutive failures on one Task marks it failed instead of looping.
7. **Gates** (`gate-create`/`gate-resolve`) for coordinator DAG decisions — deliberately distinct
   from a worker's `ask`.
8. **`worker-read --source auto`** with a pinned cursor: the hook-reported transcript when the
   session can be proven, otherwise bounded terminal output carrying a typed `fallbackReason`.

## Design principles for PLANO's version

1. **Own the layer, don't clone the CLI.** Same guarantees, PLANO's vocabulary. Our transport is
   already stronger in places (auto-queue + sender notices); v7 builds on it rather than beside it.
2. **The daemon is the authority.** Runs/Tasks/Dispatches live in the daemon and persist to
   `<userData>/mesh/`, so orchestration survives the app closing — the invariant everything else
   here already honours.
3. **Nothing settles by inference.** A Task completes because a worker said so with an outcome, or
   because a human/coordinator overrode it. Never because a terminal went quiet.
4. **Every blocking call ends in an answer**, and a timeout is explicitly *not* a verdict.
5. **A dead worker leaves a body.** Post-mortem beats a clean roster.

---

## Phase A — the model (Run / Task / Dispatch)

**A1. Store.** New `src/main/daemon/mesh/orchestration.ts`: durable, atomic-write store for
`Run`, `Task`, `Dispatch`, mirroring `MailboxStore`'s temp+rename discipline.

```ts
interface Task { id; runId; spec; deps: string[]; parent?: string
                 status: 'pending'|'ready'|'dispatched'|'completed'|'failed'|'blocked'
                 result?: unknown; failures: number; createdAt; settledAt? }
interface Dispatch { id; taskId; runId; agentId; state: 'ready'|'settled'|'failed'|'stopped'|'unknown'
                     outcome?: 'succeeded'|'failed'; filesModified?: string[]
                     startedAt; settledAt?; retryOf?: string }
```

**A2. Readiness of a Task is derived, never stored twice**: `ready` ⇔ every dep is `completed`.
`task-list --ready` is the queue a coordinator pulls from.

**A3. Dispatch owns the lifecycle.** The agent id is routing; if the terminal dies, the Dispatch
becomes `unknown` and the Task returns to `ready` for a `--retry-of` attempt. Three consecutive
failed attempts on one Task → `failed` (the circuit breaker), so a broken spec cannot loop forever.

## Phase B — typed mail with ack-replay

**B1. Message types**: `status | dispatch | worker_done | escalation | question | heartbeat | gate`.
Today every mesh message is untyped prose; typing them is what lets a coordinator wait for the two
that matter and ignore the noise.

**B2. Delivery batches.** `plano check` returns the oldest unacked batch (cap 50) with a
`deliveryId`, and **replays the same batch** until `plano check --ack <deliveryId>`. Exactly-once
processing survives a worker that dies mid-batch — today an unprocessed message is simply gone once
typed.

**B3. Rolling wait.** `plano check --wait --types worker_done,escalation,question --timeout-ms N`.
One long-poll for the whole fleet, event-driven on the bus (the `waitForIdle` machinery already
proves the pattern). **A timeout returns `{ count: 0, checkpoint: true }`** — never an error, and
the CLI text says so in words, because the field report shows an agent reading a timeout as death.

**B4. Group addresses**: `@all`, `@idle`, `@<harness>`, `@workspace:<id>` for `status` fan-out.
Refused for lifecycle types — a `worker_done` addressed to a group is a bug, not a broadcast.

## Phase C — the supervised worker loop

**C1. `plano worker-start --task <id> [--harness <h>] [--folder <f>] [--agent <existing>]`**
composes what we already have — spawn (or reuse), wait for readiness, create the Dispatch, inject
the preamble — and returns a receipt naming what was **created vs reused**. This is the single
command that replaces "spawn, then hope, then poll the roster".

**C2. The injected preamble** teaches the worker its obligations in its own terminal: its `taskId`,
its `dispatchId`, and that it must end with
`plano send --type worker_done --outcome succeeded|failed --files-modified <paths>`. Provisioned
skills gain a short "if you were dispatched" section — the docs are the contract.

**C3. `plano worker-done`** (worker side) settles Task + Dispatch atomically and wakes every
coordinator waiting on that Run. `--outcome failed` is mandatory for failure: prose is not a status.

**C4. Post-completion lifecycle**: `worker-release` (close the terminal after preserving
its transcript), `worker-retain` (record a deliberate keep), `worker-stop`, `worker-abandon`. Never
release on a timeout, a heartbeat, or an idle TUI — only on a settled Dispatch.

**C5. Gates**: `plano gate-create --task <id> --question <q> --options a,b` /
`plano gate-resolve --id <g> --resolution <r>`, for coordinator decisions inside the DAG. Distinct
from `ask`, which stays worker→coordinator.

## Phase D — the post-mortem (a PLANO gap)

**D1. `exited` must say WHY.** `wait`/`status` return
`{ state: 'exited', exitCode, ranForMs, producedOutput: boolean, likely: 'finished'|'died-early' }`.
The reporter's own rule — *"exited ≠ success; validate the files"* — exists because we made a
terminal state carry two opposite meanings.

**D2. Tombstones.** A dead agent leaves a bounded record (last screen, exit code, last task,
timestamps) for `TOMBSTONE_TTL = 30 min`. `plano status`/`context` answer from it with
`{ dead: true }` instead of `not-found`, so "respawn is cheaper than diagnosing" stops being true.

**D3. `plano worker-read --dispatch <id> --cursor <c>`** — bounded incremental reads of a worker's
output with a pinned cursor, so a coordinator can follow progress without re-reading the screen or
inventing sentinels.

## Phase E — prove it under saturation

Extend `.plano-tests/mesh-cli-e2e.mjs` (currently C1–C17 green):

- **C18 DAG**: three Tasks, B and C depend on A. Assert only A is `ready` at first, and that B/C
  become ready exactly when A settles.
- **C19 ack-replay**: deliver a batch, do NOT ack, re-check → the identical batch returns; ack →
  it is gone. Kill the worker mid-batch and assert nothing was lost.
- **C20 worker_done**: `--outcome failed` settles Task+Dispatch as failed and wakes the waiting
  coordinator in under a second.
- **C21 circuit breaker**: three failed attempts on one Task → `failed`, no fourth dispatch.
- **C22 timeout ≠ failure**: `check --wait` past its budget returns `checkpoint: true` while the
  worker is provably still alive.
- **C23 post-mortem**: kill a worker mid-task → `status` answers from the tombstone with
  `died-early`, and the Task returns to `ready` for a retry.
- **C24 saturation**: one coordinator, five workers, a DAG with two levels, deliberate mid-turn
  collisions and one worker killed on purpose. Assert: zero lost messages, every Task settles or is
  explicitly `failed`, and the coordinator never sleeps/polls.

Ship gate: C1–C24 green **twice consecutively** (these failures are intermittent), `npm run
typecheck` clean, `npx electron-vite build` before every run.

## Explicit non-goals

- No scheduler: PLANO never decides placement or concurrency — agents choose, the
  daemon records and guarantees.
- No remote/multi-machine dispatch (a `--on <environment>` flag) — out of scope until PLANO has a
  second host to talk to.
- No replacement of the existing primitives: `send`, `ask`, `wait`, `watch`, `context` stay exactly
  as they are. v7 is the layer that uses them.

## File map

| File | Work |
|---|---|
| `src/main/daemon/mesh/orchestration.ts` | **new** — Run/Task/Dispatch store, DAG readiness, circuit breaker, tombstones |
| `src/main/daemon/mesh/bus.ts` | typed messages, Delivery batches + ack-replay, `check --wait`, group addresses, worker_done settlement |
| `src/main/daemon/mesh/endpoint.ts` | `plano_run_*`, `plano_task_*`, `plano_dispatch_*`, `plano_check`, `plano_worker_*`, `plano_gate_*` |
| `src/main/daemon/cli/commands.ts` + `spec.ts` | the commands above + formatters that state outcomes in words |
| `src/main/daemon/index.ts` | tombstones on session death, dispatch state on exit |
| `src/main/daemon/mesh/provision.ts` | SKILL/BRIEF: the dispatched-worker contract and the coordinator loop |
| `.plano-tests/mesh-cli-e2e.mjs` | C18–C24 |
