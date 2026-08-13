# STATUS — what is still wrong with the agents

**Date:** 2026-08-13 · **Branch:** `mac-build-odla` · Written from real session evidence, not from
intent. Anything marked *unverified* has NOT been proven working, whatever the commit message says.

---

## 1. Still broken

### 1.1 `plano wait` burns its whole budget on keepalives

```
$ plano wait 447c04e7 --json
[Command cancelled]
{"_keepalive":true}
{"_keepalive":true}
{"_keepalive":true}
[Timeout: 300s]
```

A freshly spawned agent that is still booting never reaches the "stably idle" transition `wait`
looks for, so the caller sits for the entire timeout and learns nothing. The keepalives prove the
daemon is alive; they say nothing about the peer.

**Why it is not just a timeout value.** `wait` answers three questions with one primitive — "did
the turn end", "is it alive", "is it stuck" — and a booting agent is none of those. It needs a
`booting` outcome that returns as soon as it is known, the same way `blocked` already does for a
permission prompt.

### 1.2 A booting agent is a blind spot in the whole model

Real evidence from the spawned OMP worker:

```
MCP finished with failures. Failed: qwen-mm-plugins-omni-av, ida-free, magic, vercel,
higgsfield, nexlev, burp, lovable  ·  HTTP 401 / Not authenticated / Transport closed
```

That startup takes minutes. During it the harness is `unknown`, there is no composer, and every
mesh operation degrades: `send` queues, `ask` waits, `wait` keepalives, `status` shows nothing
useful. The mesh has states for *working*, *idle*, *awaiting-input* and *exited* — but none for
**booting**, which is exactly the window where a coordinator most needs to be told "not yet, ask me
in a minute".

### 1.3 `exited` cannot tell "finished" from "died"

From the multi-agent field report:

> DataCore: `exited` at 79 s without writing a single file. Rule of thumb became *"verify artifacts
> on disk, don't trust the state"*.

`wait`/`status` return `exited` for a worker that completed its job and for one that crashed on
boot. The exit code, how long it ran, and whether it produced any output are all known to the
daemon and none of them are reported.

### 1.4 A dead agent leaves no body

Once a session dies it is purged from the roster, so `plano status <id>` and `plano context <id>`
answer `not-found`. There is no post-mortem: you cannot read what a worker did before it died, so
the practical rule becomes "respawn is cheaper than diagnosing" — which is how the same failure
repeats all afternoon.

### 1.5 Harness identity is sometimes wrong

An agent launched as **OMP reports `kind: codex`** (detection sees the inner process it runs).
`canSpawn: false` is likewise reported for agents that spawn perfectly well through the CLI. Both
are cosmetic until a coordinator routes work by capability — then they are lies.

---

## 2. Fixed today, NOT yet verified live

These are code changes with a clean typecheck and build, and no end-to-end proof with real agents.
Treat them as claims until the next real session.

| Fix | What it addressed | Proof status |
|---|---|---|
| `plano.exe` compiled on the machine | Rust harnesses refuse `.cmd` (BatBadBut), so `plano spawn` failed 4/4 with `batch file arguments are invalid` | **Proven**: a real OMP agent ran `plano spawn omp . --json` and it returned `ok: true` |
| `ask` no longer fabricates a reply on timeout | It returned the transcript delta as `reply`, handing back MCP boot errors as the answer to "hola" | Unverified |
| `ask` answers immediately when the peer cannot receive | It blocked ~180 s on keepalives against a booting agent | Unverified |
| Spawn prompt parked in the mailbox | `send` refuses an `unknown` harness, so the prompt was dropped with only a log line and the newborn never greeted anyone | Unverified |
| Composer-live outranks `busy` | A mid-turn agent with a live input box now receives immediately instead of waiting for idle | Unverified |
| `plano help` no longer crashes | Odd-length flat array → `undefined.padEnd`; `watch`/`close` were also invisible | Proven |
| Spawn folder resolved | `plano spawn omp animal-cases` put the worker in `C:\Users\<name>` instead of the folder | Unverified |
| Fan-out React crash (#300) | A hook called inside a click handler took the whole renderer down | Proven present in the shipped 0.2.22 bundle; fix unverified live |

**None of this is published.** The version users run (0.2.22) still contains the fan-out crash and
none of the fixes above.

---

## 3. Verification debt (the honest part)

- The mesh e2e (`C1–C17`) was last run **green twice by the agent that wrote the guarded-send
  work** — *before* my v7 orchestration, the readiness change, the ask changes and the spawn-prompt
  change. **I have not run it since.** Every "fixed" row above rests on typecheck plus reasoning.
- The v7 orchestration was proven with **plain shells driving the CLI**, not with real agents
  answering: Run → Task → dependent Task → dispatch → `worker-done` → the DAG unblocking is real
  and observed. What is NOT observed is a real harness reading the injected contract and choosing
  to call `plano worker-done` on its own.

---

## 4. v7 orchestration: what exists and what does not

**Working (observed):** `run-create`, `task-create --deps`, `task-list`, `dispatch` (with the
contract preamble, and tracking-only for a bare shell), `worker-done --outcome`, `check` with
delivery batches that replay until `--ack`, `check --wait --types` as a rolling long-poll, the
three-failure circuit breaker, DAG readiness derived from dependencies.

**Missing:**

- `worker-start` — one command composing spawn + readiness wait + dispatch, with a receipt saying
  what was created vs reused. Today a coordinator does those three steps by hand.
- Post-completion lifecycle: `worker-release` / `worker-retain` / `worker-stop` / `worker-abandon`,
  and `--retry-of` as a first-class retry.
- Decision gates (`gate-create` / `gate-resolve`) for coordinator choices inside the DAG.
- Tombstones and a `booting` state (see 1.2–1.4).
- e2e cases C18–C24, including the saturation drill: one coordinator, five workers, a two-level
  DAG, deliberate mid-turn collisions and one worker killed on purpose, asserting zero lost
  messages and no polling.

---

## 5. Terminal rendering (adjacent, mostly solved)

Fixed and **measured** by a dedicated agent: crooked text was LCD subpixel antialiasing plus a cell
pitch floored to 7 px when the real advance was 7.8 px. Colour fringing 55–78 % → **0 %**, pitch
deficit 0.80 px → **0.01 px**. The selection never moved the glyphs — its light background simply
washed the fringing out, which is why highlighting "fixed" it.

Left open by that work, in its own words:

- Fractional canvas zoom is still soft: `snapRenderScale()` has been pinned to 1.0 since the first
  version, so at 125 % the bitmap is rescaled.
- `Ctrl +/−` can collapse a step: 13 px and 14 px land on the same grid.
- `lineHeight` is inconsistent between the constructor (`max(1.4, …)`) and `applyTerminalOptions`
  (`max(1, …)`).

---

## 6. What I would do next, in order

1. **Run the e2e.** Everything in §2 is unproven and some of it touches the delivery path.
2. **Give the mesh a `booting` state** and make `wait` return it immediately (fixes 1.1 and 1.2 in
   one move).
3. **Tombstones + an honest `exited`** (1.3, 1.4) — this is what turns "respawn blindly" back into
   "diagnose".
4. **Publish**, because the crash in §2 is live for every user on 0.2.22.
5. Then the rest of v7 (`worker-start`, lifecycle, gates) and the saturation drill.
