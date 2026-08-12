# PLANO Mobile & Remote — arquitectura, flujo y cómo subir cambios

> Documento vivo: describe EXACTAMENTE cómo funciona el sistema de terminales persistentes
> (estilo herdr), la web app móvil, el acceso remoto y — lo más importante — **cómo empaquetar,
> instalar y subir un cambio en minutos sin romper nada**. Léelo completo antes de tocar estos
> módulos, y actualízalo cuando cambie algo.

---

## 1. El modelo mental (3 procesos)

```
CELULAR (web app PWA)          PC — PLANO
┌──────────────────┐           ┌───────────────────────────────────────┐
│ navegador móvil  │           │  PLANO.exe (Electron)                 │
│ (web-dist)       │           │  ├─ renderer (canvas, UI)             │
│                   │  HTTP+WS  │  ├─ main (services, IPC, detection)  │
│  ⇄── LAN/remoto ──┼──────────┼─►└─ daemon "Agent Host" (proceso      │
└──────────────────┘   token/   │     hijo DETACHED, ELECTRON_RUN_AS_  │
                       subred   │     NODE=1, sobrevive al cierre)     │
                                │        └─ dueño real de TODOS los    │
                                │           PTYs/agentes               │
                                └───────────────────────────────────────┘
```

- **El daemon es el dueño de los terminales** (no el UI). Cierra PLANO → el daemon sigue vivo
  con tus agentes corriendo (la feature herdr). Reabre → se reconecta y re-engancha las mismas
  sesiones (mismo PID, scrollback intacto, sin `--resume`).
- **El celular habla con el daemon** (no con el UI): ver/crear/hablar/matar agentes, terminal en
  vivo vía xterm, incluso con PLANO cerrado.

---

## 2. Archivos clave

### Daemon (main, compilado a `out/main/daemon.js`, corre como `ELECTRON_RUN_AS_NODE=1`)
| Archivo | Rol |
|---|---|
| `src/main/daemon/index.ts` | Proceso daemon: TCP server (protocolo JSON por líneas, token), sesiones PTY, buffering (anillo 512KB), detección ligera de agentes, arranque del web server, mDNS, puerto fijo 56780, pending panels |
| `src/main/daemon/ptySpawn.ts` | Lógica de spawn de shells (env limpio, PowerShell init, cmd /k fast-boot, ConPTY→WinPTY fallback) — compartida |
| `src/main/daemon/agentLight.ts` | Detección ligera de agentes (tabla de firmas + árbol de procesos) cuando PLANO está cerrado |
| `src/main/daemon/webServer.ts` | Servidor HTTP+WebSocket 0.0.0.0: sirve la web app estática, REST API, WS en vivo, auth por token **o misma subred** |
| `src/main/daemon/pendingPanels.ts` | Terminales creados desde el celular mientras PLANO estaba cerrado → se materializan al abrir |

### Puente main ↔ daemon
| Archivo | Rol |
|---|---|
| `src/main/services/AgentHostClient.ts` | Cliente del daemon: spawn/connect, RPC request/response, maneja peticiones daemon→app (`getWorkspaces`, `resolveSpace`), eventos (`external-terminal`, `session-removed`) |
| `src/main/services/PtyManager.ts` | Fachada para el renderer: create/attach/kill via daemon + re-registro de detección/historial/devUrls/contexto; `restoreSessions(kept)` (con union de pending ids); `registerExternalSession`; `shutdown(keepAgents)` |
| `src/main/index.ts` | Wiring: pasa `--webRoot`, conecta `onHostRequest`, `onExternalTerminal` → renderer, `will-quit` → `pty.shutdown(keepAgents)` |

### Renderer (PC)
| Archivo | Rol |
|---|---|
| `src/renderer/app/terminalRestore.ts` | Seed de `useTerminalStore` con sesiones vivas del daemon ANTES de montar paneles (reattach en vez de respawn) |
| `src/renderer/app/externalTerminals.ts` | Materializar terminales creados desde el celular: grid de 2 columnas desde el centro del viewport, toast, y `removeExternalTerminal` al cerrarse |
| `src/renderer/app/terminalSessions.ts` | `reconcileTerminalSessions(protectedIds)` — no mata sesiones pendientes del celular |
| `src/renderer/chrome/MobileChip.tsx` | Badge en la TopBar: gris "Mobile" → verde "Phone" cuando un celular conecta; clic abre Settings → Mobile |
| `src/renderer/chrome/Toasts.tsx` + `stores/useToastStore.ts` | Toasts flotantes ("Created X from your phone") |
| `src/renderer/chrome/settings/sections.tsx` | Sección **Mobile & Remote**: QR por IP real + URL + token + toggle keep-agents |

### Web app móvil (`web/`, Vite+React; se compila a `web-dist/` → se empaqueta como `resources/web`)
| Archivo | Rol |
|---|---|
| `web/src/App.tsx` | Bootstrap: auto-conectar por URL token / conexión guardada / **same-origin sin token** |
| `web/src/screens/Connect.tsx` | Pantalla de conexión: prefill `plano.local:56780`, sonda `/api/ping`, token opcional en local |
| `web/src/screens/Home.tsx` | Listas live de agentes/terminales/workspaces + botón ✕ eliminar |
| `web/src/screens/AgentDetail.tsx` / `Terminal.tsx` | Terminal REAL (xterm) del agente + barra de flechas |
| `web/src/components/LiveTerminal.tsx` | xterm.js con attach/detach al daemon, buffer replay, resize |
| `web/src/components/TerminalToolbar.tsx` | Solo 4 flechas (←↑↓→) que envían secuencias ANSI SIN tocar el foco del teclado |
| `web/src/components/BrandMark.tsx` | El logo real de PLANO (mismo SVG del desktop) |
| `web/src/lib/api.ts` / `ws.ts` / `store.ts` | Cliente REST (timeout 8s) + canal WebSocket con reconexión + mini store |

### IPC compartido
`src/shared/ipc/channels.ts`, `contracts.ts`, `src/preload/index.ts` — canales nuevos:
`terminal:restore`, `terminal:pendingPanels`, `terminal:externalCreated`, `terminal:sessionRemoved`, `app:getRemoteInfo`.

---

## 3. Flujos principales

### 3.1 Agentes que nunca se cierran (herdr)
1. PLANO arranca → `AgentHostClient` espawnea el daemon (detached, `unref`) o se conecta al existente.
2. El renderer, ANTES de montar paneles: `materializePendingPanels` (fetch de pendientes) →
   `restoreSurvivingTerminals(keptIds ∪ pending)` → `restoreWorkspaces` → materializar pendientes.
3. Un terminal que sobrevivió tiene su ptyId en `byPanel` → `TerminalEngine.getOrCreate` →
   `reattachPty` → `terminal.attach(ptyId)` → el daemon devuelve el buffer y reanuda el stream.
4. Cerrar PLANO (`window-all-closed` → `will-quit`) → `pty.shutdown(keepAgentsOnQuit)`:
   - `true` (default): `host.disconnect()` — el daemon marca sesiones detached y sigue buffereando.
   - `false`: `host.shutdownSync()` (socket write + `taskkill /F /T` del pid del daemon).

### 3.2 El celular crea/habla/elimina
1. Celular → `POST /api/sessions` (o WS) → el daemon espawnea la sesión.
2. ¿PLANO abierto? → broadcast `external-terminal` → renderer materializa el panel (grid 2 cols,
   centro del viewport, toast). ¿Cerrado? → `pending-panels.json` → materializa en el próximo arranque.
3. Hablar: `WS write` / `POST write` → el daemon escribe al PTY → el output llega al PC Y al celular
   (misma sesión viva, bidireccional en tiempo real).
4. Eliminar: ✕ en la lista → `kill` → el daemon borra la sesión + broadcast `session-removed` →
   el renderer quita el panel del canvas.

### 3.3 Auth
- Misma subred (la IP remota comparte subred con las interfaces reales del PC) → **sin token**.
- Cualquier otra cosa (internet, túnel) → token obligatorio (`?token=` o `Authorization: Bearer`).
- `/api/ping` siempre abierto (sonda de la pantalla de conexión).

---

## 4. CÓMO SUBIR UN CAMBIO (el flujo exacto, sin errores)

> La máquina no tiene VS Build Tools: **`npmRebuild=false` es OBLIGATORIO** en electron-builder.

```bash
# 1) Cambios en la web app móvil:
cd web && npm run typecheck && npm run build        # → web-dist/

# 2) Cambios en el daemon/main/renderer del PC:
cd .. && npm run typecheck                          # ambos proyectos
npm run build                                       # electron-vite → out/

# 3) Empaquetar (SIEMPRE con --config.npmRebuild=false):
npx electron-builder --dir --win --config.npmRebuild=false   # → release/win-unpacked

# 4) Instalar (reemplaza la app en ejecución):
powershell -Command "Get-Process PLANO -ErrorAction SilentlyContinue | Stop-Process -Force"
sleep 3
rm -rf "$LOCALAPPDATA/Programs/PLANO"
cp -rf release/win-unpacked "$LOCALAPPDATA/Programs/PLANO"

# 5) Lanzar:
"$LOCALAPPDATA/Programs/PLANO/PLANO.exe" &
```

**Puertos de test para no pisarse:** usa puertos CDP altos y frescos (9505+, 96xx+, 97xx+).
**Siempre mata procesos zombie** (`Get-Process PLANO,electron,chrome | Stop-Process -Force`)
porque un puerto tomado por un leftover hace fallar las E2E con "timeout: cdp".

### Test suite (scripts en `scripts/`)
| Script | Qué prueba |
|---|---|
| `agent-host-test.mjs` | Daemon puro: spawn detached, sesión sobrevive disconnect, reattach, buffer, kill, shutdown |
| `daemon-web-test.mjs` | Web server: static, auth (token/sin token), REST create/write/buffer/kill, WS events |
| `plano-e2e.mjs` | App completa: spawn → quit → shell sobrevive → relaunch → misma sesión/pid → stream → kill |
| `plano-mobile-e2e.mjs` | Celular: crear con app abierta (materializa), escribir (se ve en PC), crear con app cerrada (pending→relaunch) |
| `plano-pwa-ui-test.mjs` | La PWA en Chrome headless (`--headless=old`): connect, ver agentes, mensaje, crear desde UI |
| `plano-agent-e2e.mjs` | Claude Code REAL: sobrevive quit, se redetecta al relaunch, write llega a la misma sesión |

Ejecutar una: `node scripts/plano-e2e.mjs "D:\Tools\Plano\release\win-unpacked\PLANO.exe" <tempUserData> <port>` (o con el electron de dev).

---

## 5. Gotchas / decisiones tomadas (NO revertir sin entender)

- **`npm install` puede PODAR deps** que no están en package.json (pasó con express/
  @modelcontextprotocol y @types/express — reinstalar con `--save`/`--save-dev`).
- **`asar extract-file package.json` SOBREESCRIBE el package.json del repo** — usar `-d` a un tmp.
- **Puerto web fijo 56780** (+ fallback aleatorio). El QR/URL de Settings usa el real. `WebServer.listen`
  debe RECHAZAR en EADDRINUSE (si no, el daemon se cuelga sin escribir el host file).
- **mDNS `plano.local`** anunciado con bonjour-service. Funciona en iOS/Safari; NO en Android/Chrome
  (el QR con la IP literal es la vía universal).
- **Filtro de IPs del QR**: excluye VPN/loopback/APIPA (NordLynx 10.5.0.2 rompía el QR — el primer
  adaptador del OS no es la LAN real). Prioriza Ethernet/Wi-Fi.
- **El daemon necesita `--webRoot`** (dev: `web-dist`, packaged: `resources/web`).
- **`attached` es un CONTADOR de viewers** (desktop + celular). El stream va a sockets que
  adjuntaron esa ptyId (un celular en Home NO recibe el stream de todas las sesiones).
- **El frame `request` del daemon lleva `id`** — el cliente DEBE chequear `event === 'request'`
  ANTES del branch genérico de replies RPC (si no, se traga las peticiones del daemon).
- **`reconcileTerminalSessions(protectedIds)`** — sin esto, las sesiones pendientes del celular se
  mataban como huérfanas en el arranque.
- **`height: 100dvh`** en la web app — sin esto las barras inferiores salen debajo de la pantalla
  en móviles (URL bar del navegador).
- **El contenedor del terminal debe ser `display:flex; flex-direction:column`** — si no, el xterm
  desborda y la barra de flechas se superpone al terminal.
- **Las flechas del toolbar NO hacen `focus()`** — hacerlo abre/cierra el teclado del celular.
- **Ventana de terminal del desktop** (`src/main/windows/mainWindow.ts`): no tocar el layout.
- **Limpiar artefactos de test**: crear sesiones de prueba en el userData REAL crea workspaces/
  paneles "Administrator"/"FromPhone" — limpiar editando `%APPDATA%/PLANO/workspaces.json` con la
  app cerrada (autosave sobrescribiría la edición si está abierta).
- **`keepAgentsOnQuit`** (default true) — el setting que decide "cerrar PLANO = matar todo" (false)
  vs "seguir corriendo" (true).

---

## 6. Roadmap de próximos pasos naturales

1. Notificaciones del celular cuando un agente termina (push/WS persistente).
2. Dashboard "qué hicieron mis agentes" (timeline de prompts/outputs).
3. Bandeja del sistema en el PC con el estado de agentes en background.
4. Tailscale como alternativa al túnel (más estable, requiere app en ambos dispositivos).
