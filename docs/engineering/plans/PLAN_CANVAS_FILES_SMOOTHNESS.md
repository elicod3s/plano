# PLAN — Fluidez del canvas y saneamiento del panel Files

**Estado:** plan de ingeniería, listo para ejecutar
**Ámbito:** por qué un panel Files degrada TODO el canvas, y qué falta para que el canvas siga fluido con muchos paneles pesados
**Método:** auditoría estática del código actual (no se ejecutó la app ni se perfiló). Cada hallazgo lleva evidencia `archivo:línea` y un nivel de confianza explícito.
**Predecesor:** [`PLAN_FILES_PERF_FIX.md`](PLAN_FILES_PERF_FIX.md) — sus P0 (watcher nativo, clasificación content/structural, lectura perezosa por directorio, store compartido, CodeMirror persistente) **ya están implementados**. Este plan cubre lo que quedó pendiente de aquel documento (virtualización, límite de concurrencia, autosave semántico) **más cuatro causas nuevas del canvas que aquel plan no vio.**

---

## 1. Resumen ejecutivo

El panel Files ya no es lento por el watcher ni por el árbol eager — eso se arregló. Lo que queda son **cuatro amplificadores nuevos**, y solo uno de ellos vive dentro del panel:

1. **El canvas no tiene aislamiento.** No existe `contain:` ni `content-visibility:` en ningún panel, y no hay culling por viewport: todos los paneles del espacio están montados, con estilo, layout y pintado, estén o no en pantalla. Todo el mundo comparte un único ámbito de estilo/layout dentro de una capa transformada. Un árbol de archivos expandido mete miles de nodos en ese ámbito común, y a partir de ahí **cada recálculo de estilo del canvas cuesta proporcional al panel Files**, no al panel que se movió.
2. **La cámara se publica al store de React 15 veces por segundo DURANTE el gesto** (`publishLowFreq`). Eso re-renderiza `PanelLayer` en mitad del pan/zoom, reescribe el `transform` del mismo nodo que el controlador está escribiendo imperativamente (dos dueños de la cámara), y dispara todas las suscripciones a `useViewportStore` — incluida la de cada CodeMirror, que **escribe `scrollTop` y fuerza un layout síncrono**.
3. **`--layer-zoom` se escribe en la capa mundo y no lo lee nadie.** Es una custom property heredada: cambiarla invalida el estilo de todo el subárbol. Es coste puro, gratis de eliminar.
4. **El filtro del árbol dispara un crawl recursivo sin límite.** Escribir una letra en "Filter files" puede lanzar cientos de `fs.readDirectory` concurrentes contra el proceso main. Main es el mismo proceso que sirve los PTY, la detección de agentes y git: saturarlo congela la app entera, no solo el panel. **Esta es la respuesta más directa a "cuando hay un Files, se buguea todo".**

Los cuatro se componen: (4) llena el árbol de filas → (1) las mete en el ámbito global → (2) y (3) fuerzan recálculo de ese ámbito 15 veces por segundo mientras haces zoom.

---

## 2. Hallazgos

### P0-1 — Sin aislamiento ni culling: el canvas es un único ámbito de estilo/layout

**Confianza: alta.**

- `PanelLayer.tsx:89-95` monta **todos** los paneles del espacio, sin filtrar por viewport.
- No hay `contain:` en ningún estilo del renderer salvo `voice/voice.css:20`; no hay ninguna aparición de `content-visibility` en todo `src/renderer` (verificado por grep).
- `PanelFrame.tsx:519-698` no aplica containment ni al ancla ni al shell.
- La única "hibernación" que existe es por espacio, no por viewport (`app/terminalHibernation.ts`).

Consecuencia: un panel a 20.000 px de la cámara sigue costando estilo, layout y pintado. Y como no hay `contain`, una invalidación en la capa mundo recorre el subárbol completo — con un árbol de archivos expandido, eso son miles de nodos por invalidación.

### P0-2 — La cámara se publica a React durante el gesto (dos dueños del `transform`)

**Confianza: alta en el mecanismo; media en la magnitud visible.**

`ViewportController.publishLowFreq()` (`canvas/ViewportController.ts:224-232`) hace `useViewportStore.setState({x,y,zoom})` cada 66 ms **mientras el gesto está vivo**. Efectos en cadena:

- **a) Dos escritores del mismo `transform`.** El docblock del controlador (`ViewportController.ts:1-15`) declara "ONE permanent camera owner", pero ese `setState` re-renderiza `PanelLayer`, que reescribe `style.transform` desde el store (`PanelLayer.tsx:73`). El valor publicado puede tener hasta un frame de retraso respecto al que el `rAF` acaba de escribir → retroceso de cámara de un frame, 15 veces por segundo. Si el gesto se pausa justo después de un publish, la capa se queda en la posición vieja hasta el siguiente input o hasta `end()`.
- **b) Invalidación de subárbol por zoom** — ver P0-3.
- **c) Layout síncrono forzado por cada editor.** `useCodeMirror.ts:361-371` se suscribe al store completo y, cuando el zoom cambia, llama `pinScroll` → escribe `scroller.scrollTop`/`scrollLeft` (`useCodeMirror.ts:331-337`). Escribir `scrollTop` fuerza un flush de layout. Con N paneles Files abiertos son N layouts síncronos por publish, 15 veces por segundo, mientras haces zoom.
- **d) Trabajo duplicado en el grid.** `GridBackground.tsx:56-63` reescribe `--grid-x/-y/-minor/-major` en un `useLayoutEffect` que ahora corre 15 veces por segundo durante el gesto, sobre las mismas variables que `ViewportController.applyMotionTransform` (`ViewportController.ts:214-221`) ya está escribiendo imperativamente.
- **e)** `Minimap` y `ViewControls` también se re-renderizan a 15 Hz durante todo el gesto (`Minimap.tsx:20-23`, `ViewControls.tsx:13`).

### P0-3 — `--layer-zoom` invalida el subárbol y nadie la lee

**Confianza: alta.**

`PanelLayer.tsx:76` escribe `'--layer-zoom': zoom` en la capa mundo. Un grep sobre `src/**` (ts, tsx, css) devuelve **exactamente una aparición: la propia escritura**. Ningún consumidor.

Es una custom property heredada en el ancestro de todo el mundo: al cambiar de valor, Blink debe recomputar el mapa de propiedades heredadas de todos los descendientes. Con un panel Files expandido dentro, cada notch de zoom paga un recálculo de estilo proporcional al número de filas del árbol. Coste puro por una variable muerta.

### P0-4 — El filtro del árbol lanza un crawl recursivo sin límite ni concurrencia acotada

**Confianza: alta.**

`FileTree.tsx:127` → `const forceOpen = !!filterQuery`. Con filtro activo:

- toda `DirectoryRow` renderiza `expanded = forceOpen || open` (`FileTree.tsx:357`),
- y su efecto `if (forceOpen && dir.status === 'idle') loadDirectory(path)` (`FileTree.tsx:370-372`) pide el directorio,
- los hijos que coinciden con el filtro se renderizan también con `forceOpen`, y repiten el proceso **recursivamente, sin tope de profundidad y sin cola**.

Con una consulta corta y común (`"e"`, `"s"`, `"src"`) el conjunto de directorios coincidentes es enorme, así que se disparan cientos de `window.plano.fs.readDirectory` en paralelo. `FileSystemService.readDirectory` deduplica el **mismo** directorio (`FileSystemService.ts:126-149`), pero no limita directorios distintos: main acaba con cientos de `readdir` en vuelo. Main es también quien bombea `terminal:data`, corre `AgentDetectionService` y sirve git — por eso el síntoma no es "el panel va lento", es "la app entera se atasca".

El propio comentario del código admite el diseño provisional ("P0 keeps the burst bounded by matches + single-flight; a debounced main-process search endpoint replaces this in P1"), pero el límite por coincidencias no acota nada cuando la consulta es corta.

### P0-5 — Sin límite de concurrencia en las lecturas de directorio (también fuera del filtro)

**Confianza: alta.**

`useFileTreeStore.loadDirectory` / `invalidateDirectory` (`stores/useFileTreeStore.ts:142-174`) arrancan un vuelo por directorio sin cola. Un burst estructural del watcher (un agente creando archivos en muchas carpetas) llega como un lote de cambios, `EditorPanel.tsx:227-237` calcula el conjunto de padres afectados y llama `invalidateDirectory` **por cada uno** → N lecturas IPC concurrentes. El plan anterior ya pedía "filesystem concurrency is bounded" y quedó sin implementar.

### P1-6 — El debounce del watcher se muere de hambre y luego inunda

**Confianza: alta.**

`FileWatcherService.scheduleFlush` (`services/FileWatcherService.ts:163-174`) hace `clearTimeout` + `setTimeout(75ms)` en **cada** evento. Con un agente escribiendo de forma continua nunca hay una pausa de 75 ms, así que el flush no ocurre… hasta que el agente para, y entonces sale un lote gigante de golpe → el burst de P0-5. Falta una cota de latencia máxima (flush forzado cada ~500 ms) y un tope de tamaño de lote.

### P1-7 — `emit()` notifica a todas las filas montadas en cada cambio de cualquier directorio

**Confianza: alta.**

`useFileTreeStore.emit()` (`stores/useFileTreeStore.ts:74-76`) recorre un único `Set` global de listeners. Cada `DirectoryRow` y cada `FileRow` montada tiene una suscripción (`useFileTreeDirectory`, `useIsActive`). Con miles de filas y una ráfaga de invalidaciones (cada `invalidateDirectory` produce 2-3 `emit`), son decenas o cientos de miles de llamadas a `getSnapshot` por segundo. Las filas hacen bail-out por identidad, pero el recorrido se paga igual.

Extra: `getSnapshot` **muta** (`record.lastAccess = ++accessClock`, `useFileTreeStore.ts:236`). React puede llamar a `getSnapshot` varias veces por render; un `getSnapshot` con efectos secundarios es impuro por contrato.

### P1-8 — El árbol no está virtualizado

**Confianza: alta.**

`FileTree.tsx:417-439` renderiza recursivamente una fila por entrada expandida. Cada fila es un `<button>` con 2-3 SVG (`fileIcons.tsx` usa `react-icons/si` + lucide) y `transition-colors`. Expandir (o filtrar) un proyecto grande monta miles de nodos permanentes dentro de la capa mundo escalada. Sin virtualización, todos los demás hallazgos escalan con ese número.

### P1-9 — Suscripciones anchas que se re-renderizan en cada frame de arrastre

**Confianza: alta, impacto medio.**

- `Minimap.tsx:20` y `DockGroupFrame.tsx:36` se suscriben al registro `panels` completo → re-render en cada frame de arrastre de cualquier panel. El minimapa además recalcula `boundingBox` sobre todos los paneles (`Minimap.tsx:32-43`).
- `PanelLayer.tsx:37-54` recalcula `Object.values` + 3 filtros + 2 ordenaciones cada vez que cambia el registro `panels`, es decir en cada frame de arrastre, aunque el conjunto y el z-order no hayan cambiado.
- `useWorkspaceStore.markDirty` hace `set({ dirty: true })` sin guarda (`stores/useWorkspaceStore.ts:37`), y `App.tsx:114` lo llama vía `usePanelStore.subscribe(scheduleAutosave)` en cada frame de arrastre → bucle de listeners del store de workspace 60 veces por segundo.

### P2-10 — Superficie muerta

**Confianza: alta, impacto bajo.**

`readTree`/`buildNode` (`FileSystemService.ts:95-114`, `272-298`) están marcados como deprecados y **ningún consumidor del renderer los llama** (verificado por grep: solo aparecen en `registerIpc.ts:483`, `preload/index.ts:122`, `channels.ts:78`, `contracts.ts:667`). Un `readTree` con `MAX_DEPTH = 12` accesible desde el renderer es una escopeta cargada apuntando a main.

---

## 3. Plan de arreglo

### Fase A — Cámara con un solo dueño (arregla el canvas para todos los paneles)

**A1. Sacar la publicación de cámara del store de React durante el gesto.**
En `ViewportController`: eliminar el `useViewportStore.setState` de `publishLowFreq` y sustituirlo por un canal propio, imperativo y throttled:

```ts
// ViewportController
private liveListeners = new Set<(v: LiveViewport) => void>()
subscribeLive(fn: (v: LiveViewport) => void): () => void { … }
private publishLowFreq(): void {
  // 15 Hz, PERO solo al canal live — nunca al store de React.
  for (const l of this.liveListeners) l(this.live)
}
```

`end()` sigue siendo el único que escribe el store. Resultado: durante un pan/zoom, `PanelLayer` **no se re-renderiza ni una vez**, y el `transform` tiene un único escritor.

**A2. Migrar los consumidores informativos al canal live.**
`Minimap` (`Minimap.tsx:21-23`) y `ViewControls` (`ViewControls.tsx:13`) pasan a `subscribeLive` con estado local (o a leer `getLive()` en su propio rAF mientras `interacting`). Son overlays de chrome fuera del mundo: re-renderizarlos no invalida nada del canvas.

**A3. Quitar el `useLayoutEffect` de grid vars durante el gesto.**
`GridBackground.tsx:56-63` solo debe escribir las vars en reposo. Durante el movimiento manda `applyMotionTransform`. Con A1 esto ocurre solo: el efecto deja de dispararse a 15 Hz porque `x/y/zoom` ya no cambian mid-gesture.

**A4. Borrar `--layer-zoom`.**
`PanelLayer.tsx:76`. Si en el futuro hace falta zoom inverso dentro del mundo, se declara con `@property` y se aplica en la hoja concreta que lo consume, nunca en el ancestro de todo.

**Criterio de aceptación de la fase:** durante un pan o un zoom continuo, el `PanelLayer` registra **0 renders de React** (React Profiler), y `style.transform` de `[data-world-layer]` cambia exactamente una vez por frame.

### Fase B — Aislamiento y culling (hace que "muchos paneles pesados" deje de ser un problema)

**B1. Containment por panel.**
En `styles/globals.css`, sobre `.surface-layer--panel`: `contain: layout paint style`.
Esto encierra layout, pintado y recálculo de estilo dentro de cada panel: un árbol de archivos que crece deja de poder invalidar el mundo. Verificar que no rompe: sombras exteriores (`box-shadow` vive en el mismo nodo, no se recorta con `contain: paint` si el shadow es exterior — comprobarlo visualmente), popovers y menús contextuales que hoy escapan del panel (`TreeContextMenu`, `AgentControls`) — si alguno se recorta, ese overlay debe portalarse al chrome, que es donde ya viven los demás.

**B2. Culling por viewport, calculado en el settle.**
Suscribirse a `viewportController.subscribeSettled` (ya existe, `ViewportController.ts:170-173`), calcular en `PanelLayer` qué paneles intersectan el viewport con un margen generoso (p. ej. 1,5 pantallas) y pasar `offscreen` a cada frame. **Nunca por frame — solo al asentar la cámara y cuando cambia el conjunto de paneles.**

**B3. Qué hace un panel `offscreen`.** Tres niveles, de menos a más agresivo, en este orden:
1. `content-visibility: auto` + `contain-intrinsic-size: <w>px <h>px` en el shell. El navegador se salta estilo/layout/pintado del contenido sin desmontar nada. Es reversible, barato y no toca el ciclo de vida de React.
2. Si con eso no basta: no renderizar el `PanelBody` (`PanelFrame.tsx:688`) para paneles lejanos, dejando el marco. **Restricción dura:** las terminales NO se pueden desmontar por esta vía — perderían su sesión xterm/WebGL. Reutilizar el mecanismo de `terminalHibernation.ts` (detach en main + replay al volver) si alguna vez se quiere culling de terminales; hoy, excluir `terminal` y `browser` del nivel 2.
3. Los `<webview>` nunca se desmontan por culling (recrearlos re-navega).

**Criterio de aceptación:** con 30 paneles en el espacio y solo 3 visibles, el tiempo de "Recalculate Style" por notch de zoom debe ser independiente del número de paneles fuera de pantalla.

### Fase C — Files: acotar el I/O (arregla el congelamiento de la app)

**C1. Cola de lecturas de directorio en el store.**
En `useFileTreeStore`: cola con `MAX_INFLIGHT = 4` (ajustable), prioridad para el directorio raíz y los expandidos visibles, y descarte de invalidaciones para directorios que ninguna fila tiene montados.

```ts
const MAX_INFLIGHT = 4
const queue: Array<{ key: string; path: string; generation: number; priority: number }> = []
let inflight = 0
function pump(): void { /* saca por prioridad hasta llenar MAX_INFLIGHT */ }
```

`loadDirectory` e `invalidateDirectory` encolan en vez de llamar a `startFlight` directamente.

**C2. Acotar el filtro.**
Tres cambios en `FileTree.tsx`:
- `forceOpen` solo hasta una profundidad máxima (p. ej. 2 niveles por debajo de la raíz) — pasar `forceOpenDepth` en lugar de un booleano global.
- Tope de directorios auto-cargados por consulta (p. ej. 64); superado el tope, mostrar una fila "Refine the filter" en vez de seguir cargando.
- Longitud mínima de consulta (2 caracteres) antes de forzar expansión; con 1 carácter, filtrar solo lo ya cargado.

Endpoint definitivo (P1 del plan anterior, sigue siendo la solución correcta): `fs:searchTree` en main — debounced, con tope de resultados, tope de profundidad, concurrencia acotada y cancelable. Con eso, `forceOpen` desaparece por completo.

**C3. Cota de latencia máxima en el watcher.**
En `FileWatcherService.scheduleFlush`: además del quiet period de 75 ms, un `maxWaitTimer` que fuerce el flush a los 500 ms desde el primer evento del lote, y un tope de tamaño de lote. Convierte "hambruna + avalancha" en "goteo estable".

**C4. Notificación por directorio, no global.**
`useFileTreeStore`: cambiar el `Set` global de listeners por `Map<key, Set<listener>>`; `setSnapshot`/`optimisticPatch` notifican solo a los suscriptores de esa clave. `useFileTreeDirectory` se suscribe a su propia clave. Además, sacar la mutación `lastAccess` de `getSnapshot` (hacer el touch de LRU en `loadDirectory`/`invalidateDirectory`, que son eventos reales, no lecturas de render).

**C5. Virtualizar el árbol.**
Aplanar las filas expandidas a una lista (`{path, name, type, depth}[]`) derivada del store, y renderizar solo la ventana visible + overscan sobre el scroller que ya existe (`EditorPanel.tsx:490-500`). Conserva: expansión, draft/rename, selección y scroll (ya hay restauración de scroll en `EditorPanel.tsx:424-430`). Al aplanar, C4 se vuelve casi irrelevante: solo las ~40 filas visibles tienen suscripción.

**Criterio de aceptación:** escribir 3 caracteres en el filtro sobre un proyecto de 100k archivos nunca lanza más de `MAX_INFLIGHT` lecturas concurrentes, y el input delay p95 del resto de la app (una terminal escribiendo) se mantiene por debajo de 50 ms durante la operación.

### Fase D — Limpieza de suscripciones

- **D1.** `useWorkspaceStore.markDirty`: `if (!get().dirty) set({ dirty: true })`.
- **D2.** `PanelLayer`: memorizar la categorización sobre una firma barata (ids + z + type + dockedIn) en vez del registro `panels` completo, para que un `move` puro no recompute filtros ni ordenaciones.
- **D3.** `Minimap`: renderizar desde el canal live (A2) y memorizar los rects; hoy recalcula `boundingBox` sobre todos los paneles en cada frame de arrastre.
- **D4.** `DockGroupFrame`: seleccionar solo los paneles miembros (`layout`), no el registro completo.
- **D5.** Autosave: suscribir el guardado al **fin de gesto** (`endGesture` en `PanelFrame.tsx:398`) en lugar de a cada escritura del store de paneles. El debounce ya evita guardados extra; esto elimina 60 llamadas por segundo a `scheduleAutosave`.
- **D6.** `useCodeMirror`: suscribirse con selector de `zoom` (`useViewportStore.subscribe(s => s.zoom, …)` con `subscribeWithSelector`, o comparar antes de trabajar) en vez de al store entero. Tras A1 esto solo dispara en el settle, pero deja la intención explícita.

### Fase E — Superficie muerta (P2)

- **E1.** Retirar `fs:readTree` del contrato, del preload y de `registerIpc` (mantener `buildNode` solo si algún consumidor de main lo necesita). Menos superficie IPC, menos riesgo de que una futura llamada reintroduzca el walk profundo.

---

## 4. Invariantes que este trabajo NO puede romper

Recogidos de `CLAUDE.md` y de los planes previos; cualquier PR que los viole debe rechazarse:

- **Cámara:** un único dueño del `transform` (la capa mundo). `will-change` solo durante el movimiento y **solo** en la capa mundo, nunca por panel.
- **Terminales:** no desmontar una terminal por culling. La sesión (PTY + xterm + WebGL) solo se libera por la vía de `terminalHibernation`, y el PTY solo muere en un cierre explícito.
- **Renderer de xterm:** WebGL con la guarda de pérdida de contexto; no revertir a DOM ni a canvas 2D.
- **Editor:** una sola instancia de CodeMirror persistente por panel; los cambios de archivo intercambian el buffer, no remontan la vista. La guarda de scroll frente al zoom se mantiene.
- **Diseño:** todo estilo nuevo vía tokens (`theme.css` / `tailwind.config.js`); nada de hex sueltos. UI en inglés, sin texto de relleno.
- **Watcher:** `.plano` y los directorios ignorados nunca despiertan al renderer; los eventos `content` nunca provocan lectura de árbol.
- **Concurrencia entre agentes:** varios agentes editan estos archivos a la vez — releer antes de editar.

---

## 5. Verificación

**Puerta obligatoria:** `npm run typecheck` (los dos proyectos) después de cada fase. Es la única automatizada que existe.

**Aislamiento de las pruebas** (regla ya establecida en el plan anterior, no relajarla):
- `PLANO_USER_DATA_DIR` temporal y único por ejecución; puerto CDP único.
- Fixtures desechables fuera del repo vivo; jamás usar el proyecto real para tormentas de escritura.
- No tocar `%LOCALAPPDATA%\Programs\PLANO`. Nunca `taskkill /IM PLANO.exe`: acotar por ruta de ejecutable, puerto CDP o argumento de user-data (patrón de `scripts/plano-motion-e2e.mjs`).
- Recordar la limitación conocida de CDP sin frames (RDP desconectado ⇒ rAF muerto): usar los shims del harness de smoothness.

**Harness:** extender `scripts/plano-smoothness-e2e.mjs` (ya monta un espacio de estrés y mide movimiento) con un escenario Files:

| Caso | Montaje | Qué responde |
|---|---|---|
| S0 | Espacio actual sin Files | Línea base de pan/zoom |
| S1 | + 1 Files con árbol colapsado | Coste del panel en reposo |
| S2 | + 1 Files con ~2.000 filas expandidas | Coste del DOM del árbol (valida B1/B2 y C5) |
| S3 | S2 + filtro de 1 carácter | Reproduce P0-4; tras C2 debe quedar acotado |
| S4 | S2 + tormenta de escrituras de contenido | Debe producir **cero** lecturas de directorio |
| S5 | S2 + ráfaga estructural en 200 carpetas | Valida la cola C1 y la cota C3 |
| S6 | 30 paneles, 3 visibles | Valida el culling B2 |

**Métricas a registrar (p50 y p95, nunca el mejor caso):**
- renders de React de `PanelLayer` durante un gesto → debe ser 0 (Fase A);
- "Recalculate Style" y "Layout" por notch de zoom, con y sin Files expandido → la diferencia debe tender a cero (Fases A+B);
- lecturas `fs:readDirectory` concurrentes máximas → ≤ `MAX_INFLIGHT` (Fase C);
- long tasks > 50 ms en el renderer durante pan/zoom → ninguna;
- input delay p95 en una terminal mientras el árbol trabaja → < 50 ms;
- FPS de pan/zoom en S2 y S6 frente a S0 → dentro del 10 %.

**Verificación funcional (no solo números):** expandir/colapsar/filtrar/seleccionar con scroll preservado; crear/renombrar/borrar reflejado en el padre correcto; el archivo abierto sigue renombrados y se cierra al borrarse; un editor sucio nunca se pisa; dos paneles Files sobre la misma raíz comparten watcher y caché; el zoom no mueve el scroll del editor; las terminales sobreviven a un pan que las saca de pantalla y vuelve.

---

## 6. Orden de ejecución

1. **A4** (borrar `--layer-zoom`) — una línea, sin riesgo, medir antes/después.
2. **A1 + A2 + A3** (dueño único de la cámara). Medir: renders de `PanelLayer` durante el gesto → 0.
3. **B1** (containment). Revisar visualmente sombras, menús contextuales y overlays de los paneles.
4. **C2 + C3** (acotar filtro y watcher) — son los que eliminan el congelamiento duro de la app.
5. **C1** (cola de lecturas).
6. **B2 + B3** (culling por viewport, empezando por `content-visibility`).
7. **C5** (virtualización del árbol) y **C4** (notificación por directorio, o su retirada si C5 la vuelve innecesaria).
8. **D1–D6** (limpieza de suscripciones).
9. **E1** (retirar `readTree`).
10. Repasar todas las métricas de la sección 5 sobre el fixture grande; volver a correr `npm run typecheck` y el harness completo.

Cada paso se mide por separado. La condición de éxito no es "va más rápido de media": es que **el coste de un gesto de canvas deje de depender de si hay un panel Files abierto y de cuántas filas tiene**.
