# PLAN AGENT_MESH_V5 — CLI-first mesh (MCP removed)

Status: implemented · Date: 2026-08-11 · Supersedes: the MCP transport of plans F1/F3

## Why

The mesh's agent-facing surface was an MCP server (`POST /mesh`, MCP framing:
initialize → tools/list → tools/call; plus the `plano mcp` stdio mode) auto-provisioned into
every harness's config (`.claude.json`, `.codex/config.toml`, `.gemini/settings.json`,
`.cursor/mcp.json`, `~/.config/opencode/opencode.json`). That worked but was the hard path:

- every harness needs an MCP client + a config entry + a skill; a config write at boot races
  across spawns; harnesses without MCP support were second-class citizens;
- agents could not BLOCK on another agent finishing a turn — no wait primitive, only
  ask/reply correlation and chain triggers;
- Orca's model is different: a thin CLI (`orca worktree create`, `orca terminal wait`, …)
  that any terminal can run, over a daemon-owned JSON-RPC socket.

## Change

1. **MCP surface removed.** `mesh/mcp.ts` deleted; the `/mesh` POST handler now serves the
   native protocol (kept as a compat alias so pre-upgrade terminals' `PLANO_MESH_URL` env
   keeps working). `plano mcp` stdio mode gone. `provision.ts` no longer writes MCP configs;
   boot-time `cleanupMcpEntries()` strips stale `plano` MCP keys left by previous versions
   (never restores backups — that stays the uninstaller's `deprovision()` job). The
   `stdio-direct.mjs` test (stdio proxy) was deleted; all mesh e2e tests were migrated from
   MCP framing to native method calls.

2. **Native endpoint** (`mesh/endpoint.ts`): plain JSON-RPC 2.0 — `{jsonrpc, id, method,
   params}` → `{jsonrpc, id, result}` where result IS the bus result object. Same
   bearer-token identity (PLANO_MESH_TOKEN), loopback-only, mounted at `/cli` (canonical)
   and `/mesh` (alias).

3. **The `plano` CLI is the orchestration surface** (`src/main/daemon/cli/`, bundled by
   electron-vite as `out/main/cli.js`, copied into `<userData>/bin` at daemon boot by
   `installCli`, launched by `plano.cmd`/`plano` via `ELECTRON_RUN_AS_NODE`). Commands cover
   the whole mesh: whoami, roster, status, inbox/ack, send, ask/reply/cancel, spawn
   (`--prompt`, `--count`, `--wait`), worktree create (alias), wait, claim, handoff, chain /
   chain-payload / chains / cancel-chain, broadcast, context, timeline, find, declare,
   set-model, interrupt, compact, agent-context (machine-readable schema for agents), help,
   version. `--json` for machine output; `PLANO_CLI_JSON=1` defaults it; exit code 2 = wait
   timed out.

4. **`plano wait` — the new primitive** (`MeshBus.waitForIdle`, v5 A1): a server-side
   long-poll that resolves when the target transitions into idle (held stable for
   `quietMs`, default 2000) or exits — an already-idle target waits for its NEXT turn, so
   "send the plan, then wait" cannot race the message; `awaiting-input` never counts as
   finished (chain rule v4 B3). Event-driven off `setState`/`unregisterAgent`, returns the
   output delta since the wait started (capped 64 KiB). The web server disables its request
   timeout so waits can run for minutes. `plano spawn --wait` waits on each exact ptyId the
   daemon returns (the spawn result now carries `ptyIds`), with a retry while a newborn has
   not been detected as an agent yet. Two rules keep the newborn case honest: the daemon
   anchors the first wait to the moment it typed the spawn prompt (timestamp + transcript
   baseline), so an agent that answers during the detect/land gap still returns its turn
   instead of an empty delta; and an "already finished before the wait arrived" resolution
   must itself have been quiet for `quietMs`, so a booting harness's paint gap cannot pass as
   a completed turn. Under `--json`, `spawn --wait` prints ONE document — the spawn result
   with `wait` (first agent) and `waits` (all) folded in.

5. **Visual feedback unchanged**: sends/asks/spawns/claims/chains emit the same bus events
   (pushEvent + touchLink) over the daemon→app TCP broadcast → IPC → `useMeshLinks`/
   `MeshLinkLayer` — the link lines, arrival highlights, pending counters and awaiting dots
   work identically whether the trigger was the UI, the phone, or the CLI.

## v5 A2 — the CLI actually reaching the agents (2026-08-12)

Shipping A1 left the mesh unusable in practice: agents reported `plano` as "not found", and the
ones that could find it did not know it existed. Three defects, all in the provisioning path:

1. **The CLI never got onto any agent's PATH in a real install.** `cleanEnv` injected
   `<userData>/bin` only when `PLANO_USER_DATA_DIR` was set in the environment — but
   `AgentHostClient.spawnDaemon` passes the path as the argv flag `--userData` and exports no
   such variable. Only the e2e (which does export it) ever saw the injection. The daemon now
   calls `setUserDataDir(userData)` at boot and `cleanEnv` uses that.
2. **The injection wrote to the wrong key when the env spelled it `PATH`.** The registry-refresh
   block used the env map's real path key, the CLI block hard-coded `Path`. Launched from any
   msys/git-bash context the map ended up with both, and the child kept the one without the CLI
   dir. Both blocks now share one canonical key.
3. **Only Claude Code was ever told the mesh exists.** Under MCP every harness learned about the
   mesh from its own config entry; removing MCP removed that for everyone but Claude (which kept
   its skill). `installAgentDocs()` now provisions every INSTALLED harness at daemon boot:
   the full `SKILL.md` for Claude Code and Kiro (same skills-folder convention), and a short
   briefing block merged into the global instructions file each other harness actually reads
   (`~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md`, `~/.config/opencode/AGENTS.md`,
   `~/.cursor/AGENTS.md`, `~/.pi/AGENTS.md`). The block sits between `BEGIN/END PLANO MESH`
   markers: idempotent, user content preserved, stripped again by `deprovision()`. A missing
   config dir means "not installed" — PLANO never creates one.

Probe: `.plano-tests/mesh-path-provision.mjs` boots the daemon exactly as the app does
(`--userData` flag, no env var, throwaway HOME) and asserts the CLI is installed, the bin dir is
on a real spawned shell's PATH, the shell itself resolves `plano`, and every harness got briefed
without losing its own content.

## v5 A3 — a wait always answers (2026-08-12)

Reported from a real session: *"`plano wait` se quedó colgado con keepalives y lo cancelé; la
respuesta ya estaba en el transcript."* Two silent hangs, both structural:

1. **The peer already finished.** With no anchor a wait targets the peer's NEXT turn, and a peer
   parked at its prompt never transitions again — so a bare `plano wait <id>` after the answer
   landed blocked for the whole timeout. It now returns immediately with the peer's transcript
   and `alreadyIdle` (+ `idleFor`); `--next-turn` restores the old semantics. An anchored wait
   (`send --wait`, the spawn-prompt anchor) is unaffected.
2. **The peer is blocked on a permission prompt.** `awaiting-input` never counts as finished
   (chain rule v4 B3), so the wait sat there although nobody was coming. It now resolves as
   `blocked` once the prompt is stable for 8 s — at call time OR mid-wait, and whether or not a
   transition follows (the "already blocked, no transition coming" case needed its own timer,
   exactly like the already-idle one).

Also: the default timeout drops 10 min → 5 min. Every outcome now carries an answer (finished /
alreadyIdle + transcript / blocked + prompt / timed out + output so far), so a long default only
kept callers on keepalives. Guidance in the skill and the per-harness briefing now says: prefer
`plano ask` (explicit `plano reply`, idle-inference as fallback) when you need an answer rather
than "the turn ended" — the same declare-completion model Orca uses for `worker_done`.

Probe: `.plano-tests/mesh-wait-robust.mjs` (~1 min, no model calls — a stub on the claude-code
module path gives the daemon a harness it really detects, so busy/awaiting-input transitions are
genuine): already-idle answers in ~100 ms, `--next-turn` still waits for a real turn, a blocked
peer answers in ~4 s.

## Files

- new: `src/main/daemon/mesh/endpoint.ts`, `src/main/daemon/cli/{index,commands,client,spec}.ts`
- deleted: `src/main/daemon/mesh/mcp.ts`, `.plano-tests/stdio-direct.mjs`
- changed: `mesh/bus.ts` (waitForIdle, spawn ptyIds), `mesh/cli.ts` (bundle install),
  `mesh/provision.ts` (cleanupMcpEntries + CLI-first skill), `mesh/identity.ts` (meshUrl → /cli),
  `daemon/index.ts`, `webServer.ts`, `electron.vite.config.ts` (cli entry),
  `docs/architecture/ARCHITECTURE.md` (Agent Mesh section)
