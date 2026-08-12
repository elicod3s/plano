# PLAN — Interconexión universal de agentes (Mesh v2)

**Estado:** plan de ingeniería, listo para que otro lo ejecute
**Objetivo:** que CUALQUIER agente lanzado dentro de PLANO —sea el harness que sea— detecte automáticamente a los demás, pueda escribirles, coordinarlos y **crear agentes nuevos**, y que todo eso se **vea** en el canvas.
**Método:** auditoría estática del código actual (no se ejecutó nada). Cada veredicto lleva evidencia `archivo:línea`.
**Autorización explícita del usuario:** si una pieza actual no es lo bastante robusta, **se elimina y se rehace**; no hay obligación de conservarla.

---

## 1. La prueba de aceptación, en una frase

El usuario abre una terminal, lanza Claude Code y le escribe:

> «Estamos en PLANO y puedes controlar otras terminales.»

A partir de ahí, **sin ninguna configuración manual**, debe poder:

1. **Descubrir** qué otros agentes existen (nombre, harness, carpeta, si están ocupados).
2. **Escribirles**: el prompt aparece **tecleado dentro de la terminal real del otro agente**, visible en pantalla, con una marca de quién lo envía.
3. **Ver trabajar** al otro agente en su panel, en vivo.
4. **Crear agentes nuevos**: pedir «ábreme dos Codex en `packages/api`» y que **se abran dos paneles de terminal en el canvas** con Codex corriendo dentro.
5. **Ver la interconexión**: una línea animada entre el panel emisor y el receptor mientras viaja el mensaje. Discreta, con física, estilo Apple — nunca un adorno que distraiga.

Si algo de esto necesita que el usuario copie un JSON a mano, el plan ha fallado.

---

## 2. Veredicto sobre lo que ya existe

### 2.1 Se CONSERVA (es sólido y hay que reutilizarlo, no reescribirlo)

| Pieza | Por qué se conserva |
|---|---|
| `AgentDetectionService.ts` + `AGENTS` (`shared/domain/agent.ts:33`) | Es como sabemos qué harness corre en cada terminal. Fusiona árbol de procesos + banner, con histéresis. Es la base de la identidad. |
| `AgentContextService.ts` | Registro canónico en main, tails acotados, timeline. Vive en el sitio correcto y sobrevive a paneles hibernados. |
| `contextRedaction.ts` | Punto único de redacción. **Sigue siendo obligatorio**: nada sale del PTY sin pasar por aquí. |
| `PtyManager` + identidad estable (`panelId`/`terminalId`/`spaceId` por PTY) | Ya da la identidad que el mesh necesita. |
| `MeshWorktreeService.ts` | Aislamiento por worktree para agentes que escriben en paralelo. Se reutiliza tal cual. |
| **`pendingPanels.ts` + `app/externalTerminals.ts`** | **La pieza clave y ya resuelta**: permite materializar una terminal como panel real del canvas desde FUERA del renderer (hoy lo usa el móvil). Es exactamente el mecanismo para que un agente cree agentes. |
| `daemon/webServer.ts` (HTTP+WS, puerto fijo 56780) | El transporte correcto ya existe y sobrevive al cierre de la app. |
| `AgentManager.tsx` + `app/agentRoster.ts` | El roster cross-workspace ya está resuelto; se extiende, no se rehace. |
| `AgentLauncher.tsx:23-29` | Tabla de comandos de lanzamiento por harness. Se promueve a `shared/` para que el mesh la use. |

### 2.2 Se ELIMINA y se rehace

**`PlanoMcpService.ts` (512 líneas) y su cableado en `registerIpc.ts:586`.** El uso del SDK oficial es correcto, pero el diseño hace **imposible** el objetivo. Seis defectos, cada uno bloqueante por separado:

1. **Configuración manual.** `mcpGetConfig` (`registerIpc.ts:586-609`) genera un JSON para que el usuario lo **copie y pegue** en cada harness. Nada se registra solo. → «que todos lo detecten» hoy es literalmente imposible.
2. **Sin identidad de quien llama.** Un único bearer compartido (`PlanoMcpService.ts:91`). Todos los agentes presentan el mismo token, así que el servidor **no puede saber quién llama**. Sin esto no hay mensajería atribuida, ni permisos por agente, ni auditoría. Es el defecto estructural.
3. **Puerto efímero.** `port: 0` por defecto (`settings.ts:323`) → puerto distinto en cada arranque → cualquier config escrita queda obsoleta. El auto-registro es imposible sin endpoint estable.
4. **Apagado por defecto** (`enabled: false`, `settings.ts:322`). El objetivo exige cero configuración.
5. **Vive en el proceso de la app.** Las terminales sobreviven al cierre (Agent Host), pero el MCP muere con la ventana: los agentes pierden el mesh justo cuando siguen trabajando. Está en el tier equivocado.
6. **Sin buzón.** La única entrega es escribir al PTY (`agentMeshDispatch`). Si el agente está a mitad de turno, el mensaje se pierde: sin cola, sin acuse, sin reintento.

**Decisión:** el transporte se rehace en el **daemon**, con **token por agente**, **puerto fijo** y **buzón durable**. `PlanoMcpService`, el canal `mcpGetConfig` y los ajustes `agentMesh.mcp.{enabled,port}` se retiran.

> `agentMeshDispatch` **no** se tira: su lógica de validación por objetivo (`not-found | not-agent | working | exited | write-failed | too-large`) es buena y se traslada al nuevo bus como capa de entrega.

---

## 3. Arquitectura objetivo

```
┌─ AGENTES (procesos hijos de cada PTY) ─────────────────────────────┐
│ Claude Code · Codex · Gemini · Cursor · Kiro · Pi/OMP · Hermes …   │
│   cada uno con   PLANO_AGENT_ID + PLANO_MESH_TOKEN (propios)       │
└───────────────┬───────────── MCP (HTTP streamable, loopback) ──────┘
                │
┌───────────────▼─── DAEMON (sobrevive al cierre de la app) ─────────┐
│  MeshBus            identidad, roster, buzones, entrega, timeline  │
│  MeshProvision      escribe la config MCP de cada harness + skill  │
│  webServer.ts       puerto FIJO ya existente (56780) + ruta /mesh  │
└───────────────┬────────────────────────────────────────────────────┘
                │  eventos (WS) ─ external-terminal, mesh-link, mesh-msg
┌───────────────▼─── APP (main) ────────────────────────────────────┐
│  AgentContextService · AgentDetectionService · redaction · worktree │
└───────────────┬────────────────────────────────────────────────────┘
                │ IPC
┌───────────────▼─── RENDERER ───────────────────────────────────────┐
│  MeshLinkLayer (animación)  ·  AgentManager  ·  paneles terminal    │
└────────────────────────────────────────────────────────────────────┘
```

**Regla de oro:** el mesh vive en el **daemon**, no en la app. Los agentes siguen conectados aunque la ventana esté cerrada — igual que hoy siguen corriendo sus PTYs.

---

## 4. Fases

### F1 — MeshBus en el daemon

**Nuevo:** `src/main/daemon/mesh/` → `bus.ts`, `identity.ts`, `mailbox.ts`, `tools.ts`, `types.ts`.
**Se monta en:** `daemon/webServer.ts` (ya tiene HTTP + `WebSocketServer` en `noServer`, líneas 146-158). Ruta `POST /mesh` (MCP streamable) y `GET /mesh/events` (SSE).

- Puerto **fijo**, el mismo 56780 que ya usa el móvil (`daemon/index.ts:41`). Un solo endpoint estable = configs que no caducan.
- **Solo loopback** para el mesh (el móvil ya tiene su propia política de LAN; el mesh NO se expone a la LAN).
- El bus es la única fuente de verdad de: roster, buzones, enlaces activos y timeline de mensajes.
- Estado durable en `<userData>/mesh/` (buzones + log), escritura atómica temp+rename, con tope de tamaño y rotación (mismo patrón que `agent-host.json`).

### F2 — Identidad por agente (la pieza que lo desbloquea todo)

**Archivo:** `src/main/daemon/ptySpawn.ts` — `cleanEnv()` (línea ~263) y `spawnShell()` (`spawnOpts.env`, línea ~452).

`cleanEnv()` es hoy un singleton sin argumentos. **Cambiarlo a `cleanEnv(identity?: AgentIdentity)`** e inyectar por terminal:

```
PLANO_AGENT_ID     = <ptyId>            // estable, ya existe
PLANO_MESH_URL     = http://127.0.0.1:56780/mesh
PLANO_MESH_TOKEN   = HMAC(masterSecret, ptyId)   // derivado, revocable, único
PLANO_WORKSPACE    = <spaceId>
PLANO_SESSION      = plano               // marcador de "estoy dentro de PLANO"
```

El bus resuelve `token → agente`, así que **toda llamada MCP queda atribuida**. Sin esto no hay mensajería con remitente, ni permisos, ni auditoría, y es la razón principal por la que el servicio actual se tira.

> Ya hay precedente en este archivo: `TERM`/`COLORTERM` se fijan ahí y `no_color`/`force_color` se eliminan. La inyección de identidad va en el mismo sitio y con el mismo criterio.

### F3 — Auto-provisioning: que cada harness lo detecte solo

**Nuevo:** `src/main/daemon/mesh/provision.ts`.
**Cuándo:** en cada arranque del daemon (no solo en la instalación), porque la URL es fija pero el secreto puede rotar.

Un escritor **idempotente** por harness. Todos: leer → parsear → fusionar solo la clave `plano` → escribir atómico → **backup previo** `<archivo>.plano-backup`. Nunca reescribir el archivo entero del usuario.

| Harness | Destino | Formato |
|---|---|---|
| Claude Code | `~/.claude.json` (o `claude mcp add` si el binario está) | `mcpServers.plano` |
| Codex | `~/.codex/config.toml` | tabla `[mcp_servers.plano]` |
| Gemini CLI | `~/.gemini/settings.json` | `mcpServers.plano` |
| Cursor | `~/.cursor/mcp.json` | `mcpServers.plano` |
| opencode / Kiro / Pi / OMP / Hermes | según su config | misma clave `plano` |
| Aider y cualquiera sin MCP | — | **fallback F3.2** |

**F3.1 — Skill de Claude Code.** Instalar `~/.claude/skills/plano-mesh/SKILL.md`: explica el protocolo, cuándo usarlo y los límites. Es lo que hace que Claude **sepa** que puede orquestar sin que el usuario se lo explique. Mismo patrón para `AGENTS.md` en los harnesses que lo soporten.

**F3.2 — Fallback para harnesses sin MCP.** Un binario `plano` en PATH (`plano send`, `plano inbox`, `plano roster`, `plano spawn`) que habla con el bus usando el mismo token de entorno. Cualquier agente que sepa ejecutar comandos participa. **Sin este fallback la promesa "cualquier harness" es falsa.**

**F3.3 — Desprovisión limpia.** Al desinstalar: quitar SOLO la clave `plano` de cada config, restaurar backups y borrar la skill. Se engancha en `build/installer.nsh`.

### F4 — Protocolo y herramientas

Todas las herramientas reciben identidad implícita del token, nunca un `from` que el modelo pueda falsear.

**Lectura (siempre disponibles):**
- `plano_whoami` — quién soy, en qué workspace, qué puedo hacer.
- `plano_roster` — agentes vivos: id, harness, cwd, workspace, `busy|idle`, título del panel.
- `plano_inbox` — mensajes pendientes (con `ack`).
- `plano_context(agentId)` — tail limpio y **redactado** de otro agente.
- `plano_timeline` — eventos recientes.

**Escritura (con consentimiento, ver F8):**
- `plano_send(to, text, mode)` — `mode: 'type' | 'queue'`.
- `plano_broadcast(filter, text)` — con tope de objetivos.
- `plano_spawn_agent(harness, cwd, prompt?, count?)` — **crea agentes** (F6).
- `plano_claim(task)` / `plano_handoff(to, task)` — coordinación sin pisarse.

**Reglas de robustez:** todo mensaje con `id`, `at`, `from`, `to`, `ttl`; entrega **exactly-once** por `ack`; buzón acotado por agente; rate-limit por emisor; sin ciclos (un mensaje lleva `hops`, tope 4) para que dos agentes no entren en bucle infinito de respuestas.

### F5 — Entrega VISIBLE (requisito explícito)

Cuando A escribe a B, **se tiene que ver**. Dos modos:

- **`type` (por defecto):** el bus escribe al PTY de B **en trozos, con ritmo** (~40-80 car/s, con jitter) para que se vea teclear, no un volcado. Precedido de una línea de procedencia compacta y sobria:
  `▸ from Claude Code · terminal #3` y el prompt debajo.
- **`queue`:** si B está ocupado (`busy`), el mensaje entra al buzón y se entrega cuando pase a `idle`; el panel muestra un contador discreto de pendientes.

**Anti-pisado:** nunca escribir a un PTY mientras el agente está a mitad de turno salvo que el emisor lo pida explícitamente. Reutilizar la clasificación de `agentMeshDispatch` (`working` es un error de destino, no un atropello).

**Deduplicación:** si un mensaje se entrega por PTY, **no** aparece además en `plano_inbox` — o el agente lo procesa dos veces.

### F6 — Que un agente cree agentes

**No hay que inventar nada.** El camino ya existe para el móvil y se reutiliza entero:

`plano_spawn_agent` → el daemon spawnea el PTY con `bootCommand` = comando del harness (tabla de `AgentLauncher.tsx:23-29`, promovida a `shared/domain/agentLaunch.ts`) → emite `external-terminal` → `app/externalTerminals.ts` materializa el **panel real en el canvas** → si la app está cerrada, `pendingPanels.ts` lo deja registrado y aparece al abrir.

Detalles que el ejecutor debe respetar:
- Colocación: el panel nuevo aparece **al lado del que lo pidió**, no en el centro; reutilizar la geometría de `app/actions.ts` y el snapping existente.
- El agente creado **hereda identidad de mesh** (F2) y por tanto ya está interconectado desde su primer byte.
- `count > 1` crea varios en fila (el caso «ábreme dos Codex»), con tope duro (p. ej. 6) y confirmación por encima de 2.
- El `prompt` opcional se entrega en modo `type` cuando el agente esté listo, no antes: esperar el veredicto de `AgentDetectionService`, no un `sleep`.

### F7 — La capa visual (estilo Apple)

**Nuevo:** `src/renderer/canvas/MeshLinkLayer.tsx`, un ÚNICO `<svg>` dentro de la capa mundo, detrás de los paneles.

- Un enlace = curva bezier entre los bordes de los dos paneles, con un pulso que viaja del emisor al receptor mientras dura la entrega.
- **Apple = discreción y física, no fuegos artificiales.** Muelle suave, opacidad baja en reposo, el enlace se desvanece unos segundos después de entregar. El color sale del `--agent-accent` del emisor (precedente ya establecido en el sistema de diseño).
- El panel receptor marca la llegada con un realce mínimo de su borde, sin mover nada.

**Restricciones de rendimiento (no negociables, aprendidas y medidas hoy):**
- **Jamás** escribir una custom property heredada en un ancestro de los paneles: eso restyla todo el subárbol por frame. Coste medido: 424 ms vs 13 ms de recalc por gesto. Las variables van en la hoja que las consume.
- La animación va con `transform`/`opacity` sobre el SVG, **nunca** re-renderizando React por frame. Leer la cámara con `viewportController.getLive()`, no suscribirse a `zoom`.
- `will-change` solo durante el movimiento y solo en la capa mundo.
- Respetar `prefers-reduced-motion` y el ajuste de movimiento reducido: sin animación, el enlace simplemente aparece y desaparece.
- Nada de `content-visibility: auto` en superficies del canvas (blanquea contenido en movimiento dentro de la capa escalada).

**Ver trabajar al otro agente:** no hace falta nada nuevo. El panel del receptor ya muestra su salida en vivo y su morph de agent-mode. El plan solo añade el enlace y el realce de llegada.

### F8 — Seguridad

- **Token por agente**, derivado y revocable; revocar al morir el PTY.
- **Loopback exclusivo** para el mesh. No se expone a la LAN aunque el móvil sí lo esté.
- **Redacción obligatoria**: `plano_context` y `plano_timeline` pasan por `contextRedaction` antes de salir. Sin excepciones.
- **Consentimiento por workspace**: las herramientas de escritura arrancan **desactivadas** para un workspace hasta que el usuario lo habilita una vez (toast con un clic, no un JSON). Dentro del mismo workspace, después, es libre — que es lo que el usuario quiere.
- **Cross-workspace** siempre requiere confirmación explícita.
- Rate-limit por emisor, tope de objetivos por broadcast, tope de `hops`.
- Todo lo que un agente hace a otro queda en el timeline y es visible en el AgentManager: **auditable**.

### F9 — Instalación

- El provisioning corre al arrancar el daemon (cubre instalación, actualización y usuarios que instalen un harness después).
- `build/installer.nsh`: desprovisión al desinstalar.
- Si un harness no está instalado, **no se toca nada** y no se crea su config.

---

## 5. Pruebas

`npm run typecheck` es la única puerta automática del repo y debe pasar en cada fase.

**Unitarias (nuevas, con un runner mínimo si no hay):**
- Provisioning idempotente: aplicar N veces = un solo bloque `plano`; no altera el resto del archivo; backup creado; desprovisión restaura.
- Identidad: token → agente; token revocado tras salida; dos agentes nunca comparten token.
- Buzón: exactly-once con `ack`; TTL; tope; sin pérdida al reiniciar el daemon.
- Anti-bucle: `hops` corta la cadena; broadcast respeta el tope.
- Redacción: un secreto sembrado en el tail NO sale por `plano_context`.

**E2E (CDP, siguiendo el patrón ya establecido en `.plano-tests/`):**

| Caso | Comprueba |
|---|---|
| E1 | Arranque limpio → configs de los harnesses instalados contienen `plano` y apuntan a 56780 |
| E2 | Dos terminales con agentes simulados → `plano_roster` devuelve ambos con identidad correcta |
| E3 | A envía a B en modo `type` → **el texto aparece en el PTY de B** (verificar por archivo, no por buffer: el renderer es WebGL y el DOM no tiene el texto) |
| E4 | B ocupado → el mensaje va al buzón y se entrega al pasar a idle |
| E5 | `plano_spawn_agent(count: 2)` → **aparecen 2 paneles nuevos** en el canvas con el boot command corriendo |
| E6 | App cerrada → spawn desde el bus → al abrir, los paneles se materializan vía `pendingPanels` |
| E7 | Perf: 6 agentes intercambiando mensajes mientras se panea → **recalc de estilo con y sin la capa de enlaces debe ser equivalente**, 0 long tasks |
| E8 | Desinstalación → ninguna config de harness conserva la clave `plano` |

**Aislamiento obligatorio** (reglas ya establecidas): `PLANO_USER_DATA_DIR` temporal único por ejecución, puerto CDP único, fixtures desechables, **nunca** matar por nombre de imagen — acotar por PID/puerto/user-data.

> **Gotcha ya pagado:** el `ev()` de los probes debe leer `r.result.exceptionDetails`, no `r.exceptionDetails` — si no, las excepciones se tragan en silencio y un `Error` serializado con `returnByValue` llega como `{}`.

**Criterios de aceptación:** los 5 puntos de la sección 1, ejecutados por una persona que no ha configurado nada.

---

## 6. Orden de ejecución

1. **F2 (identidad)** — nada funciona sin esto; es barato y desbloquea todo lo demás.
2. **F1 (bus en el daemon)** con `plano_whoami` + `plano_roster` solamente. Verificar E2.
3. **F3 + F3.2 + F3.1** (provisioning, CLI de fallback, skill). Verificar E1 con al menos dos harnesses reales.
4. **F4 + F5** (mensajería y entrega visible). Verificar E3 y E4.
5. **F6** (spawn de agentes). Verificar E5 y E6.
6. **F7** (capa visual). Verificar E7 — medir **antes y después**.
7. **F8** (consentimiento, límites, auditoría) — endurecer antes de exponer nada.
8. **Retirada** de `PlanoMcpService`, `mcpGetConfig` y sus ajustes, con migración de los que ya lo tenían activado.
9. **F9** (desprovisión en el instalador). Verificar E8.

Cada paso se mide y se verifica por separado. **No** avanzar a F7 sin F2-F6 verdes: una animación bonita sobre un transporte que pierde mensajes es peor que no tener nada.

---

## 7. Invariantes que no se pueden romper

- **Las terminales no se desmontan nunca** por lógica del mesh: perderían su sesión xterm/WebGL y su PTY.
- **La redacción es un paso obligatorio**, no un filtro opcional.
- **El renderer no es fuente de verdad**: el roster y los buzones viven en el daemon; la UI solo los refleja.
- **Un agente jamás fabrica su propio `from`**: la identidad sale del token.
- **Cero configuración manual.** Si el ejecutor termina pidiendo al usuario que pegue un JSON, la fase no está hecha.
- **Diseño**: todo el chrome nuevo con tokens (`theme.css` / Tailwind), UI en inglés, sin texto de relleno, esquinas redondeadas del sistema. El color solo como acento con significado (el accent del agente emisor).
- **Concurrencia entre agentes**: varios agentes editan este repo a la vez — releer los archivos antes de editarlos.
