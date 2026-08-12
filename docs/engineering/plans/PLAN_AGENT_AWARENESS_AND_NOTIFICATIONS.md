# PLAN — Saber qué pasa en los otros workspaces (y decirlo bien)

**Estado:** plan de ingeniería, listo para que otra IA lo ejecute
**Origen:** tres puntos de la lista del usuario — estado por workspace, avisos dentro de PLANO, y un slider para la fuente de las terminales.
**Método:** auditoría del código actual con evidencia `archivo:línea`. Todo lo que sigue reutiliza maquinaria que ya existe; no hay ningún subsistema nuevo.

---

## Contexto

Con el mesh en marcha el usuario ya trabaja con varios agentes repartidos en distintos workspaces. El problema ya no es que no se comuniquen: es que **desde el canvas no se ve qué pasa fuera del workspace activo**. Un agente termina, o se queda esperando una respuesta, y no hay forma de enterarse sin ir workspace por workspace.

Tres piezas:

1. En la vista de workspaces, ver **si ahí hay algo trabajando**.
2. **Avisos dentro de PLANO** cuando un agente de otro workspace termina o queda esperando respuesta.
3. Un **slider** para el tamaño de fuente de las terminales.

Y una condición transversal: que los avisos **no parezcan pegados**. Tienen que leerse como parte de PLANO — sobrios, tipográficos, con física, estilo Apple.

---

## 1. Estado real por workspace

### El dato de hoy es falso

`SpacesMenu.tsx:255`:

```ts
const agents = panels.filter((p) => p.type === 'terminal' || p.type === 'agent').length
```

Eso cuenta **paneles**, no agentes. Una terminal recién abierta y vacía ya suma «1 agent», y el número no dice absolutamente nada sobre si algo está corriendo. Hay que sustituirlo, no adornarlo.

### Qué reutilizar

`buildAgentRoster()` (`src/renderer/app/agentRoster.ts:35`) ya cruza `useTerminalStore` + `useAgentStore` + `usePanelStore` + `useSpacesStore`, y cada `RunningAgent` trae `spaceId`, `spaceName`, `inActiveSpace` y su `verdict`. Y funciona **cross-workspace** porque los PTY viven en el daemon y la detección sigue corriendo en main aunque el panel esté hibernado — esa parte ya está resuelta y probada.

### Qué hacer

- Selector derivado junto al roster: por `spaceId` → `{ total, working, awaiting }`.
- `working` sale de `verdict.phase`. **`awaiting-input` no está en el verdict del renderer**: vive en el roster del mesh (`AgentState`, plan v3 B). Llega ya al renderer por `window.plano.agentMesh.onMeshEvent` — el mismo stream que consume `stores/useMeshLinks.ts`. Cachearlo en un store pequeño al lado de ese.
- En la fila de `SpacesMenu.tsx`, sustituir el conteo falso por el real y añadir **un punto**, con el mismo lenguaje que ya usa el panel de terminal:

| Situación | Señal |
|---|---|
| Alguien `awaiting-input` | punto ámbar **respirando** — es el que urge: te están esperando |
| Alguien `working` | punto en el acento del agente, quieto |
| Nada corriendo | sin punto |

- El mismo punto en el chip de workspace del TopBar, para verlo sin abrir el menú.

**Rendimiento:** suscribirse al **contador derivado**, nunca al roster entero. Un agente escupiendo salida no puede re-renderizar la lista de workspaces. La regla del proyecto ya está fijada: nada que cambie por frame llega a React.

---

## 2. Avisos dentro de PLANO

### El detector ya existe

`src/renderer/app/agentDoneSound.ts` resuelve lo difícil: máquina `armed → working → idle`, confirmación diferida (`CONFIRM_MS`) que descarta falsos finales, y cooldown global. Hoy solo suena un chime. **No reescribir esa máquina** — tiene los casos límite ya resueltos.

### Qué hacer

- Extraer el detector a `src/renderer/app/agentActivity.ts`, que emite `agent-finished` y `agent-awaiting` con `{ ptyId, panelId, spaceId, kind }`. `agentDoneSound` pasa a ser **un consumidor más**.
- `agent-awaiting` viene del mesh, no del verdict (misma fuente que el punto 1).
- Consumidor nuevo que empuja el aviso.
- **Clic → saltar al agente.** Ya está resuelto en `AgentManager.tsx`: `switchSpace()` (`app/workspaceActions`) + `focusPanel()` (`app/actions`). Reutilizar esa ruta.
- **Solo lo que no se ve:** si el agente está en el workspace activo ya se nota en el canvas (borde tintado, punto de estado, enlace del mesh). El aviso es para `!inActiveSpace`; en el activo, como mucho `awaiting-input`.
- **Agrupar:** si terminan tres a la vez, **un** aviso («3 agentes terminaron») que abre el Agent Manager. Nunca tres apilados.
- Ajuste `general.agentDoneNotify` (por defecto ON), al lado de `agentDoneSound`. Receta conocida: `shared/domain/settings.ts` + `DEFAULT_SETTINGS` + fila en `chrome/settings/sections.tsx` + entrada en `SETTINGS_INDEX`.

### Diseño (esto es la mitad del trabajo, no el adorno final)

**El toast actual no está armonizado.** `chrome/Toasts.tsx:15` mete un emoji literal:

```tsx
<span className="text-text-secondary">📱</span>
```

Un emoji del sistema es lo único en toda la UI que no pasa por tokens ni por el set de iconos: no se re-tinta con el tema, no respeta el acento, y arrastra el estilo de otro sistema operativo. Además el componente es una única forma sin jerarquía: mismo aspecto para «creado desde el móvil» que para «un agente te está esperando».

**Reescribir `Toasts.tsx` como una superficie con jerarquía:**

- **Forma.** Se mantiene arriba-centro, pero pasa de píldora a tarjeta corta con el radio del sistema (`surface-layer--popover`, 16px). Una línea de título tipográfica y, si hace falta, una segunda línea secundaria — nunca más de dos.
- **Identidad, no emoji.** A la izquierda, el logo del harness (`AgentLogo`, el mismo que usan el panel y el Agent Manager) o un `Icon` de lucide. El emoji desaparece.
- **Color con significado.** El acento del agente (`AGENTS[kind].accent`, precedente ya establecido) como una hairline a la izquierda de la tarjeta. Nada de fondos de color. `--destructive` queda reservado para errores, como en el resto de la app.
- **Jerarquía por peso, no por tamaño.** «Terminó» es informativo y se va solo. «Te está esperando» persiste hasta que se atiende, y lo único que lo distingue es el punto ámbar respirando y que no caduca. Sin banners, sin modales, sin sonidos extra.
- **Movimiento Apple: entra rápido, sale suave.** Entrada ~180 ms con desplazamiento corto (6–8 px hacia abajo) + opacidad, salida ~240 ms con `var(--ease-settle)`. Al apilarse, los de abajo se desplazan con muelle, no con un salto. Nada rebota ni gira.
- **Se puede descartar.** Deslizar hacia arriba o clic en la X. Un aviso que no se puede quitar es una alarma.
- **Respeta `reduceMotion`:** aparece y desaparece con opacidad, sin desplazamiento ni respiración.
- **Nunca tapa el trabajo.** Ancho máximo acotado, siempre por encima del canvas pero por debajo de modales, y como mucho **tres** visibles: el resto se resume en «+N».

**Reglas del sistema que aplican tal cual:** UI en inglés, sin texto de relleno bajo el título, todo con tokens (`theme.css` / Tailwind), esquinas redondeadas, tipografía Space Grotesk. El color solo como acento con significado.

---

## 3. Slider para la fuente de las terminales

Hoy es un `NumberField` (`sections.tsx:370`, `min 0 max 32`) donde **0 significa «automático»** — un valor mágico que un slider no puede expresar.

- Cambiar a `Slider` (`chrome/settings/controls.tsx:111`), el mismo control que ya usan el brillo del grid y el halo. Rango **10–24 px**, paso 1, `format: (v) => \`${v}px\``.
- Resolver el 0: un `fontSize: 0` guardado se muestra como el valor real por defecto (13). Se sigue **aceptando** 0 al leer, para no romper ajustes existentes, pero el slider nunca lo escribe.
- La vista previa de terminal de Ajustes debe seguir el arrastre en vivo.
- **No tocar** el override por terminal (Ctrl +/−, `TerminalProps.fontSize`): el slider es el valor global y el override sigue ganando. Merece una línea en la descripción del ajuste.

---

## Archivos

- `src/renderer/app/agentRoster.ts` — conteos por workspace derivados del roster existente.
- `src/renderer/app/agentDoneSound.ts` → extraer a `src/renderer/app/agentActivity.ts`.
- `src/renderer/chrome/workspaces/SpacesMenu.tsx` — estado real + punto.
- `src/renderer/chrome/TopBar.tsx` — el mismo punto en el chip de workspace.
- `src/renderer/chrome/Toasts.tsx` — reescritura con jerarquía (el trabajo de diseño).
- `src/renderer/chrome/settings/sections.tsx` — slider de fuente + `agentDoneNotify`.
- `src/shared/domain/settings.ts` — `agentDoneNotify` + `DEFAULT_SETTINGS`.
- Store del estado `awaiting-input`, junto a `stores/useMeshLinks.ts` (mismo stream).

---

## Verificación

`npm run typecheck` verde — única puerta automática del repo.

**E2E** con el patrón de `.plano-tests/` (CDP, `PLANO_USER_DATA_DIR` temporal, puerto único, cerrar por PID **nunca** por nombre de imagen):

| Caso | Criterio |
|---|---|
| W1 | Workspace con un agente trabajando → punto en su fila; al terminar, se apaga |
| W2 | Terminal vacía sin agente → **no** cuenta (hoy sí) |
| W3 | Agente en `awaiting-input` → punto ámbar, con prioridad sobre `working` |
| N1 | Termina en workspace NO activo → un aviso; clic → salta y enfoca ese panel |
| N2 | Termina en el workspace activo → sin aviso redundante |
| N3 | Tres a la vez → **un** aviso agrupado |
| N4 | `agentDoneNotify` off → ningún aviso (el sonido sigue su propio ajuste) |
| N5 | Un aviso de «esperando» persiste; uno de «terminó» caduca solo |
| N6 | `reduceMotion` → sin desplazamiento ni respiración, solo opacidad |
| N7 | Sin emojis del sistema en la UI de avisos (identidad por `AgentLogo`/`Icon`) |
| F1 | Arrastrar el slider cambia la fuente de las terminales en vivo |
| F2 | Ajuste antiguo con `fontSize: 0` → el slider muestra 13, no 0 |
| F3 | Terminal con override Ctrl +/− no se ve afectada por el slider |

**Gotchas ya pagados en este proyecto:**
- El texto de la terminal **no está en el DOM** (renderer WebGL): verificar por archivo o por el buffer del daemon, nunca por `.xterm-rows`.
- El `ev()` de los probes debe leer `r.result.exceptionDetails`, no `r.exceptionDetails`.
- No suscribir componentes a registros completos (`s.panels`, roster entero) si el dato cambia por frame.
- Jamás una custom property heredada en un ancestro de los paneles.

**Prueba manual:** dos workspaces, un agente trabajando en el inactivo. Su fila debe marcarlo; al terminar debe llegar el aviso, y el clic debe llevar exactamente a esa terminal.

---

## Orden de ejecución

1. **Punto 3** (slider) — aislado, media hora, sin dependencias. Quítalo de en medio.
2. **Punto 1** (estado por workspace) — corrige un dato que hoy es falso y da la base compartida (`awaiting-input` en el renderer).
3. **Punto 2**, en dos pasos: primero extraer el detector y emitir avisos con el toast actual (que funcione), y **después** la reescritura de `Toasts.tsx`.

Ese último orden importa: si se mezcla el diseño con la lógica, un aviso que no aparece se confunde con un aviso que aparece feo, y se depuran dos cosas a la vez.
