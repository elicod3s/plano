# PLAN — Mesh v3: que la orquestación entre agentes funcione de verdad

**Estado:** plan de ingeniería, listo para que otra IA lo ejecute
**Punto de partida:** Mesh v2 ya está integrado y funcionando a medias (roster, envío, spawn, consentimiento, enlaces animados). Este plan arregla por qué **no funciona de verdad** y añade lo que falta para que sea una orquestación robusta.
**Método:** auditoría del código actual con evidencia `archivo:línea`. Los tres defectos de la sección 1 están **confirmados leyendo el código**, no supuestos.

---

## 1. Los tres defectos que explican lo que el usuario ve

### 1.1 🔴 El prompt se escribe pero NUNCA se ejecuta

**Evidencia:** `src/main/daemon/mesh/bus.ts:272`

```ts
const prefix = `▸ from ${this.displayName(agentId)} · ${...}\n`
const full = `${prefix}${text}\n`
```

La entrega termina en **`\n`** (line feed). En una terminal, **Enter es `\r`** (carriage return). Un `\n` baja de línea sin enviar: el texto aparece en el cuadro de entrada del agente receptor y se queda ahí para siempre.

El propio PLANO ya lo hace bien en otro sitio — `AgentLauncher.tsx:59` usa `` `${command}\r` `` — así que es una inconsistencia interna, no un desconocimiento.

**Agravante:** el banner de procedencia lleva su propio `\n` **en medio**, así que además de no enviarse, el prompt del receptor queda partido en dos líneas dentro de su input.

### 1.2 🔴 `busy` es prácticamente siempre `true` → todo se encola y no se entrega

**Evidencia:** `src/main/daemon/agentLight.ts:104`

```ts
export function lightPhase(lastOutputAt: number, now = Date.now()): AgentPhase {
  return now - lastOutputAt < 900 ? 'working' : 'idle'
}
```

Y `daemon/index.ts:803`: `mesh.setBusy(entry.ptyId, entry.appPhase === 'working')`.

"Ocupado" = "ha sacado algún byte en los últimos 900 ms". Pero **Claude Code y Codex repintan su UI constantemente** (spinner, contador de tokens, barra de estado, cursor). Un agente vivo y ocioso emite bytes casi cada frame ⇒ **`busy` se queda pegado a true**.

Consecuencia exacta de la captura del usuario: `modo queue (estaba busy, quedó encolado)`. Y como el buzón solo se drena en la transición a "no busy" (`bus.ts:128`), un mensaje encolado puede no entregarse **nunca**.

Esto también hace que `plano_roster` mienta: todos los agentes se ven ocupados siempre.

### 1.3 🟠 El enlace visual es un destello, no un vínculo

`MeshLinkLayer.tsx` dibuja el enlace mientras `state === 'traveling'` y lo desvanece (animación de 1.8 s). No existe el concepto de "estos dos agentes están colaborando ahora", que es lo que el usuario quiere ver.

---

## 2. Qué se construye

Cinco bloques. **El bloque A es obligatorio antes que todo lo demás**: sin entrega real, el resto es decorado.

| | Bloque | Qué resuelve |
|---|---|---|
| A | Entrega fiable | 1.1 + 1.2 — que la orden llegue y se ejecute |
| B | Estado real y consultable | "que pueda saber el estado del otro agente" |
| C | Petición → respuesta | "que mande la orden y espere el resultado" |
| D | Capacidades y control | delegar por capacidad (visión), cambiar el modelo de otro |
| E | Enlaces persistentes | que la línea se quede mientras colaboran |

---

## A. Entrega fiable (bloque crítico)

### A1. Enviar Enter de verdad

En `bus.ts`, la entrega debe terminar en `\r`. Y el banner **no puede ir dentro del cuadro de entrada**: hay que enviar **una sola línea lógica** y un único submit.

```ts
// Un solo submit al final. El banner va en la MISMA línea lógica que el mensaje, porque un
// salto intermedio parte el prompt del receptor en dos y algunos CLIs lo envían a medias.
const line = `[plano ← ${this.displayName(agentId)}] ${text.replace(/[\r\n]+/g, ' ')}`
await this.deliverTyped(to, line)
await this.submit(to) // escribe '\r' una vez
```

**Reglas duras:**
- El texto se **normaliza**: todo `\r` o `\n` interno se convierte en espacio. Un mensaje multilínea que entre crudo dispara envíos parciales en el receptor.
- El `\r` se manda **una sola vez** y **solo** después de que la última tecla se haya escrito.
- Tope de longitud por línea (ya existe `MAX_MESSAGE_LEN`); si se supera, se trunca con marca visible, nunca se parte en varios envíos.

### A2. Detección de ocupación que no mienta

Sustituir `lightPhase` por un modelo de actividad real. La señal "hubo bytes" no sirve; sí sirven estas, en orden de fiabilidad:

1. **Árbol de procesos** (ya existe `ProcessTreeService` y `AgentDetectionService`): si el agente tiene hijos activos (bash, node, ripgrep…), está trabajando. Es la señal más fiable y ya está implementada para la detección.
2. **Cambio de contenido, no volumen**: comparar el tail normalizado (sin códigos ANSI de reposicionamiento) cada ~400 ms. Un spinner repinta lo mismo; trabajar cambia el texto. Reutilizar `services/terminalText.ts`, que ya limpia el stream.
3. **Histéresis**: entrar en `working` rápido, salir tras ~1,5 s de contenido estable. Mismo criterio que ya usa `AgentDetectionService` para el veredicto de agente — copiar ese patrón, no inventar otro.

**Verificación obligatoria:** dejar un Claude Code y un Codex abiertos **sin hacer nada 60 s** y comprobar que `busy` es `false` durante ≥95 % del tiempo. Con la implementación actual será ~0 %.

### A3. El buzón nunca puede quedarse colgado

- Drenar el buzón **también por temporizador** (cada ~2 s), no solo en la transición a idle (`bus.ts:128`).
- **TTL real**: hoy `ttl: 0` (`bus.ts:265`) no se usa. Un mensaje que no se entrega en N minutos caduca, se marca `expired` y **se le informa al emisor**.
- Reintento con retroceso y tope; tras el tope, `status: 'undeliverable'` con motivo.
- El buzón sobrevive al reinicio del daemon (ya persiste) — verificar que al reatachar no se re-entregue lo ya entregado.

### A4. Confirmación de que el receptor lo recibió

Hoy `delivered` significa "escribí bytes en el PTY". No es lo mismo que "el agente lo aceptó". Añadir un **eco de confirmación**: tras el submit, esperar hasta ~3 s a que el tail del receptor cambie de forma no trivial. Si no cambia, `status: 'written-but-unconfirmed'`, y que el emisor lo sepa.

Distinguir siempre tres estados: **escrito** ≠ **enviado** ≠ **aceptado**.

---

## B. Estado real y consultable

Sustituir el booleano `busy` por un estado con significado, en `mesh/types.ts`:

```ts
type AgentState =
  | 'idle'          // en su prompt, listo
  | 'working'       // turno en curso (hijos activos o contenido cambiando)
  | 'awaiting-input'// pide permiso/confirmación y está bloqueado ← crítico
  | 'error'         // el último turno terminó mal
  | 'exited'        // el proceso murió
```

**`awaiting-input` es el que más valor aporta**: si un agente está esperando que alguien apruebe una herramienta, el que ordena debe saberlo en vez de creer que trabaja. Detectarlo por patrones de prompt de permiso en el tail limpio (los harnesses ya se identifican por banner en `AgentDetectionService`).

**Nueva herramienta `plano_status(agentId)`** — el "¿cómo vas?" que pide el usuario:

```json
{
  "id": "…", "kind": "codex", "state": "working",
  "currentTask": "refactor auth module",     // del último plano_send o plano_claim
  "since": 1786411495000,                     // desde cuándo en este estado
  "lastActivity": 1786411500000,
  "lastOutput": "…",                          // cola corta, REDACTADA
  "pendingMessages": 2,
  "exitCode": null
}
```

Y `plano_roster` pasa a devolver `state` en vez de `busy` (mantener `busy` como derivado `state === 'working'` durante una versión para no romper nada).

---

## C. Petición → respuesta (esperar el resultado)

Hoy `plano_send` es dispara-y-olvida. Hace falta una conversación real.

**`plano_ask(to, text, timeoutMs)`** — envía y **espera la respuesta**:

- Genera un `correlationId` y lo incluye en la línea entregada, en un formato que el receptor pueda devolver: `[plano ← A #7f3a] <texto>`.
- La skill/instrucciones (F3.1 de v2) enseñan al receptor: *"cuando termines, responde con `plano_reply(correlationId, resumen)`"*.
- El emisor queda esperando hasta `timeoutMs` (por defecto 120 s, tope 10 min).
- **Fallback si el receptor no llama a `plano_reply`**: al detectar que pasa a `idle`, capturar su tail limpio desde el momento del envío y devolverlo como respuesta implícita, marcada `inferred: true`. Sin esto, un agente que no coopere deja al emisor colgado.
- Cancelación: `plano_cancel(correlationId)` y liberación automática si el receptor muere.

**Regla anti-bloqueo:** `plano_ask` **nunca** puede bloquear el bus. La espera es por correlación, no por lock; otros mensajes siguen fluyendo. El tope `MAX_HOPS` ya existente evita cadenas infinitas de preguntas.

---

## D. Capacidades y control del otro agente

### D1. Registro de capacidades

Cada agente publica lo que puede hacer, para que la delegación no sea adivinanza:

```ts
interface AgentCapabilities {
  vision: boolean          // ¿puede leer imágenes?
  contextTokens: number
  model?: string           // modelo activo, cuando se puede saber
  tools: string[]
  canSpawn: boolean
}
```

Origen, por orden: lo que el agente declare con `plano_declare` (autoritativo) → una tabla por harness en `shared/domain/agent.ts` (por defecto sensato) → desconocido.

**Nueva `plano_find(capability)`**: "¿quién puede ver imágenes?" → lista de candidatos. Esto es lo que convierte *"si un modelo no puede ver imágenes que le pregunte a otro"* en algo automático en vez de manual: el agente sin visión llama a `plano_find('vision')`, coge el primero y le hace `plano_ask` con la ruta del archivo.

### D2. Cambiar el modelo de otro agente

Se puede, pero **solo por el camino que cada CLI ya ofrece**: escribir su comando de barra en el PTY. Tabla nueva en `shared/domain/agentControl.ts`:

| Harness | Cambio de modelo |
|---|---|
| Claude Code | `/model <id>` |
| Codex | `/model <id>` |
| Gemini CLI | `/model <id>` |
| otros | `null` → no soportado |

`plano_set_model(agentId, model)`:
- Falla explícitamente con `unsupported-harness` si no hay comando — **nunca** inventar sintaxis.
- Solo si el destino está `idle` (cambiar de modelo a mitad de turno rompe la sesión).
- Validar el id de modelo contra una lista por harness; rechazar cualquier cosa con espacios, `;`, `&&`, saltos de línea. **Es una escritura a un shell: tratarla como inyección de comandos.**
- Verificar el resultado leyendo el tail y devolver el modelo realmente activo, no un "ok" optimista.

Mismo patrón, misma tabla, para `plano_interrupt` (Esc/Ctrl-C según harness) y `plano_compact`.

---

## E. Enlaces persistentes y legibles

El enlace deja de ser un destello y pasa a representar **una relación viva**:

| Estado | Aspecto |
|---|---|
| `active` | A y B están colaborando (hay una `plano_ask` abierta o hubo tráfico < 60 s): línea **permanente**, opacidad ~0.35, pulso lento viajando |
| `waiting` | A espera respuesta de B: línea + un punto que respira en el extremo de B |
| `done` | resuelto: se desvanece en ~2 s |
| `failed` | timeout o error: destello corto en `--destructive` y fuera |

**Reglas:**
- La relación se mantiene mientras exista una correlación abierta o haya habido tráfico reciente; se cierra con `plano_reply`, timeout o muerte de un extremo. **Nada de temporizadores sueltos que dejen líneas fantasma** — si un panel se cierra, sus enlaces se van con él.
- Varias relaciones entre el mismo par se agrupan en **una sola línea** con un contador, no diez curvas superpuestas.
- Dirección visible: el pulso va de emisor a receptor.

**Restricciones de rendimiento (medidas en este repo, no negociables):**
- Ninguna custom property heredada en un ancestro de los paneles. Coste medido de violarlo: **424 ms vs 13 ms** de recalc por gesto.
- Cero re-render de React por frame: la animación es CSS; las posiciones se leen con `viewportController.getLive()`.
- `MeshLinkLayer` ya está partido en dos para no suscribirse al registro de paneles cuando no hay enlaces — **mantener esa separación** al añadir estados.
- Respetar `reduceMotion`: sin animación, línea estática.

---

## 3. Robustez transversal

Estas reglas aplican a todo lo anterior. Son las que convierten "funciona en la demo" en "funciona".

1. **Ninguna promesa sin `catch` en el daemon.** Ya hubo un caso real: `JSON.stringify(undefined)` → `Buffer.byteLength(undefined)` lanzaba y **mataba el daemon entero** con todas las terminales. Auditar cada `void promise.then(...)` de `mesh/`.
2. **Toda herramienta devuelve un resultado tipado**, nunca lanza. `{ok:false, error, detail}` con un catálogo cerrado de errores y un mensaje accionable.
3. **Toda rama tiene sentido** (petición explícita del usuario): para cada herramienta, enumerar los casos destino-no-existe / destino-ocupado / destino-muerto / sin-consentimiento / rate-limit / no-soportado / timeout, y que **cada uno devuelva algo distinto y comprensible**. Prohibido `ok:false` genérico.
4. **Idempotencia**: reenviar el mismo `messageId` no duplica la entrega.
5. **Limpieza al morir**: al salir un PTY → revocar token, cerrar correlaciones abiertas con `peer-exited`, vaciar su buzón, quitar sus enlaces.
6. **Observabilidad**: cada mensaje deja rastro en el timeline con estado final. Si algo falla, tiene que poder verse **por qué** sin abrir un debugger.
7. **Presión**: caps ya existentes (`MAX_HOPS`, broadcast, rate-limit) + cola de entrega acotada por destino.

---

## 4. Pruebas

`npm run typecheck` es la única puerta automática del repo: verde en cada bloque.

### Unitarias
- Normalización: un texto con `\n` internos produce **un solo** `\r`.
- `AgentState`: un tail que solo repinta un spinner → `idle`; contenido que cambia → `working`; patrón de permiso → `awaiting-input`.
- TTL y caducidad; idempotencia por `messageId`; sin re-entrega tras reinicio.
- `plano_set_model` rechaza `gpt-5; rm -rf /`, saltos de línea y harness no soportado.
- Correlación: `plano_reply` cierra; timeout devuelve `inferred`.

### E2E (patrón ya establecido en `.plano-tests/`)

| Caso | Comprueba | Criterio |
|---|---|---|
| R1 | **Enter real** | `plano_send` a un shell con `echo hola` → el comando **se ejecuta** (verificar por archivo en disco, no por buffer: xterm es WebGL) |
| R2 | **busy honesto** | Claude+Codex ociosos 60 s → `state: idle` ≥95 % del tiempo |
| R3 | **entrega bajo carga** | destino trabajando → encola → al acabar, se entrega **una sola vez** |
| R4 | **ask/reply** | A pregunta, B responde → A recibe el texto de B |
| R5 | **ask con timeout** | B no responde → A recibe `inferred` con el tail de B, no un cuelgue |
| R6 | **delegación por visión** | agente sin visión → `plano_find('vision')` → `plano_ask` → recibe la descripción |
| R7 | **cambio de modelo** | `plano_set_model` sobre harness soportado cambia y **se verifica leyendo**; sobre no soportado da `unsupported-harness` |
| R8 | **enlaces** | relación abierta → línea persistente; cierre → desaparece; panel cerrado → sin líneas fantasma |
| R9 | **caos** | matar un agente a mitad de `ask`, matar el daemon, reiniciar → sin mensajes duplicados ni perdidos silenciosamente |
| R10 | **perf** | 6 agentes con enlaces activos mientras se panea → recalc de estilo equivalente a sin enlaces, 0 long tasks |

**Aislamiento obligatorio:** `PLANO_USER_DATA_DIR` temporal único, puerto CDP único, fixtures desechables, acotar procesos por PID/puerto — **nunca** matar por nombre de imagen.

**Gotchas ya pagados en este repo** (no volver a tropezar):
- El `ev()` de los probes debe leer `r.result.exceptionDetails`, no `r.exceptionDetails`; si no, las excepciones se tragan y un `Error` serializado llega como `{}`.
- El texto de la terminal **no está en el DOM** (WebGL): verificar por archivo o por el buffer del daemon.
- El daemon se apaga al quedarse sin clientes: un probe debe mantener un socket vivo.
- La primera escritura del workspace **bloquea esperando el toast de consentimiento**: lanzar la llamada sin `await`, pulsar Allow, y entonces recoger.

### Prueba de aceptación manual
Un Claude y un Codex abiertos. Al Claude: *«Pídele al Codex que liste los tests y espera su respuesta.»* Debe: verlo en el roster → enviarle la orden **que se ejecuta** → la línea queda visible mientras espera → recibir la respuesta → resumirla. Sin tocar nada más.

---

## 5. Orden de ejecución

1. **A1** (`\r`) — una línea, arregla el síntoma principal. Verificar R1 **antes de seguir**.
2. **A2** (busy honesto) — sin esto todo sigue encolándose. Verificar R2.
3. **A3 + A4** (buzón y confirmación). R3.
4. **B** (estado + `plano_status`).
5. **C** (ask/reply). R4, R5.
6. **D1** (capacidades + `plano_find`). R6.
7. **D2** (modelo/interrupt), con la validación de inyección desde el primer commit. R7.
8. **E** (enlaces persistentes). R8, R10.
9. **Sección 3** (robustez transversal) + R9.

**No saltar de A a E.** Una línea bonita sobre una entrega que no ejecuta es exactamente el estado actual.

---

## 6. Invariantes

- Escribir a un PTY es **ejecutar código en la máquina del usuario**: validar y normalizar siempre; el consentimiento por workspace no se elimina.
- La redacción sigue siendo obligatoria en todo lo que salga de un agente.
- Un agente nunca declara su propio `from`: la identidad sale del token.
- Las terminales no se desmontan nunca por lógica del mesh.
- Nada en el mesh puede impedir que arranque el Agent Host ni tumbarlo.
- Diseño con tokens, UI en inglés, sin texto de relleno.
- Varios agentes editan este repo a la vez: releer antes de editar.
