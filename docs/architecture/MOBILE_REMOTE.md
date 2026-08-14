# PLANO Mobile & Remote — architecture, flow, and how to ship changes

> Living document: describes EXACTLY how the persistent-terminals (detached-host) system works,
> the mobile web app, remote access and — most importantly — **how to package, install and ship
> a change in minutes without breaking anything**. Read it completely before touching these
> modules, and update it when something changes.

---

## 1. The mental model (3 processes)

```
PHONE (web app PWA)          PC — PLANO
┌──────────────────┐           ┌───────────────────────────────────────┐
│ mobile browser   │           │  PLANO.exe (Electron)                 │
│ (web-dist)       │           │  ├─ renderer (canvas, UI)             │
│                   │  HTTP+WS  │  ├─ main (services, IPC, detection)  │
│  ⇄── LAN/remote ──┼──────────┼─►└─ daemon "Agent Host" (DETACHED     │
└──────────────────┘   token/   │     child, ELECTRON_RUN_AS_NODE=1,   │
                       subnet   │     survives app close)               │
                                │        └─ real owner of ALL PTYs/    │
                                │           agents                     │
                                └───────────────────────────────────────┘
```

- **The daemon owns the terminals** (not the UI). Close PLANO → the daemon stays alive with your
  agents running (the agents-never-close feature). Reopen → it reconnects and re-attaches the same
  sessions (same PID, scrollback intact, no `--resume`).
- **The phone talks to the daemon** (not the UI): view/create/talk to/kill agents, live terminal
  via xterm, even with PLANO closed.

---

## 2. Key files

### Daemon (main, compiled to `out/main/daemon.js`, runs as `ELECTRON_RUN_AS_NODE=1`)
| File | Role |
|---|---|
| `src/main/daemon/index.ts` | Daemon process: TCP server (JSON line protocol, token), PTY sessions, buffering (512KB ring), lightweight agent detection, web server startup, mDNS, fixed port 56780, pending panels |
| `src/main/daemon/ptySpawn.ts` | Shell spawn logic (clean env, PowerShell init, cmd /k fast-boot, ConPTY→WinPTY fallback) — shared |
| `src/main/daemon/agentLight.ts` | Lightweight agent detection (signature table + process tree) while PLANO is closed |
| `src/main/daemon/webServer.ts` | HTTP+WebSocket server on 0.0.0.0: serves the static web app, REST API, live WS, auth by token **or same subnet** |
| `src/main/daemon/pendingPanels.ts` | Terminals created from the phone while PLANO was closed → materialized on open |

### main ↔ daemon bridge
| File | Role |
|---|---|
| `src/main/services/AgentHostClient.ts` | Daemon client: spawn/connect, RPC request/response, handles daemon→app requests (`getWorkspaces`, `resolveSpace`), events (`external-terminal`, `session-removed`) |
| `src/main/services/PtyManager.ts` | Facade for the renderer: create/attach/kill via daemon + detection/history/devUrls/context re-registration; `restoreSessions(kept)` (union with pending ids); `registerExternalSession`; `shutdown(keepAgents)` |
| `src/main/index.ts` | Wiring: passes `--webRoot`, connects `onHostRequest`, `onExternalTerminal` → renderer, `will-quit` → `pty.shutdown(keepAgents)` |

### Renderer (PC)
| File | Role |
|---|---|
| `src/renderer/app/terminalRestore.ts` | Seeds `useTerminalStore` with the daemon's live sessions BEFORE mounting panels (reattach instead of respawn) |
| `src/renderer/app/externalTerminals.ts` | Materializes terminals created from the phone: 2-column grid from the viewport center, toast, and `removeExternalTerminal` on close |
| `src/renderer/app/terminalSessions.ts` | `reconcileTerminalSessions(protectedIds)` — does not kill the phone's pending sessions |
| `src/renderer/chrome/MobileChip.tsx` | Badge in the TopBar: grey "Mobile" → green "Phone" when a phone connects; click opens Settings → Mobile |
| `src/renderer/chrome/Toasts.tsx` + `stores/useToastStore.ts` | Floating toasts ("Created X from your phone") |
| `src/renderer/chrome/settings/sections.tsx` | **Mobile & Remote** section: QR with real IP + URL + token + keep-agents toggle |

### Mobile web app (`web/`, Vite+React; builds to `web-dist/` → packaged as `resources/web`)
| File | Role |
|---|---|
| `web/src/App.tsx` | Bootstrap: auto-connect by URL token / saved connection / **same-origin without token** |
| `web/src/screens/Connect.tsx` | Connection screen: prefills `plano.local:56780`, probes `/api/ping`, optional token stored locally |
| `web/src/screens/Home.tsx` | Live lists of agents/terminals/workspaces + ✕ delete button |
| `web/src/screens/AgentDetail.tsx` / `Terminal.tsx` | REAL agent terminal (xterm) + arrow bar |
| `web/src/components/LiveTerminal.tsx` | xterm.js with attach/detach to daemon, buffer replay, resize |
| `web/src/components/TerminalToolbar.tsx` | Only 4 arrows (←↑↓→) that send ANSI sequences WITHOUT touching keyboard focus |
| `web/src/components/BrandMark.tsx` | The real PLANO logo (same SVG as the desktop) |
| `web/src/lib/api.ts` / `ws.ts` / `store.ts` | REST client (8s timeout) + WebSocket channel with reconnection + mini store |

### Shared IPC
`src/shared/ipc/channels.ts`, `contracts.ts`, `src/preload/index.ts` — new channels:
`terminal:restore`, `terminal:pendingPanels`, `terminal:externalCreated`, `terminal:sessionRemoved`, `app:getRemoteInfo`.

---

## 3. Main flows

### 3.1 Agents that never close (detached host)
1. PLANO starts → `AgentHostClient` spawns the daemon (detached, `unref`) or connects to the existing one.
2. The renderer, BEFORE mounting panels: `materializePendingPanels` (fetch pending) →
   `restoreSurvivingTerminals(keptIds ∪ pending)` → `restoreWorkspaces` → materialize pending.
3. A surviving terminal has its ptyId in `byPanel` → `TerminalEngine.getOrCreate` →
   `reattachPty` → `terminal.attach(ptyId)` → the daemon returns the buffer and resumes the stream.
4. Close PLANO (`window-all-closed` → `will-quit`) → `pty.shutdown(keepAgentsOnQuit)`:
   - `true` (default): `host.disconnect()` — the daemon marks sessions detached and keeps buffering.
   - `false`: `host.shutdownSync()` (socket write + `taskkill /F /T` of the daemon pid).

### 3.2 The phone creates/talks to/deletes
1. Phone → `POST /api/sessions` (or WS) → the daemon spawns the session.
2. PLANO open? → broadcast `external-terminal` → renderer materializes the panel (2-col grid,
   viewport center, toast). Closed? → `pending-panels.json` → materializes on next startup.
3. Talk: `WS write` / `POST write` → the daemon writes to the PTY → output reaches the PC AND the
   phone (same live session, real-time bidirectional).
4. Delete: ✕ in the list → `kill` → the daemon removes the session + broadcasts `session-removed` →
   the renderer removes the panel from the canvas.

### 3.3 Auth
- Same subnet (the remote IP shares a subnet with the PC's real interfaces) → **no token**.
- Anything else (internet, tunnel) → token required (`?token=` or `Authorization: Bearer`).
- `/api/ping` always open (probe for the connection screen).

---

## 4. HOW TO SHIP A CHANGE (the exact flow, error-free)

> The machine has no VS Build Tools: **`npmRebuild=false` is MANDATORY** in electron-builder.

```bash
# 1) Mobile web app changes:
cd web && npm run typecheck && npm run build        # → web-dist/

# 2) PC daemon/main/renderer changes:
cd .. && npm run typecheck                          # both projects
npm run build                                       # electron-vite → out/

# 3) Package (ALWAYS with --config.npmRebuild=false):
npx electron-builder --dir --win --config.npmRebuild=false   # → release/win-unpacked

# 4) Install (replaces the running app):
powershell -Command "Get-Process PLANO -ErrorAction SilentlyContinue | Stop-Process -Force"
sleep 3
rm -rf "$LOCALAPPDATA/Programs/PLANO"
cp -rf release/win-unpacked "$LOCALAPPDATA/Programs/PLANO"

# 5) Launch:
"$LOCALAPPDATA/Programs/PLANO/PLANO.exe" &
```

**Test ports to avoid collisions:** use fresh high CDP ports (9505+, 96xx+, 97xx+).
**Always kill zombie processes** (`Get-Process PLANO,electron,chrome | Stop-Process -Force`)
because a port held by a leftover makes E2E fail with "timeout: cdp".

### Test suite (scripts in `scripts/`)
| Script | What it tests |
|---|---|
| `agent-host-test.mjs` | Pure daemon: detached spawn, session survives disconnect, reattach, buffer, kill, shutdown |
| `daemon-web-test.mjs` | Web server: static, auth (token/no token), REST create/write/buffer/kill, WS events |
| `plano-e2e.mjs` | Full app: spawn → quit → shell survives → relaunch → same session/pid → stream → kill |
| `plano-mobile-e2e.mjs` | Phone: create with app open (materializes), write (visible on PC), create with app closed (pending→relaunch) |
| `plano-pwa-ui-test.mjs` | The PWA in headless Chrome (`--headless=old`): connect, see agents, message, create from UI |
| `plano-agent-e2e.mjs` | REAL Claude Code: survives quit, re-detected on relaunch, write reaches the same session |

Run one: `node scripts/plano-e2e.mjs "D:\Tools\Plano\release\win-unpacked\PLANO.exe" <tempUserData> <port>` (or with the dev electron).

---

## 5. Gotchas / decisions made (don't revert without understanding)

- **`npm install` can PRUNE deps not in package.json** (happened with express/
  @modelcontextprotocol and @types/express — reinstall with `--save`/`--save-dev`).
- **`asar extract-file package.json` OVERWRITES the repo's package.json** — use `-d` to a tmp dir.
- **Fixed web port 56780** (+ random fallback). The Settings QR/URL uses the real one. `WebServer.listen`
  must REJECT on EADDRINUSE (otherwise the daemon hangs without writing the host file).
- **mDNS `plano.local`** announced with bonjour-service. Works on iOS/Safari; NOT on Android/Chrome
  (the QR with the literal IP is the universal path).
- **QR IP filter**: excludes VPN/loopback/APIPA (NordLynx 10.5.0.2 broke the QR — the first OS
  adapter isn't the real LAN). Prioritizes Ethernet/Wi-Fi.
- **The daemon needs `--webRoot`** (dev: `web-dist`, packaged: `resources/web`).
- **`attached` is a viewer COUNTER** (desktop + phone). The stream goes to sockets that attached
  to that ptyId (a phone on Home does NOT receive streams of all sessions).
- **The daemon's `request` frame carries `id`** — the client MUST check `event === 'request'`
  BEFORE the generic RPC-reply branch (otherwise it swallows the daemon's requests).
- **`reconcileTerminalSessions(protectedIds)`** — without this, the phone's pending sessions were
  killed as orphans at startup.
- **`height: 100dvh`** in the web app — without this the bottom bars fall below the screen on
  mobiles (browser URL bar).
- **The terminal container must be `display:flex; flex-direction:column`** — otherwise xterm
  overflows and the arrow bar overlaps the terminal.
- **The toolbar arrows must NOT `focus()`** — doing so opens/closes the phone's keyboard.
- **Desktop terminal window** (`src/main/windows/mainWindow.ts`): don't touch the layout.
- **Clean up test artifacts**: creating test sessions in the REAL userData creates
  local test workspaces/panels (named after the machine user / "FromPhone") — clean them by editing `%APPDATA%/PLANO/workspaces.json`
  with the app closed (autosave would overwrite the edit if the app is open).
- **`keepAgentsOnQuit`** (default true) — the setting that decides "close PLANO = kill everything"
  (false) vs "keep running" (true).

---

## 6. Roadmap of natural next steps

1. Phone notifications when an agent finishes (push/persistent WS).
2. "What my agents did" dashboard (timeline of prompts/outputs).
3. System tray on the PC with background agent status.
4. Tailscale as an alternative to the tunnel (more stable, requires the app on both devices).
