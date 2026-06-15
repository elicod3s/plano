# PLANO — Architecture

Status: foundation. This document is the source of truth for *how the app is wired*; the visual language lives in [`DESIGN_SYSTEM.md`](DESIGN_SYSTEM.md).

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
