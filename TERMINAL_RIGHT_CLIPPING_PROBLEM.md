# PROBLEMA: la terminal se corta por la derecha

> Documento de **descripción del problema** para que otra IA lo resuelva.
> Aquí **NO** se propone ninguna solución ni arreglo: solo se describe el síntoma,
> el entorno, el código actual y las evidencias recogidas.

---

## 1. Síntoma

En la app **PLANO** (IDE de lienzo infinito hecho en Electron), los paneles de
**terminal** (xterm.js) **recortan el contenido por el borde derecho**. El texto
que llega al lado derecho aparece **cortado a mitad de carácter**; nunca queda un
margen derecho limpio y estable como en una terminal nativa (Windows Terminal,
VS Code integrated terminal, etc.).

El usuario lo describe así: *"siempre se corta a la derecha, por más grande que
haga el panel"*, y pide que la terminal sea **responsiva y se vea natural**, sin
recortes.

### Lo que se ve en las capturas aportadas por el usuario

- **Caso A (sesión de un agente / TUI, p. ej. Claude Code):** la barra azul
  `ctrl+y to r…`, la línea `D:\Tools\zakra-auto-model · (m…` y la caja de entrada
  `/copy to clipbo…` aparecen **cortadas** por la derecha. A la derecha del corte
  hay una franja oscura + la barra de desplazamiento.
- **Caso B (salida de texto normal con fuente grande):** líneas de prosa como
  `con gracia: si falta u…` y `o de entrada con BOM qu…` se ven **cortadas a
  mitad de palabra**, mientras que una **tabla ASCII** (`| Dinámico |`,
  `| Atenuado |`, con borde derecho `|`) **sí cabe completa**. El usuario rodeó
  con un recuadro rojo la franja derecha "perdida": es una zona vertical oscura
  que contiene la barra de desplazamiento (gutter) y algo de espacio, del ancho
  aproximado de esa franja.
  - Detalle importante del Caso B: en esa captura la **fuente se ve más grande y
    en negrita** de lo normal → el usuario había hecho **zoom de fuente con
    Ctrl + +** dentro de la terminal.

**Interpretación de los síntomas (hechos, no solución):** que las líneas de
prosa (que ocupan el ancho completo) se corten mientras una tabla más estrecha
cabe indica que **el número de columnas del terminal es mayor que el que cabe en
el área visible** (es decir, el "screen" renderizado es más ancho que el
viewport y `overflow` lo recorta).

---

## 2. Entorno y arquitectura relevante

- **Electron 33** (Chromium 131), Windows 11. Renderer en React + Zustand.
- Terminal: **`@xterm/xterm` v5.5.0** con el **renderer DOM por defecto**
  (NO WebGL, NO canvas — decisión intencionada del proyecto).
- Addon de ajuste: **`@xterm/addon-fit`** (FitAddon).
- La terminal vive **dentro de un contenedor del lienzo con
  `transform: scale(zoom)`** (lienzo infinito tipo pizarra). El `zoom` de la
  cámara puede ser **fraccionario** (se han observado valores como 0.496, 0.576,
  0.861, 1.913, 3.000).
- Barra de desplazamiento **personalizada** vía `::-webkit-scrollbar` de **10px**
  de ancho, y `.xterm-viewport { scrollbar-gutter: stable; }` para reservar
  siempre ese hueco.
- El proceso real del shell vive en **main** (node-pty / ConPTY). El renderer le
  manda el tamaño (cols/rows) por IPC.

### Modelo de cajas de un panel de terminal

```
PanelFrame (chrome del panel, esquinas redondeadas)
└─ contenedor (div con ref, overflow:hidden, padding: 8px 6px 4px 10px)   ← TerminalPanel.tsx
   └─ .xterm (term.element, ocupa el content-box del contenedor)
      ├─ .xterm-viewport   (overflow-y:scroll; scrollbar-gutter:stable; ancho = .xterm)
      └─ .xterm-screen     (ancho = cols × cellWidth; es lo que se recorta si excede el viewport)
```

El recorte ocurre cuando `.xterm-screen.offsetWidth > .xterm-viewport.clientWidth`
(el `overflow-x: hidden` del viewport, de la CSS propia de xterm, corta la parte
derecha del screen).

---

## 3. Archivos implicados

- `src/renderer/panels/terminal/useXterm.ts` — **núcleo del problema**. Monta
  xterm, crea/recupera el PTY, calcula el tamaño (`safeFit`), lo coalesce en
  `requestFit`, observa el redimensionado con un `ResizeObserver`, y reenvía el
  tamaño al PTY. También aplica el zoom de fuente por terminal.
- `src/renderer/panels/terminal/TerminalPanel.tsx` — el `div` contenedor con
  `padding: '8px 6px 4px 10px'` y `overflow-hidden`.
- `src/renderer/styles/globals.css` — reglas `::-webkit-scrollbar` (10px) y
  `.xterm-viewport { scrollbar-gutter: stable; }`.
- `src/renderer/panels/terminal/canvasZoomMouse.ts` — parche para que el ratón
  cuadre con el `transform: scale(zoom)` (no afecta al ancho, pero documenta que
  la terminal está dentro de un contenedor escalado).
- `src/main/services/PtyManager.ts` — `resize(ptyId, cols, rows)` reenvía
  **tal cual** (con `Math.max(2,cols)`, `Math.max(1,rows)`) a node-pty. No hay
  ningún redimensionado independiente en main: **el PTY siempre recibe las cols
  que manda el renderer.**
- `src/renderer/canvas/PanelLayer.tsx` + `src/renderer/stores/useViewportStore.ts`
  — dónde se aplica el `transform: scale(zoom)` del lienzo.

---

## 4. Cómo calcula el tamaño actualmente (comportamiento de hecho)

En `useXterm.ts`:

- `cellWidth()` lee el ancho de celda medido por xterm:
  `term._core._renderService.dimensions.css.cell.width` (acceso interno,
  protegido, fijado a 5.5.0).
- `safeFit()`:
  1. Si el contenedor mide 0 → sale.
  2. `fit.fit()` (FitAddon).
  3. Lee `.xterm-viewport` (`clientWidth` ya excluye el gutter de 10px).
  4. Si `cellWidth()` es nulo → sale.
  5. Calcula `cols = floor((viewport.clientWidth − 12) / cellWidth)` y, si cambió,
     `term.resize(cols, term.rows)`. (El `−12` es un margen reservado introducido
     en un intento previo; ver §6.)
- `requestFit()`: agrupa los reflows en un `requestAnimationFrame`; tras
  `safeFit()`, si `cols/rows` cambiaron respecto al último valor enviado, llama
  `window.plano.terminal.resize(ptyId, term.cols, term.rows)`.
- `ResizeObserver`: observa el **contenedor** y el **`.xterm-viewport`**; en cada
  cambio llama `requestFit()`.
- Recolocación al volver de otro "space" (reattach) y al crear el PTY: ambos
  llaman a `safeFit()` y mandan `term.cols/rows` al PTY.
- **Zoom de fuente por terminal (Ctrl + / Ctrl −):** está en
  `attachCustomKeyEventHandler`. Cambia `TerminalProps.fontSize` (override por
  panel, persistido), y una suscripción (`applyTerminalOptions`) hace
  `term.options.fontSize = …` y luego `requestFit()`.

---

## 5. Evidencia de diagnóstico recogida en ejecución (dev, instrumentado)

Se instrumentó `safeFit`/`requestFit` para volcar, en cada fit y cada 1.5s, las
medidas reales (todas en px de layout, sin escalar): `container.clientWidth`,
`.xterm-viewport.clientWidth/offsetWidth`, `.xterm-screen.offsetWidth`,
`cellWidth()`, `cols`, las cols enviadas al PTY, `fontSize`, si está en modo
agente, y si hay recorte (`screen.offset > viewport.client`).

**Resultado en el entorno de desarrollo: NUNCA se reprodujo el recorte.**

- Estado normal (fontSize=13):
  `viewport.client=1220, screen.offset=1201, cols=154, cell=7.7987 → over=−19
  (margen de 19px), CLIP=no`.
- Variando el **zoom del lienzo** entre 0.496, 0.576, 1.913 y 3.000: las medidas
  de layout (`container`, `viewport.client`, `screen.offset`, `cols`) **no
  cambian** y sigue `CLIP=no`. (El zoom es solo un `transform` CSS; no afecta a
  esas medidas.)
- Con **modo agente activo** (`agent=true`): igual, `CLIP=no`.
- **Simulando Ctrl + +** (subir la fuente a 26 con `term.options.fontSize=26` +
  `requestFit()`, igual que hace el código real): `cell` pasó a 15.5974,
  `safeFit` redujo `cols` de 154 a 77, `screen.offset` se mantuvo en 1201 (≤1220)
  y `CLIP=no` tanto al instante como a +300ms y +1200ms. El PTY recibió 77.

**Conclusión de la evidencia (hecho, no solución):** con la instrumentación, en
dev, `screen.offset` **siempre** queda por debajo de `viewport.clientWidth`
(margen ~19px), incluso tras zoom de lienzo, modo agente y zoom de fuente. Sin
embargo, **la app instalada (build de producción) SÍ recorta visiblemente** en
uso real (sobre todo con fuente ampliada y/o dentro de una TUI de agente como
Claude Code).

➡️ **La contradicción central a resolver:** el corte que ve el usuario en la app
real **no se reproduce** con esta medición en dev. Esto implica una de estas
posibilidades (todas por verificar; NO son soluciones):

- El corte aparece en un **estado/secuencia no reproducido** en la sesión de dev
  (p. ej. una TUI en buffer alternativo que **no se repinta** tras un resize; una
  combinación concreta de resize + zoom de lienzo + cambio de fuente; varios
  resizes rápidos; volver de otro "space"; etc.).
- La medición usada (`screen.offset` vs `viewport.client`) **no captura el
  mecanismo real** del recorte que ve el usuario.
- Hay **diferencia entre dev y el build de producción** (p. ej. ausencia de
  StrictMode, distinto orden de carga de fuentes, etc.).

---

## 6. Intentos ya realizados que NO resolvieron el problema

> Se listan solo como **historial de hechos**, para que no se repitan; no son
> sugerencias.

1. `.xterm-viewport { scrollbar-gutter: stable; }` para que `clientWidth` excluya
   siempre el gutter de 10px. (Confirmado que funciona: `viewport.client` =
   `viewport.offset − 10`.) **No eliminó el recorte real.**
2. Recalcular columnas desde `floor(viewport.clientWidth / cellWidth)` en vez de
   confiar en FitAddon. **No eliminó el recorte real.**
3. Un bucle que encogía columnas mientras `.xterm-screen.offsetWidth >
   viewport.clientWidth`. **Resultó ser código muerto:** `.xterm-screen.offsetWidth`
   mide **0** en el momento síncrono en que corre `safeFit` (el screen aún no está
   maquetado), así que el bucle nunca se ejecuta.
4. Reservar un margen: `cols = floor((viewport.clientWidth − 12) / cellWidth)`
   (es el código actual). En dev deja ~19px de margen y `CLIP=no`, pero **el
   usuario sigue viendo el recorte en la app instalada.**
5. Observar también `.xterm-viewport` (además del contenedor) en el
   `ResizeObserver`. **No eliminó el recorte real.**

---

## 7. Hechos adicionales que acotan el problema

- El PTY **siempre** recibe las mismas `cols` que el xterm (verificado en
  `requestFit` y en `PtyManager.resize`). No hay desincronización conocida en el
  envío del tamaño.
- El recorte afecta a líneas que ocupan el **ancho completo**; el contenido más
  estrecho (una tabla) cabe. Es coherente con "screen más ancho que el viewport".
- La fuente del proyecto es `JetBrains Mono` (+ capas de respaldo) cargada por
  webfont (`font-display: swap`); xterm mide la celda **una vez** al abrir y hay
  un re-`fit` cuando `document.fonts` termina de cargar.
- Existe un error recurrente al iniciar (no necesariamente relacionado, pero
  presente): `Cannot read properties of undefined (reading 'dimensions')` desde
  `Viewport.syncScrollArea` (estado momentáneo sin renderer; aparece una vez al
  arrancar; el render final se ve correcto en dev).
- También aparece en consola el error conocido de node-pty en Windows
  (`AttachConsole failed` en `conpty_console_list_agent.js`), que es un problema
  de ConPTY, probablemente no relacionado con el recorte.

---

## 8. Comportamiento esperado

La terminal debe comportarse como una **terminal nativa**:

- El contenido **nunca** debe recortarse por la derecha, **a cualquier tamaño de
  panel y a cualquier zoom de lienzo** (incluido zoom fraccionario).
- Debe ser **responsiva**: al redimensionar el panel o cambiar el tamaño de
  fuente (Ctrl + / Ctrl −), las columnas deben recalcularse y el contenido debe
  reajustarse sin que quede texto cortado.
- Debe quedar un **margen derecho limpio y estable** (que se vea natural), igual
  que en Windows Terminal o la terminal integrada de VS Code.

---

## 9. Cómo reproducir (en la app real)

1. Abrir un panel de terminal en el lienzo.
2. (Según las capturas) ejecutar un CLI de agente a pantalla completa, p. ej.
   Claude Code, o generar salida de texto que ocupe el ancho completo.
3. Hacer **zoom de fuente con Ctrl + +** dentro de la terminal y/o cambiar el
   zoom del lienzo.
4. Observar que las líneas que llegan al borde derecho **quedan cortadas a mitad
   de carácter**, con una franja perdida a la derecha junto a la barra de
   desplazamiento.

> Nota: con la instrumentación en `npm run dev` (ver §5) no se logró reproducir el
> recorte; conviene reproducirlo en el **build de producción** (`npm run dist` →
> instalar) y/o capturar las medidas reales en ese escenario exacto del usuario.
