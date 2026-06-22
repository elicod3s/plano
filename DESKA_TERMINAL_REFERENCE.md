# Referencia: implementación de terminales en Deska

Este documento registra únicamente cómo se inspeccionó la aplicación instalada **Deska** y qué se encontró en su implementación de terminales. No propone cambios para PLANO.

## 1. Aplicación analizada

Deska estaba ejecutándose desde:

```text
C:\Users\Administrator\AppData\Local\Programs\deska\Deska.exe
```

Sus recursos empaquetados están en:

```text
C:\Users\Administrator\AppData\Local\Programs\deska\resources\app.asar
```

El archivo `app.asar` medía aproximadamente 425 MB. También contiene `app.asar.unpacked` y extensiones, pero el código de renderer y la fuente inspeccionada se encontraron dentro de `app.asar`.

## 2. Método de extracción

Se usó la utilidad local `@electron/asar` ya disponible en el entorno de PLANO. No se modificó ningún archivo de Deska.

Listado del ASAR:

```powershell
node .\node_modules\@electron\asar\bin\asar.js list `
  'C:\Users\Administrator\AppData\Local\Programs\deska\resources\app.asar'
```

La lista se guardó temporalmente en `D:\tmp\deska-asar-files.txt` para filtrar rutas sin extraer el paquete completo.

La API de `@electron/asar` requiere rutas internas con separadores inversos (`\`). Por ejemplo, esta lectura funcionó:

```js
const asar = require('@electron/asar')
const source = asar.extractFile(
  'C:/Users/Administrator/AppData/Local/Programs/deska/resources/app.asar',
  'src\\renderer\\panels\\terminal\\terminal-view.tsx',
)
```

La variante con separadores `/` no encontró esos archivos internos.

## 3. Archivos de terminal identificados

Deska distribuye tanto bundles compilados como parte de su fuente TypeScript. Se identificaron, entre otros, estos archivos:

```text
dist\renderer\assets\terminal-view-DgAwTwP8.js
dist\renderer\assets\terminal-view-DgAwTwP8.js.map
src\renderer\panels\terminal\terminal-view.tsx
src\renderer\panels\terminal\hooks\use-render-scale.ts
src\renderer\panels\terminal\hooks\use-terminal-lifecycle.ts
src\renderer\panels\terminal\lib.ts
src\renderer\panels\terminal\data.ts
src\renderer\lib\terminal-registry\registry.ts
src\renderer\lib\terminal-registry\lib.ts
src\main\ipc\shell\terminal-registry.ts
```

También incluye estas dependencias:

```text
@xterm/xterm
@xterm/addon-fit
@xterm/addon-search
@xterm/addon-webgl
node-pty
```

## 4. Estructura del panel de terminal de Deska

`src/renderer/panels/terminal/terminal-view.tsx` crea esta jerarquía relevante:

```text
TerminalPanel
├─ TerminalStatusStrip
├─ TerminalSearchBar (condicional)
├─ .deska-terminal-canvas
│  └─ renderBoxRef (div absoluto)
│     └─ xterm.element (montado por terminalRegistry)
└─ TerminalActionBar
```

La caja `.deska-terminal-canvas` tiene:

```ts
className="deska-terminal-canvas flex-1 relative min-h-0"
style={{ padding: 8, overflow: 'hidden' }}
```

El `renderBoxRef` es un hijo absoluto de esa caja. Su estilo usa un tamaño virtual y una contra-escala:

```ts
{
  position: 'absolute',
  top: 0,
  left: 0,
  width: `${100 * renderScale}%`,
  height: `${100 * renderScale}%`,
  transform: `scale(${1 / renderScale})`,
  transformOrigin: '0 0',
}
```

El panel no abre xterm directamente. Llama a un registro compartido y ese registro adjunta `xterm.element` a `renderBoxRef`.

## 5. Registro persistente de terminales

Deska usa un singleton `terminalRegistry`, indexado por `panelId`.

Hechos observados en `src/renderer/lib/terminal-registry/registry.ts`:

- La instancia de `Terminal` y su PTY sobreviven al desmontaje del componente React.
- `getOrCreate(panelId, ...)` devuelve la instancia existente si sigue viva.
- `detach()` retira el elemento DOM sin destruir terminal ni PTY.
- `attach(panelId, container)` vuelve a colocar el mismo `xterm.element` en el contenedor.
- `dispose()` sí mata el PTY, elimina listeners y destruye los addons y xterm.
- El PTY se crea inicialmente con `80 × 24`; el ajuste real ocurre después de montar xterm en su contenedor final.

La creación de xterm carga:

```ts
const terminal = new Terminal({
  fontFamily: '"Hack", "JetBrains Mono", Menlo, Monaco, "Courier New", monospace',
  fontSize: 12,
  lineHeight: 1.4,
  cursorBlink: true,
  cursorStyle: 'block',
  cursorWidth: 2,
  allowProposedApi: true,
  // scrollback y tema resueltos desde settings
})

const fitAddon = new FitAddon()
terminal.loadAddon(fitAddon)
terminal.loadAddon(new SearchAddon())
```

El código conserva una referencia opcional para `WebglAddon`. El registro intenta cargarlo al abrir o al mover el elemento a otro contenedor y contempla una caída al renderer alternativo si falla.

## 6. Ajuste de tamaño en Deska

La función `safeFit(terminal, fitAddon, container)` se encontró en:

```text
src\renderer\lib\terminal-registry\lib.ts
```

Comportamiento observado:

1. Obtiene una propuesta mediante `fitAddon.proposeDimensions()`.
2. Sale si la propuesta no existe o si filas/columnas no son números finitos.
3. Convierte `cols` y `rows` a enteros y aplica mínimos de 1.
4. Comprueba una posible sobrepasada vertical subpíxel comparando altura de celda, filas y `container.offsetHeight`; si la altura propuesta excede el contenedor en más de 0.5 px, reduce una fila.
5. Llama a `terminal.resize(cols, rows)` solo cuando el tamaño realmente cambia.
6. Llama a `terminal.refresh(0, terminal.rows - 1)` y `terminal.scrollToBottom()` dentro de un `try/catch`.

La fuente incluye este motivo explícito: mantener un único `terminal.resize()` por ajuste evita enviar dos cambios de tamaño rápidos a TUIs como Claude Code, Vim o htop.

En el registro, cuando el terminal se adjunta por primera vez o se mueve entre contenedores, Deska:

1. Ejecuta `terminal.open(container)` directamente sobre el contenedor real.
2. Fuerza un reflow con `void container.offsetHeight`.
3. Programa el fit en el siguiente `requestAnimationFrame`.
4. Si el contenedor todavía mide cero, reintenta hasta cinco frames.
5. Ejecuta `safeFit(...)`, refresca el terminal y restaura scroll si era necesario.

El `ResizeObserver` de `use-terminal-lifecycle.ts` observa el **render box**, no un ancestro genérico. Antes de ejecutar un ajuste:

- compara `clientWidth/clientHeight` con el último tamaño aceptado;
- ignora cambios inferiores a 0.5 px;
- usa un debounce de aproximadamente 32 ms y luego un `requestAnimationFrame`;
- solo vuelve a fijar el scroll inferior cuando la cuadrícula cambió.

El registro conecta `terminal.onResize(({ cols, rows }) => ...)` directamente al IPC de resize del PTY.

## 7. Escala del lienzo en Deska

`use-render-scale.ts` observa el zoom del lienzo y calcula un `renderScale` discreto usando `snapRenderScale(zoomLevel)`.

Cuando cambia esa escala:

1. Espera dos frames de animación para evitar reconstrucciones durante un gesto continuo de zoom.
2. Verifica que el render box sea visible y tenga tamaño distinto de cero.
3. Actualiza `terminal.options.fontSize` a `BASE_FONT_SIZE * renderScale`.
4. Solicita el ajuste del terminal desde el registro.
5. Si el viewport estaba al final, vuelve a colocarlo al final.

La caja virtual aumenta su anchura y altura a `100 * renderScale %` y se contra-escala con `scale(1 / renderScale)`. La fuente comenta que esto permite reconstruir los glifos a una resolución adecuada antes de que el lienzo aplique su transformación global.

## 8. Coordenadas de ratón

El panel llama a:

```ts
useMouseCoordsAdjust(containerRef, zoomLevel, renderScale)
```

La fuente del hook no se inspeccionó en esta sesión. La llamada indica que Deska trata el mapeo del puntero como una preocupación separada del tamaño de cuadrícula y de la escala de render.

## 9. Diferencias observadas respecto a PLANO

Hechos comparativos, sin proponer una acción:

| Aspecto | Deska observado | PLANO durante esta investigación |
| --- | --- | --- |
| Ciclo de vida | Registro persistente por panel | Store de sesiones + hook por panel |
| Montaje DOM | xterm se adjunta a un render box absoluto | xterm se abre en un contenedor React directo |
| Escala de lienzo | Render box virtual y contra-escalado | Transformación CSS del world layer; parche de ratón separado |
| Tamaño | `FitAddon.proposeDimensions()` + un resize | Se probaron varios cálculos y verificaciones posteriores |
| Repaint posterior | `refresh()` y `scrollToBottom()` después del fit | Comportamiento distinto según revisión local |
| Observación de tamaño | Render box, umbral de 0.5 px y debounce | Contenedor/viewport mediante `ResizeObserver` |
| Scrollbar | No se observó en la fuente inspeccionada una regla `scrollbar-gutter: stable` | PLANO había añadido una regla global de gutter durante el diagnóstico |

## 10. Límites de esta inspección

- La fuente de Deska se obtuvo de una instalación local empaquetada; no se verificó contra su repositorio original ni su historial de commits.
- Se inspeccionaron el componente de terminal, el registro, el hook de ciclo de vida, el hook de escala y `safeFit`.
- No se realizó ninguna modificación sobre Deska.
- Este documento no afirma que todos los detalles de Deska sean necesarios o apropiados para PLANO; solo registra lo observado.
