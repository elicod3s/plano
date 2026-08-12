# PLANO

**The infinite canvas workspace for builders.** One spatial screen per project — terminals, editors, browsers and AI agents, side by side on a pan/zoom canvas that remembers exactly how you left it.

> Desktop app (Electron). Dark, monochrome "Monolith Draft" design language. Terminals auto-detect when you're running an AI coding CLI (Claude Code, Codex, …) and morph into an *agent mode* — no color change, just motion and weight.

---

## Stack

| Layer | Tech |
|---|---|
| Runtime | Electron 33 + electron-vite |
| UI | React 18 + TypeScript + Tailwind CSS 3 |
| Canvas state | zustand + immer |
| Terminals | `@xterm/xterm` (WebGL) + `node-pty` (ConPTY on Windows) |
| Editor | CodeMirror 6 (lazy per-language) |
| Browser panels | Electron `<webview>` (DOM-transformable) with a `WebContentsView` fallback |
| Validation | zod (every IPC payload + on-disk schema) |

## Getting started

```bash
npm install
npm run rebuild   # build node-pty against Electron's ABI (run once after install / after Electron upgrades)
npm run dev       # launch PLANO with HMR
```

> **Windows:** `node-pty` needs the *Desktop development with C++* workload (VS Build Tools) if no prebuilt binary is available, and Windows 10 1809+ (ConPTY).

### Other scripts

| Script | Purpose |
|---|---|
| `npm run build` | Type-check-free production build into `out/` |
| `npm run typecheck` | Type-check main+preload and renderer projects |
| `npm run dist` | Build + package an installer with electron-builder |
| `npm run release:win` | Build the Windows installer **and publish it** as a GitHub release |

## Auto-updates (GitHub Releases)

Installed PLANO builds self-update from the **public** artifact repo
[`zqkra/plano-releases`](https://github.com/zqkra/plano-releases) (binaries only — source stays
private). On launch and every 4h the app checks the latest release, downloads the new installer
in the background (progress shown bottom-center), and installs on **Restart** or on quit. No
tokens needed on client machines because the repo is public.

Publishing a new version (this is the whole release flow):

```bash
npm run release:win                       # build installer + publish v<version> (uses your gh CLI)
node scripts/publish-release.mjs         # publish artifacts already in release/ (no rebuild)
node scripts/publish-release.mjs --platform mac   # publish macOS artifacts (dmg + zip + latest-mac.yml)
node scripts/publish-release.mjs --replace        # delete + re-publish an existing vX release
```

The release must be tagged `v<version>` (the script does this) and **not** a draft/prerelease —
electron-updater ignores those. Mac builds include a `zip` target because macOS updates need it.
`dist*` scripts build locally with `--publish never`; only `release*` uploads.

## Architecture (one screen)

```
renderer (Chromium, sandboxed)  ──window.plano──▶  preload (bridge)  ──IPC──▶  main (Node, privileged)
  React canvas + panels                 typed invoke/on            services: PtyManager, AgentDetection,
  zustand stores                        (contextBridge)            Workspace, FileSystem, Git, Browser…
```

- `src/shared` — types + IPC contracts shared by both sides. **Zero** node/electron/dom imports.
- `src/main` — privileged Node process. Owns PTYs, process inspection, FS, git, persistence.
- `src/preload` — the **only** bridge. Exposes a frozen, typed `window.plano`.
- `src/renderer` — the UI: infinite-canvas engine, one folder per panel type, app chrome, stores.

See the [`documentation index`](docs/README.md), [`architecture`](docs/architecture/ARCHITECTURE.md), and [`design system`](docs/design/DESIGN_SYSTEM.md) for the full specification.

## Security posture

`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`. The renderer is treated as untrusted: every IPC payload is zod-validated in main; embedded web content runs in an isolated session partition with denied permissions by default. See the SecurityService section in the architecture doc.

## Agent Mesh

PLANO's cross-workspace agent coordination: detect any AI coding CLI running in a terminal (Claude
Code, Codex, Gemini, Pi, Hermes, …), see them all from one overlay (`Ctrl+Shift+A`), send one
message to several at once, interrupt/focus any of them, keep a shared scratchpad + timeline, and
expose context to other tools over a local MCP bridge.

- **Context lives in the main process** — it keeps working even when a workspace is in the
  background and its terminals are hibernated.
- **Redaction is central** — tails, search, scratchpad and MCP all pass through one redactor
  (tokens/keys/passwords/PEM/credentials) before anything leaves the PTY stream.
- **MCP is local, token-authed and read-only by default** (loopback only; mutating tools opt-in).
- **Fan-out is isolated** — parallel writing agents each get their own git worktree + branch.

Privacy: nothing leaves your machine unless you enable it. Context persistence and the MCP bridge
are opt-in.
