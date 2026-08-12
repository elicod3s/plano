# PLANO — Architecture

Status: foundation. This document is the source of truth for *how the app is wired*; the visual language lives in [`DESIGN_SYSTEM.md`](../design/DESIGN_SYSTEM.md).

## Process model

```
┌─ renderer (Chromium, sandboxed) ─┐     ┌─ preload ─┐     ┌─ main (Node, privileged) ─────────────┐
│ React + infinite canvas          │     │ window.   │     │ services + IPC handlers               │
│ zustand stores (viewport/panels) │◀───▶│ plano     │◀───▶│ PtyManager, AgentDetectionService,    │
│ panels: terminal/editor/browser… │ IPC │ (frozen,  │ IPC │ ProcessTree, Workspace, FS, Git,      │
│ NO node/electron imports         │     │  typed)   │     │ Browser(WCV), Security, Update         │
└──────────────────────────────────┘     └───────────┘     └───────────────────────────────────────┘
```

- **`src/shared`** — types + IPC contracts imported by both sides. Zero runtime deps, zero node/electron/dom imports.
- **`src/main`** — owns all privilege: PTYs, process inspection, filesystem, git, persistence, window/security.
- **`src/preload`** — the *only* bridge. `contextBridge.exposeInMainWorld('plano', api)`; thin invoke/on wrappers, no logic.
- **`src/renderer`** — UI only. Talks to main exclusively through `window.plano`.

## Why Electron (not Tauri)

The deciding constraint is **live browser panels on a pan/zoom canvas**. Electron's `<webview>` is a real DOM element: it inherits the canvas CSS `transform`, `border-radius` clip and z-order for free. Tauri's native webviews are OS overlays that can't be CSS-transformed or clipped to rounded panels. node-pty + xterm.js (Microsoft-maintained, used by VS Code) is also the mature terminal stack and lets us inspect PTY streams + process trees in plain Node. Tauri's smaller binary doesn't address PLANO's hard requirement.

Mitigations for Electron's known costs: a swappable `BrowserPanel` strategy (`<webview>` default, `WebContentsView` fallback), viewport culling for many panels, and isolated session partitions + zod-validated IPC for security.

## Signature feature — terminal agent detection

A terminal panel auto-detects when an AI coding CLI runs inside it and morphs to *agent mode* (motion + weight, never hue). Two fused signals:

1. **Process tree (primary, authoritative).** One shared process snapshot (`ProcessSnapshotProvider`, TTL ~1.2s) is reused by every terminal — 1 or 30 terminals cost the same enumeration. Each detector walks the **descendants** of its own shell PID (the PID node-pty gives us) and matches name **and** command line against a signature table. Descendants matter: on Windows `claude` is an npm shim that runs the agent as a grandchild (`node …\@anthropic-ai\claude-code\cli.js` or `claude.exe`).
   - Windows: `Get-CimInstance Win32_Process` (only reliable source of `ParentProcessId` + `CommandLine`; `wmic` is deprecated). Optional native fast-path: `@vscode/windows-process-tree`.
   - POSIX: `ps-list` (includes `cmd`) or `/proc` directly.
2. **Output sniff (secondary, instant hint).** Tap the PTY data we already stream to xterm; keep a ~4KB rolling tail; match known banners. Raises confidence / triggers an out-of-band poll, but never confirms alone.

**Fusion + hysteresis:** quick to ENTER (process match ≥0.8 enters on first hit), sticky to LEAVE (matched PID gone + ~2.5s grace) so a brief subprocess (agent shelling out to `git`) doesn't flap the chrome. Emit to renderer **only on a changed verdict**. Idle/off-screen terminals pause polling. A manual per-terminal override always wins.

See `src/main/services/AgentDetectionService.ts`.

## Persistence

Per-workspace, on-disk, co-located with the project: `<projectFolder>/.plano/workspace.json` (pretty JSON, `schemaVersion`, atomic temp+rename writes, zod-validated on read, ordered migrations with a pre-migration backup). Runtime-only data (live ptyId/pid, webview ids) is **not** persisted — terminals re-spawn, browsers re-navigate to the saved URL. App-global state (recent workspaces, window bounds) is separate via electron-store.

## Security (non-negotiable)

`contextIsolation`+`sandbox`+ no node integration on the renderer; preload exposes a single frozen namespace. Embedded browsers: `will-attach-webview` strips nodeIntegration / forces sandbox, isolated session partition, denied permissions by default, `setWindowOpenHandler` → new browser panel, navigation guards on the app frame, strict CSP. Every IPC payload zod-validated in main before any service call.

## IPC convention

Channel names live in `src/shared/ipc/channels.ts`. Request/response shapes in `contracts.ts`. `renderer→main` uses `invoke` (request/response) or `send` (fire-and-forget); `main→renderer` uses events. Results are wrapped so errors propagate as typed values, not thrown strings.

## Agent Mesh (daemon-owned orchestration, CLI-first)

The Agent Mesh is PLANO's provider-neutral answer to multi-agent coordination: any CLI agent
(Claude Code, Codex, Gemini CLI, OpenCode, Cursor, …) running in any terminal can discover,
message, spawn and wait on the others — regardless of vendor.

- **Ownership lives in the detached Agent Host daemon** (`src/main/daemon/`), not the app or the
  renderer. The daemon owns the roster, durable mailboxes, the message timeline, agent
  relations ("links"), chained tasks and the ask/reply correlations, and it survives app
  closes (agents keep working with their mesh intact). The app and renderer only mirror it.
- **Identity per terminal**: every PTY the daemon spawns gets its own `PLANO_AGENT_ID` +
  HMAC-derived `PLANO_MESH_TOKEN` + `PLANO_WORKSPACE` env (see `mesh/identity.ts`). Tokens are
  live only while the session lives; nothing is fabricatable, nothing is shared between agents.
- **Every harness is told about the mesh at boot** (`installAgentDocs`, the CLI-first
  replacement for the MCP config entry that used to make agents mesh-aware automatically):
  Claude Code and Kiro get the full skill (`<home>/.claude|.kiro/skills/plano-mesh/SKILL.md`),
  Codex/Gemini/OpenCode/Cursor/Pi get a short briefing merged into their own global
  instructions file (`~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md`,
  `~/.config/opencode/AGENTS.md`, `~/.cursor/AGENTS.md`, `~/.pi/AGENTS.md`) between
  `BEGIN/END PLANO MESH` markers — replaced in place on every boot, user content preserved,
  removed again by `deprovision()`. A harness is provisioned only if its config dir already
  exists; PLANO never creates one for a tool the user does not have.
- **CLI-first surface** (`plano`, installed into `<userData>/bin` at daemon boot and injected
  into every agent's PATH by `cleanEnv` — which takes the userData dir from
  `setUserDataDir()`, since the app passes it as an argv flag and never exports
  `PLANO_USER_DATA_DIR`, and writes it to the env map's EXISTING path key, because
  `Path` vs `PATH` in one map means the child keeps only one of them): agents orchestrate by
  running commands — `plano roster`, `plano
  send <to> <text>`, `plano ask <to> <text>`, **`plano wait <agentId>`** (block until the
  target finishes its turn or exits — the "send the plan, then wait for it" primitive),
  `plano spawn <harness> [folder] [--prompt …] [--wait]` (creates new agents in the SAME
  canvas, placed next to the requester's panel), `plano claim`/`plano handoff`,
  `plano chain`/`plano chains`/`plano cancel-chain`, `plano inbox`/`plano ack`, `plano
  broadcast`, `plano context`, `plano timeline`, `plano find`/`plano declare`, `plano
  set-model`/`plano interrupt`/`plano compact`, `plano worktree create` (Orca-style alias),
  `plano agent-context` (machine-readable command schema). The CLI source is
  `src/main/daemon/cli/`, bundled to `out/main/cli.js` and copied into `<userData>/bin` by
  `installCli`; the launchers run it under `ELECTRON_RUN_AS_NODE` (no system Node required).
- **Protocol**: the CLI speaks plain JSON-RPC 2.0 over POST `/cli` (loopback only) to the
  daemon's mesh endpoint (`src/main/daemon/mesh/endpoint.ts`), authenticated by
  `Authorization: Bearer <PLANO_MESH_TOKEN>`. `plano_wait`/`plano_ask` are server-side
  long-polls (the daemon resolves them on state transitions; the web server disables its
  request timeout so waits can run for minutes). **A wait always answers**: a peer that already
  finished returns its transcript with `alreadyIdle` (`--next-turn` waits for the next turn
  instead), a peer stuck on a permission prompt returns `blocked` once it is stable for 8 s, and
  a timeout still returns the output so far with exit code 2 — the two "no transition is ever
  coming" cases used to burn the whole timeout on keepalives. The `/mesh` path stays mounted as a compat
  alias so terminals spawned by older daemons keep working. **There is no MCP server
  anymore**: the old MCP framing (`initialize → tools/list → tools/call`), the `plano mcp`
  stdio mode and the per-harness MCP config provisioning were removed (plan v5 A1); boot-time
  `cleanupMcpEntries()` strips stale `plano` MCP keys from harness configs left by previous
  versions. The Claude Code skill (`~/.claude/skills/plano-mesh/SKILL.md`) teaches the CLI
  surface; `provision.ts` is the provisioning module, `deprovision()` (uninstaller) restores
  configs.
- **Spawn semantics** (plan F6): `plano spawn` opens fresh PTYs booting the requested harness
  in the requester's workspace (same canvas — panels materialize beside the caller's panel),
  returns the exact ptyIds, and optionally delivers a prompt once each harness is up. The
  daemon records the instant it types that prompt, plus the transcript at that instant; the
  first `plano_wait` on the newborn adopts both, so `spawn --prompt --wait` reports the turn
  its own prompt triggered even when the agent answers before the wait arrives. Under `--json`
  the wait results are folded into the spawn document (`wait` = first agent, `waits` = all) —
  one parseable object, never a concatenation.
- **Redaction**: any context leaving the mesh (tails, `plano context`) is redacted centrally by
  `AgentContextService`/`contextRedaction` before it ever reaches another agent.
