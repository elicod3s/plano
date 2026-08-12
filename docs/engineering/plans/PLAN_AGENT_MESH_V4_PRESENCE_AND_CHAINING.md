# PLAN — Mesh v4: presencia visual estilo Apple + encadenado de trabajo

**Estado:** plan de ingeniería, listo para que otra IA lo ejecute
**Punto de partida:** Mesh v3 ya funciona — 20 herramientas MCP, identidad por token, entrega visible con `\r`, estado real (`idle`/`working`/`awaiting-input`/`error`/`exited`), `ask`/`reply` con correlación, capacidades, control de modelo y enlaces persistentes (`active`/`waiting`/`done`/`failed`) en `MeshLinkLayer`.
**Objetivo:** dos cosas, y las dos tienen que sentirse **sólidas**, no decorativas.

1. **Presencia visual**: que se vea de un vistazo que los agentes están conectados y qué está pasando entre ellos.
2. **Encadenado**: *«cuando termines este plan, pásaselo a Codex para que lo ejecute»* — programar trabajo que se dispara solo, de forma fiable.

---

## 0. Diagnóstico de lo que falta hoy

El transporte está bien; lo que falla es que **el usuario no puede ver el sistema**.

| Hueco | Consecuencia |
|---|---|
| El enlace solo existe **mientras** hay tráfico | En reposo el canvas parece un montón de terminales sueltas. No se percibe que hay una malla. |
| Un panel no dice si es parte del mesh | No se distingue un agente conectado de una terminal cualquiera hasta que alguien le escribe. |
| Un mensaje encolado es invisible | `mode: queue` entrega "cuando el otro esté libre" — para el usuario, nada ocurrió. |
| `awaiting-input` no se ve en el canvas | El caso más importante (un agente **bloqueado** esperando permiso) parece "trabajando". |
| El timeline existe pero no se muestra | Hay auditoría (`MeshEvent`) sin superficie que la enseñe. |
| **No hay encadenado** | Todo es inmediato. No se puede decir "cuando acabes". |

---

## PARTE A — Presencia visual (estilo Apple)

### Qué significa "estilo Apple" aquí

No es más animación: es **menos, mejor sincronizada y siempre informativa**. Tres reglas que gobiernan todo lo de abajo:

1. **Nada se mueve sin significar algo.** Cada animación corresponde a un evento real del bus. Prohibido el movimiento ambiental.
2. **La quietud es el estado por defecto.** En reposo, la malla se insinúa (líneas tenues, un punto); no compite con el contenido.
3. **Física, no tiempos lineales.** Muelles y curvas de salida (`--ease-settle`), entradas rápidas y salidas suaves. Nada aparece o desaparece de golpe salvo un error.

### A1. La malla en reposo (lo que resuelve "que se entienda que todo está conectado")

Hoy el enlace nace y muere con el tráfico. Se añade un **estado de reposo**:

- Dos agentes que han colaborado en la sesión conservan una línea **de reposo**: opacidad ~0.10, sin pulso, grosor 1. Está, pero no pide atención.
- Al haber tráfico sube a `active` (0.35 + pulso) y vuelve a reposo al terminar, en vez de desaparecer.
- La relación se olvida al cerrarse cualquiera de los dos paneles o al acabar la sesión. **Nunca líneas huérfanas.**

Extender `MeshLink['state']` con `'idle'` y hacer que `linksView()` degrade `active → idle` en vez de eliminar. Cambio pequeño; es lo que convierte paneles sueltos en una malla percibida.

### A2. Insignia de agente conectado

En el header del panel, junto al punto de estado que ya existe: un **glifo de nodo** minúsculo (3-4 px) cuando el agente está en el roster del mesh.

- Presente = "este agente puede hablar con los demás".
- Color: el `--agent-accent` que ya usa el panel. Sin texto, sin badge, sin fondo.
- Tooltip: `Mesh · 3 peers`.

Es la señal de "estoy conectado" más barata posible y la más constante.

### A3. Estados que hoy son invisibles

| Situación | Señal propuesta |
|---|---|
| Mensaje **encolado** para este agente | Contador discreto en el header (`▾2`), con tooltip de quién lo mandó. Desaparece al entregarse. |
| Agente **`awaiting-input`** | El punto de estado **respira** en ámbar. Es el estado que más urge ver: alguien está bloqueado esperándote. |
| Mensaje **entregado** | El destello de borde que ya existe (`useMeshArrival`) — mantenerlo. |
| Entrega **no confirmada** (`written-but-unconfirmed`) | Mismo destello pero **una sola pulsación más tenue**: se escribió, no se sabe si lo aceptó. Honestidad visual. |
| Mensaje **fallido/caducado** | Un solo destello en `--destructive` en el enlace, y entrada en el timeline. Nunca un modal. |

### A4. Dirección y semántica del enlace

El enlace debe decir **qué** está pasando, no solo que pasa algo:

- **Mensaje suelto** (`send`): un pulso viaja emisor → receptor y el enlace vuelve a reposo.
- **Pregunta abierta** (`ask`): el enlace queda `waiting` con el punto respirando en el extremo **del que debe responder**. Es la diferencia entre "te hablé" y "te estoy esperando".
- **Respuesta** (`reply`): el pulso viaja **de vuelta** y el enlace cae a reposo. Ver el retorno es lo que cierra el círculo mentalmente.
- **Encadenado armado** (Parte B): línea **discontinua** hasta que se dispara; al dispararse se vuelve sólida y pulsa. Discontinuo = "esto todavía no ha pasado".

### A5. Vista de malla (overlay)

Extender el `AgentManager` (`Ctrl+Shift+A`, ya existe con el roster cross-workspace) con una segunda pestaña **Mesh**:

- Grafo compacto: un nodo por agente (harness + estado con su color), aristas = relaciones.
- Debajo, el **timeline** que ya se recoge en `MeshEvent[]` y hoy no se enseña: quién escribió a quién, qué se encoló, qué falló.
- Clic en un nodo → salta a ese panel en el canvas (`focusPanel` ya existe).
- Los encadenados armados aparecen aquí como filas pendientes, cancelables.

Es la única superficie nueva de chrome; todo lo demás vive en los paneles y el canvas.

### A6. Restricciones de rendimiento (medidas en este repo, no negociables)

- **Jamás** una custom property heredada en un ancestro de los paneles. Coste medido de violarlo: **424 ms vs 13 ms** de recalc de estilo por gesto.
- Cero re-render de React por frame: animación por CSS; la cámara se lee con `viewportController.getLive()`.
- Mantener la separación ya existente de `MeshLinkLayer`: el componente externo se suscribe **solo** al conjunto de enlaces; el interno (que sí necesita rects vivos) se monta únicamente si hay enlaces. Las líneas de reposo **cuentan como enlaces**, así que hay que medir de nuevo: si un canvas con 10 relaciones en reposo penaliza el paneo, dibujar reposo solo cuando la cámara está quieta.
- `prefers-reduced-motion` y el ajuste de movimiento reducido: sin pulsos ni respiración; los estados se distinguen por opacidad y color.
- Nada de `content-visibility: auto` en superficies del canvas (blanquea contenido en movimiento dentro de la capa escalada).

---

## PARTE B — Encadenado de trabajo

El caso del usuario, literal: *«haz este plan y, cuando termines, mándaselo a Codex para que lo ejecute»*.

### B1. La primitiva

Una sola herramienta nueva, con semántica de **disparador**, no de temporizador:

```
plano_chain({
  to,                       // quién lo ejecuta
  payload,                  // qué se le manda (texto ya resuelto o una referencia, ver B2)
  when: 'i-finish',         // 'i-finish' | 'agent-finishes' | 'i-reply'
  watch?,                   // agente a vigilar cuando when = 'agent-finishes'
  timeoutMs?,               // caducidad (defecto 30 min, tope 4 h)
  onFailure: 'notify'       // 'notify' | 'fire-anyway' | 'ask-user'
}) → { chainId }
```

Y su gestión: `plano_chains()` (listar), `plano_cancel_chain(chainId)`.

`when: 'i-finish'` cubre el caso del usuario: el agente que está redactando el plan arma el encadenado **al empezar**, y el bus lo dispara cuando ESE agente pasa a `idle` de forma estable.

### B2. Qué se manda exactamente (el punto más delicado)

El plan que produce el primer agente **no existe como dato** para el bus: es texto en una terminal. Tres orígenes posibles para el `payload`, en orden de fiabilidad:

1. **Explícito** — el agente pasa el texto al armar o justo antes de terminar (`plano_chain_payload(chainId, text)`). Es el único **fiable** y el que la skill debe enseñar como forma normal.
2. **Un archivo** — `payload: { file: '<ruta>' }`: el primero escribe el plan en disco y el segundo recibe la ruta. **Es el mejor camino para un plan de verdad** y hay que documentarlo como el recomendado: sobrevive a truncados, no depende de la cola de la terminal y el ejecutor puede releerlo.
3. **Inferido del tail** — última opción: la cola limpia y redactada desde que se armó. Se entrega **marcado como inferido**, igual que el `inferred` de `ask` en v3.

**Regla dura:** un `payload` vacío o solo-espacios **no dispara**. Mandar "ejecuta esto: (nada)" es peor que no mandar nada.

### B3. Cuándo se considera "terminado" (aquí se juega la robustez)

Reutilizar el modelo de estado de v3, con una condición estricta:

- Dispara al pasar a **`idle` estable** — sin cambio de contenido durante ~4 s (el `computeBusy` de v3 ya distingue spinner de trabajo real). Un `idle` de un instante entre dos herramientas **no** cuenta.
- **`awaiting-input` nunca cuenta como terminado.** Es exactamente el caso "está bloqueado pidiendo permiso": disparar ahí mandaría un plan a medias. Si se queda ahí más que un umbral, se aplica `onFailure`.
- `error` / `exited` → `onFailure`.
- Timeout global → el encadenado caduca, se avisa y **no** dispara.

`onFailure`:
- `notify` (defecto) — no dispara, avisa en la UI y en el timeline. **La opción segura es la que va por defecto.**
- `fire-anyway` — dispara con una nota del estado en que acabó.
- `ask-user` — toast con Ejecutar / Cancelar.

### B4. Robustez

1. **Persistencia**: los encadenados viven en `<userData>/mesh/chains.json` (temp+rename, mismo patrón que buzones y consentimiento). Sobreviven al cierre de la app; el daemon sigue vivo. Al reiniciar el daemon se recargan y se revalidan: si un extremo ya no existe → `expired` con motivo.
2. **Exactamente una vez**: un `chainId` dispara una sola vez. Estados: `armed → fired | cancelled | expired | failed`, transición atómica.
3. **Sin cadenas infinitas**: un encadenado disparado por un encadenado hereda `hops` (tope 4 de v3). B no puede rearmar hacia A indefinidamente.
4. **Consentimiento**: armar es inofensivo; **disparar es escribir**, así que pasa por el consentimiento por workspace de v3. Si el usuario no lo ha concedido, el disparo espera al toast en vez de fallar en silencio.
5. **Límites**: máx. 8 encadenados armados por agente, 24 por workspace. Superado → error explícito.
6. **Cancelación en cascada**: si muere el agente vigilado o el destino, el encadenado pasa a `failed` con motivo `peer-exited` — el mismo camino que v3 ya usa para cerrar `ask` abiertas.
7. **Visible siempre**: un encadenado armado **se ve** (línea discontinua + fila en la vista de malla). Trabajo programado que no se ve es trabajo que asusta.
8. **Nada puede tumbar el daemon**: como en v3, ninguna promesa sin `catch`; un encadenado roto degrada la función, nunca el Agent Host.

### B5. Lo que la skill debe enseñar

Actualizar `SKILL.md` (ya se instala en `~/.claude/skills/plano-mesh/`) con el patrón recomendado, porque la calidad del encadenado depende de que el modelo lo use bien:

> Para pasar trabajo a otro agente al terminar: **escribe tu resultado en un archivo**, arma `plano_chain({ to, payload: { file }, when: 'i-finish' })` y sigue. No dependas de que se infiera de tu terminal.

---

## Pruebas

`npm run typecheck` verde en cada bloque. E2E siguiendo el patrón de `.plano-tests/`.

### Presencia visual

| Caso | Criterio |
|---|---|
| V1 reposo | Tras un intercambio, la línea **permanece** tenue; al cerrar un panel desaparece (sin fantasmas) |
| V2 insignia | Panel con agente en el roster muestra el glifo; una terminal sin agente, no |
| V3 encolados | `send` en `queue` a un agente ocupado → contador visible; al entregarse, desaparece |
| V4 awaiting-input | Un agente pidiendo permiso muestra el punto ámbar respirando |
| V5 ask/reply | `waiting` con el punto en el extremo correcto; el `reply` viaja **de vuelta** |
| V6 reduced-motion | Con movimiento reducido: sin pulsos, estados distinguibles igual |
| V7 perf | 8 relaciones (mezcla reposo/activo) mientras se panea → recalc de estilo equivalente a sin enlaces, **0 long tasks** |

### Encadenado

| Caso | Criterio |
|---|---|
| C1 feliz | A arma con `when:'i-finish'`, termina → B recibe el payload **una sola vez** |
| C2 idle falso | A queda `idle` 1 s entre herramientas → **no** dispara |
| C3 bloqueado | A queda `awaiting-input` → no dispara; `onFailure: notify` avisa |
| C4 muerte | Matar A armado → `failed/peer-exited`, sin disparo |
| C5 reinicio | Armar, reiniciar el daemon, terminar A → dispara igual (persistencia) |
| C6 payload vacío | Sin payload al terminar → no dispara, motivo claro |
| C7 archivo | `payload: { file }` → B recibe la ruta y puede leerla |
| C8 cancelar | `plano_cancel_chain` → no dispara nunca |
| C9 bucles | Encadenados anidados cortados por `hops` |
| C10 consentimiento | Sin consentimiento, el disparo espera al toast; denegar → no dispara |

**Gotchas ya pagados en este repo** (no volver a tropezar):
- El `ev()` de los probes debe leer `r.result.exceptionDetails`, no `r.exceptionDetails`.
- El texto de la terminal **no está en el DOM** (WebGL): verificar por archivo o por el buffer del daemon.
- El daemon se apaga al quedarse sin clientes: un probe debe mantener un socket vivo.
- La primera escritura de un workspace bloquea esperando el toast: lanzar sin `await`, pulsar Allow, y luego recoger.
- Nunca matar procesos por nombre de imagen: acotar por PID/puerto/user-data.

### Aceptación manual
Con un Claude y un Codex abiertos, al Claude: *«Haz un plan de X en un archivo y, cuando termines, pásaselo a Codex para que lo ejecute.»* Debe: armar el encadenado (línea discontinua visible) → trabajar → al terminar, disparar solo → el Codex recibe la tarea y la ejecuta → la línea pulsa y vuelve a reposo. Sin que el usuario toque nada.

---

## Orden de ejecución

1. **A1 + A2** (reposo + insignia) — es lo que resuelve "se entiende que está conectado", y es barato. Medir V7 aquí.
2. **A3 + A4** (encolados, `awaiting-input`, dirección) — el feedback que falta.
3. **B1 + B3** (primitiva + condición de "terminado") sin persistencia: C1, C2, C3.
4. **B4** (persistencia, límites, cascada, consentimiento): C4–C10.
5. **A5** (vista de malla + timeline), que además es donde se gestionan los encadenados.
6. **B5** (skill).

**No empezar por A5.** Un panel de control bonito sobre un encadenado que dispara cuando no debe es peor que no tenerlo.

---

## Invariantes

- Escribir a un PTY es ejecutar código en la máquina del usuario: el consentimiento por workspace no se elimina, y disparar un encadenado es escribir.
- La redacción sigue siendo obligatoria en todo lo que salga de un agente (también en un payload inferido).
- Un agente nunca declara su propio `from`: la identidad sale del token.
- Las terminales no se desmontan nunca por lógica del mesh.
- Nada del mesh puede impedir que arranque el Agent Host ni tumbarlo.
- Estilo con tokens (`theme.css`/Tailwind), UI en inglés, sin texto de relleno, esquinas redondeadas del sistema. El color, solo como acento con significado.
- Varios agentes editan este repo a la vez: releer antes de editar.
