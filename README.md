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

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and [`docs/DESIGN_SYSTEM.md`](docs/DESIGN_SYSTEM.md) for the full specification.

## Security posture

`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`. The renderer is treated as untrusted: every IPC payload is zod-validated in main; embedded web content runs in an isolated session partition with denied permissions by default. See the SecurityService section in the architecture doc.
