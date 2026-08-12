# PLANO — Plan correctivo de movimiento unitario y jerarquía visual opaca

> Estado: listo para implementación.
> Tipo: addendum correctivo obligatorio del plan `PLAN_OPTICAL_GLASS_UNIFIED_RENDER.md`.
> Alcance: cámara, movimiento de paneles y todas las superficies flotantes del renderer.
> Resultado exigido: cada ventana se mueve como una sola pieza y ningún contenido ajeno se transparenta detrás del chrome, búsqueda, configuración, menús o diálogos.

## 0. Orden para la IA implementadora

No apliques parches aislados únicamente a `TopBar`. El defecto es sistémico y debe corregirse en toda la aplicación.

Implementa dos invariantes globales:

1. **Movimiento unitario:** cada transformación tiene un único propietario y una única responsabilidad. Fondo, borde, cabecera y contenido de una ventana pertenecen al mismo shell visual y nunca se animan por separado.
2. **Oclusión profesional:** toda superficie estructural que pueda pasar por encima de contenido utiliza una base 100 % opaca. La transparencia se permite solo para estados internos colocados sobre un padre que ya sea opaco.

Trabaja con Electron, React, Zustand, Tailwind 3 y CSS actuales. No cambies de framework, no añadas librerías de animación y no reescribas funcionalidades.

Antes de editar, inspecciona `git status` y conserva todos los cambios existentes. Esta copia de trabajo contiene muchas modificaciones del usuario.

---

## 1. Evidencia y diagnóstico actual

### 1.1 El panel se mueve en partes

En la implementación actual de `PanelFrame.tsx`:

- el nodo exterior pinta fondo, borde y sombra;
- `innerRef` contiene cabecera y contenido;
- durante drag, `innerRef.style.transform = rotate(...)` aplica el efecto “gravity lean” solamente al contenido;
- al soltar, solo ese hijo ejecuta una transición de retorno;
- las animaciones `animate-panel-in` y `animate-panel-out` también viven en el hijo, mientras la superficie permanece en el exterior.

Resultado: la placa exterior y el contenido tienen movimiento diferente. El usuario lo percibe como dos ventanas superpuestas o como elementos que “se mueven doble”.

### 1.2 La cámara cambia de propietario

La cámara actual usa un handoff complejo:

- en reposo, cada panel incorpora `--cam-x`, `--cam-y` y `--cam-zoom` en su transform;
- durante pan/zoom, esas variables pasan a identidad y `PanelLayer` recibe la cámara completa;
- al finalizar, la cámara vuelve a transferirse a las variables de cada panel y el transform del mundo pasa a `none`.

Aunque el cambio se intenta realizar en la misma tarea, existen dos modelos geométricos y dos ciclos —React más escritura imperativa— que deben coordinarse perfectamente. Cualquier render intermedio, HMR, gesto superpuesto o callback de settle puede mostrar un frame duplicado o producir un salto.

### 1.3 Las superficies siguen siendo transparentes

La migración óptica quedó incompleta:

- `globals.css` define `.optical-surface` y variantes, pero actualmente ningún `.tsx` las aplica.
- `TopBar`, `Dock`, `ViewControls`, `ContextMenu`, chips y múltiples controles continúan usando `var(--glass)`, `var(--glass-bar)` o `bg-glass`.
- `CommandPalette`, `SettingsModal` y `ConfirmDialog` usan `--optical-raised-base`, pero no la composición completa de la variante raised.
- cabeceras de panel todavía mezclan `--glass-bar` y `--glass-panel` con `transparent`.
- numerosos componentes internos conservan fondos alpha sin una base opaca garantizada.

Los tokens nuevos también mezclan colores opacos con tokens alpha:

```css
--optical-panel-base: color-mix(... var(--bg-base) 80%, var(--surface-1));
--optical-chrome-base: color-mix(... var(--bg-base) 74%, var(--surface-2));
--optical-raised-base: color-mix(... var(--bg-base) 66%, var(--surface-3));
```

Eso produce colores finales con alpha menor que `1`. Peor aún, `raised` puede terminar más transparente que `panel`, invirtiendo la jerarquía visual.

### 1.4 No existe una política global de oclusión

Los `z-index` actuales usan valores independientes (`30`, `40`, `50`, `55`, `60`, `80`, `100`) y las superficies no declaran si deben ocultar completamente lo que existe debajo. Como consecuencia, un panel puede pasar bajo la barra o un modal puede abrirse sobre el canvas, pero su contenido continúa siendo legible detrás de la ventana superior.

---

## 2. Resultado visual obligatorio

La interfaz debe leerse en este orden, sin ambigüedad:

1. Canvas y cuadrícula.
2. Paneles de trabajo.
3. Chrome persistente: barra superior, dock y controles de vista.
4. Popovers, menús y búsqueda.
5. Configuración y diálogos modales.
6. Toasts y avisos críticos.

Una capa superior debe bloquear visualmente los detalles de las capas inferiores. La profundidad se comunica mediante diferencia tonal, bordes, sombras y scrim; no dejando visibles letras, iconos o árboles de archivos a través de la superficie.

El lenguaje seguirá siendo “Optical Monolith”:

- base oscura neutral o tintada según el tema;
- luz superior izquierda muy sutil;
- borde superior claro de 1px;
- sombra de contacto y sombra ambiental;
- radios calibrados;
- sin blur dinámico;
- sin apariencia plana genérica;
- sin transparencia estructural.

---

## 3. Arquitectura definitiva de movimiento

### 3.1 Un propietario permanente para la cámara

`PanelLayer` debe ser el único propietario de la cámara en reposo y durante interacción.

Estructura:

```text
CanvasRoot
└── PanelLayer / world          transform: camera(x, y, zoom)
    ├── PanelAnchor A           transform: translate(panel.x, panel.y)
    │   └── PanelVisualShell    fondo + borde + header + body
    ├── PanelAnchor B
    │   └── PanelVisualShell
    └── DockGroupAnchor
        └── DockGroupVisualShell
```

Responsabilidades:

- `PanelLayer`: pan y zoom global exclusivamente.
- `PanelAnchor`: posición mundial y tamaño de un panel exclusivamente.
- `PanelVisualShell`: material, borde, sombra, cabecera, contenido y animaciones de entrada/salida como una sola pieza.

Eliminar de los paneles:

- `--cam-x`, `--cam-y`, `--cam-zoom`;
- composición individual de la cámara;
- cualquier transformación global duplicada.

El transform permanente de `PanelLayer` debe ser:

```css
transform: translate3d(cameraX, cameraY, 0) scale(cameraZoom);
transform-origin: 0 0;
```

En reposo React refleja la cámara estable. Durante interacción `ViewportController` actualiza **ese mismo transform** imperativamente por `requestAnimationFrame`. Al terminar solo sincroniza Zustand y retira `will-change`; no mueve la cámara a otro nodo y no escribe `transform: none`.

### 3.2 Handoff sin cambio geométrico

El flujo correcto:

1. `begin()` copia la cámara del store a `live`.
2. Activa `interacting` y `will-change: transform` en el world.
3. Cada frame actualiza exactamente el mismo `world.style.transform`.
4. `end()` consume el delta pendiente, hace snap de `x/y` a píxel físico y escribe una última vez el transform.
5. Actualiza Zustand con esos mismos valores.
6. React re-renderiza el mismo transform, sin cambiar de representación.
7. Dos frames después se retira únicamente `will-change`/`interacting`.

No debe existir un instante en que la cámara se aplique en el world y además en cada panel, ni un instante en que no se aplique en ninguno.

### 3.3 Movimiento local del panel

El `PanelAnchor` recibe solo:

```css
transform: translate3d(panelX, panelY, 0);
width: panelWidth;
height: panelHeight;
```

Durante drag:

- se modifica únicamente `panelX/panelY` del anchor;
- fondo, cabecera, iconos, controles y contenido permanecen dentro del mismo `PanelVisualShell`;
- no se aplica rotate, scale, skew, parallax o delay a hijos;
- el panel sigue exactamente al cursor, sin spring durante el gesto.

Eliminar completamente:

- `dragTilt`;
- `lastMove` si solo alimenta el tilt;
- `settleTiltTimer`;
- `innerRef.style.transform = rotate(...)`;
- transición elástica de retorno del tilt;
- `will-change: transform` en el contenido interno durante drag.

Si se desea feedback premium al agarrar un panel, usar solamente:

- cursor `grabbing`;
- cambio sutil de sombra o borde del **shell completo**;
- opcional aumento de elevación sin modificar geometría.

### 3.4 Entrada, salida y snap

Las animaciones de panel deben incluir material y contenido juntos:

- `PanelAnchor` maneja posición/snap.
- `PanelVisualShell` maneja entrada/salida.
- El shell contiene y pinta absolutamente toda la ventana.

Entrada sugerida: `opacity 0 → 1` y `scale(0.985) → scale(1)` durante `160–200ms`.

Salida sugerida: `opacity 1 → 0` y `scale(1) → scale(0.985)` durante `140–180ms`.

No dejar una placa exterior estática mientras el contenido entra o sale. El borde y la sombra forman parte del shell animado.

El snap/auto-arrange puede animar el `PanelAnchor` completo con `transform` y tamaño durante una ventana breve. No debe animar hijos individualmente. `prefers-reduced-motion` elimina estas transiciones.

### 3.5 Grupos, regiones y labels

Aplicar el mismo contrato a `DockGroupFrame`:

- camera solo en world;
- posición solo en group anchor;
- material y panes completos en group shell.

Regiones y labels pueden tener estilos propios por ser anotaciones del canvas, pero heredan únicamente la cámara del world. No deben volver a incorporar variables de cámara individuales.

---

## 4. Política global de opacidad y visibilidad

### 4.1 Regla de oclusión

Toda superficie que pueda superponerse a contenido no relacionado debe terminar sobre un color base con alpha `1.0`.

Superficies estructurales 100 % opacas:

- paneles y grupos;
- barra superior;
- dock lateral;
- controles de vista;
- command palette/búsqueda;
- settings;
- context menu;
- menús de workspace/folder/agents/time;
- confirmaciones y terminal close dialog;
- agent control center;
- last prompts overlay;
- toasts;
- minimap si cubre contenido vivo;
- cualquier popover o dropdown.

La ilusión de cristal se logra con `background-image` —gradientes transparentes de iluminación— colocado sobre un `background-color` completamente opaco.

Patrón obligatorio:

```css
.surface {
  background-color: var(--surface-opaque-token); /* alpha = 1 */
  background-image:
    radial-gradient(... rgba(..., 0.04), transparent ...),
    linear-gradient(... rgba(..., 0.03), rgba(..., 0));
}
```

Aunque los gradientes contengan zonas transparentes, la última base sólida impide ver contenido ajeno.

### 4.2 Transparencia permitida

Se permite alpha únicamente para elementos internos cuya superficie padre ya es opaca:

- hover de una fila dentro de un menú;
- selección dentro de settings;
- botones ghost;
- divisores;
- focus rings;
- tintes de agente/estado;
- highlight de cabecera;
- scrim modal, porque detrás existe además una ventana modal opaca.

Ejemplo válido: una fila con `rgba(255,255,255,.06)` dentro de Settings opaco.

Ejemplo inválido: Settings completo con alpha `.7` directamente sobre un panel de Files.

### 4.3 No usar alpha de ancestro

- Nunca `opacity < 1` en top bar, modal, panel, menú o popover.
- Para animar entrada/salida se tolera opacity temporal solo en el shell completo y solo durante la animación deliberada; una vez abierto debe ser `1`.
- No usar `mix-blend-mode` en texto o superficies estructurales.
- No usar `backdrop-filter` para compensar una base transparente.

---

## 5. Nueva jerarquía de tokens

Reemplazar los tokens estructurales actuales por colores opacos derivados del tema.

Tokens mínimos:

```css
--layer-canvas-bg;
--layer-panel-bg;
--layer-panel-header-bg;
--layer-chrome-bg;
--layer-popover-bg;
--layer-modal-bg;
--layer-inset-bg;
--layer-control-hover;
--layer-control-active;
--layer-edge;
--layer-edge-strong;
--layer-highlight;
--layer-shadow-contact;
--layer-shadow-ambient;
--layer-shadow-modal;
```

Requisitos:

- Los primeros siete backgrounds estructurales deben resolver a alpha `1`.
- No mezclar un color opaco con `--surface-*` alpha para crear la base.
- Mezclar colores opacos entre sí: `bg`, `base`, blanco/negro opaco o `accent` opaco en proporciones bajas.
- `popover` debe ser al menos tan opaco y ligeramente más elevado que `chrome`.
- `modal` debe ser la superficie más firme de la jerarquía.
- Los temas claros también deben producir alpha `1`.
- Agregar las claves a `THEME_VAR_KEYS` o derivarlas mediante expresiones root que solo dependan de tokens opacos. Elegir una estrategia y aplicarla consistentemente.

Orientación para Frost oscuro:

| Capa | Referencia tonal aproximada | Alpha |
|---|---:|---:|
| Canvas | `#0a0b10` | 1 |
| Inset | `#0c0e14` | 1 |
| Panel | `#141720` | 1 |
| Panel header | `#181b25` | 1 |
| Chrome | `#191c26` | 1 |
| Popover | `#1c1f2a` | 1 |
| Modal | `#20232f` | 1 |

No copiar obligatoriamente esos hex en todos los temas; conservar el orden perceptual y contraste.

Las clases recomendadas:

```css
.surface-layer {}
.surface-layer--panel {}
.surface-layer--chrome {}
.surface-layer--popover {}
.surface-layer--modal {}
.surface-layer--inset {}
```

Cada clase debe aplicar `background-color`, `background-image`, border y shadow completos. Evitar que los componentes repliquen inline solo una parte del material.

Marcar las superficies con datos para pruebas:

```html
data-surface-layer="panel|chrome|popover|modal|inset"
```

---

## 6. Migración completa por familias

### 6.1 Paneles

Archivos principales:

- `src/renderer/panels/_base/PanelFrame.tsx`
- `src/renderer/canvas/DockGroupFrame.tsx`
- `src/renderer/panels/sticky/StickyNotePanel.tsx`
- cabeceras de terminal y panes.

Acciones:

- implementar anchor + visual shell;
- mover material, borde y sombra al shell;
- eliminar tilt y transforms de contenido;
- sustituir cabecera alpha por `--layer-panel-header-bg` opaco;
- conservar tintes como overlay interno suave sobre base opaca.

### 6.2 Chrome persistente

Archivos:

- `TopBar.tsx`
- `Dock.tsx`
- `ViewControls.tsx`
- `Minimap.tsx`
- `WorkspaceGitChip.tsx`
- `MobileChip.tsx`
- `TimeChip.tsx` en estado cerrado.

Acciones:

- aplicar `surface-layer--chrome` al contenedor exterior;
- eliminar `var(--glass-bar)` como fondo estructural;
- permitir hover alpha solo en botones internos;
- verificar que un Files/Terminal bajo el chrome quede completamente oculto.

### 6.3 Búsqueda y popovers

Archivos:

- `CommandPalette.tsx`
- `ContextMenu.tsx`
- `AgentManager.tsx`
- `TimeChip.tsx`
- `FolderMenu.tsx`
- `SpacesMenu.tsx`
- selects de settings y cualquier dropdown.

Acciones:

- aplicar `surface-layer--popover` al contenedor completo;
- mantener filas internas con hover bajo;
- usar un borde un nivel más fuerte que chrome;
- sombra ambiental suficiente para separar sin halo exagerado;
- no usar `var(--glass-bar)` directamente.

### 6.4 Configuración y ventanas modales

Archivos:

- `settings/SettingsModal.tsx`
- `settings/controls.tsx`
- `settings/sections.tsx`
- `settings/galleries.tsx`
- `ConfirmDialog.tsx`
- `TerminalCloseDialog.tsx`
- `AgentControlCenter.tsx`
- `LastPromptsOverlay.tsx`

Acciones:

- aplicar `surface-layer--modal` al shell principal;
- mantener `var(--scrim)` sobre el canvas con opacidad calibrada;
- rail, search field y secciones se diferencian mediante backgrounds inset/control, no transparencia hacia el canvas;
- el scrim oscurece el contexto; la ventana modal bloquea totalmente el contenido de atrás;
- Settings debe tener separación clara entre header, rail y content.

### 6.5 Toasts y avisos

- usar popover/modal opaco según severidad;
- nunca mostrar letras del canvas atravesando un toast;
- mantener color funcional únicamente en icono, rail o borde.

### 6.6 Design system e interiores

Migrar:

- `Button.tsx`
- `IconButton.tsx`
- `Field.tsx`
- `Toggle.tsx`
- tabs, filtros, filas y controles internos.

Regla: estos componentes pueden usar alpha porque siempre se dibujan sobre un padre opaco. Si alguno puede aparecer directamente sobre el canvas, debe tener una variante `solid` explícita.

### 6.7 Búsqueda exhaustiva

La lista anterior no es suficiente por sí sola. Ejecutar:

```powershell
rg -n "var\(--glass|bg-glass|backdropFilter|WebkitBackdropFilter|backdrop-filter" src/renderer
```

Clasificar cada resultado:

- estructural → migrar a surface layer opaca;
- interno sobre padre opaco → puede conservarse como estado, idealmente renombrado a control token;
- obsoleto → eliminar.

No declarar terminado mientras un menú, modal o chrome exterior siga usando un token alpha heredado.

---

## 7. Stacking y zonas de oclusión

Crear una escala semántica central, por CSS variables o constantes compartidas:

```text
canvas substrate       0
world / annotations   10
snap feedback          20
fixed chrome          100
popover / menu        200
modal + scrim         300
toast / critical      400
```

Requisitos:

- El root de la app usa `isolation: isolate`.
- `PanelLayer` siempre conserva transform y forma un stacking context contenido.
- Los z internos de panel no pueden escapar sobre top bar o modales.
- No usar nuevos valores arbitrarios por componente.
- Portals, si existen, se asignan a una capa semántica.
- El área bajo top bar sigue siendo canvas utilizable; la barra simplemente ocluye correctamente lo que pasa detrás.

No es necesario reservar una franja vacía debajo de la barra. El objetivo es superposición legible, no reducir el canvas.

---

## 8. Movimiento y estética profesional

Una interacción premium no necesita que las ventanas se deformen.

Movimiento permitido:

- seguimiento 1:1 del cursor;
- sombra que aumenta levemente al levantar un panel;
- borde focus más definido;
- snap con easing amortiguado breve;
- entrada/salida del shell completo;
- hover/pressed de controles internos.

Movimiento prohibido:

- inclinación por velocidad;
- parallax entre fondo y contenido;
- iconos/cabecera con retraso respecto al panel;
- spring mientras el usuario todavía arrastra;
- material que cambia al comenzar el movimiento;
- transición simultánea en world y panel para el mismo desplazamiento;
- animar `left/top` para pan o drag.

Curvas:

- interacción directa: sin transición;
- hover: `120–160ms`;
- snap/arrange: `220–280ms var(--ease-settle)`;
- modal/popover: `160–220ms`;
- evitar overshoot/bounce en ventanas de productividad.

---

## 9. Secuencia de implementación segura

### Fase 0 — Línea base

1. Capturar la escena de referencia con Files pasando por debajo de TopBar.
2. Capturar Command Palette, Settings, Context Menu y un diálogo sobre paneles con texto.
3. Grabar o medir pan, zoom y drag de panel.
4. Registrar transforms computed de world, panel exterior e hijos durante cada gesto.
5. Guardar lista de resultados `glass`/alpha actuales.

### Fase 1 — Movimiento sin doble propietario

1. Hacer permanente la cámara en `PanelLayer`.
2. Simplificar `ViewportController` para actualizar siempre el world transform.
3. Retirar variables de cámara de paneles, grupos, regiones y labels.
4. Crear `PanelAnchor` y `PanelVisualShell`.
5. Eliminar gravity lean y transforms internos durante drag.
6. Repetir pruebas de pan/zoom/drag antes de tocar estilos globales.

Puerta: no continuar si existe un frame con cámara doble o si borde/contenido se separan.

### Fase 2 — Tokens realmente opacos

1. Sustituir mezclas con tokens alpha.
2. Crear background-color opaco por cada nivel.
3. Mover gradientes a background-image decorativo.
4. Verificar alpha computed `1` en dark y light themes.

Puerta: todas las variantes estructurales devuelven alpha `1`.

### Fase 3 — Paneles y chrome

1. Migrar PanelFrame y DockGroup.
2. Migrar TopBar, Dock, ViewControls y Minimap.
3. Probar superposición real con paneles debajo.

### Fase 4 — Popovers, búsqueda y settings

1. Migrar Command Palette y Context Menu.
2. Migrar menus de workspace/folder/agents/time.
3. Migrar Settings completo y sus selects.
4. Migrar confirmaciones y overlays.
5. Migrar Toasts.

Puerta: ninguna ventana deja ver letras o iconos de atrás.

### Fase 5 — Interiores y limpieza

1. Reemplazar usos internos `glass` por tokens de control claros.
2. Centralizar z-index.
3. Eliminar clases ópticas nunca utilizadas, tokens obsoletos y comentarios incorrectos.
4. Actualizar `DESIGN_SYSTEM.md` y arquitectura.

### Fase 6 — Build e instalación

1. Typecheck.
2. Build.
3. Package Windows.
4. Actualizar de forma segura la instalación.
5. Abrir y validar el ejecutable instalado.

---

## 10. Pruebas obligatorias

### 10.1 Transform ownership

Durante pan/zoom:

- solo cambia el transform de `[data-world-layer]`;
- los transforms locales de panel permanecen iguales;
- cabecera y body conservan matriz relativa identidad respecto a `PanelVisualShell`.

Durante drag de un panel:

- la cámara no cambia;
- solo cambia el transform de su `PanelAnchor`;
- `PanelVisualShell`, header y body no reciben rotate/scale/translate separados;
- los demás paneles permanecen estáticos.

Al terminar:

- no existe salto de handoff;
- el último delta no se pierde;
- `will-change` se retira;
- un gesto nuevo invalida el settle anterior.

Ejecutar 30 ciclos de zoom y 30 drags rápidos.

### 10.2 Alpha computed

Agregar una comprobación E2E para cada `[data-surface-layer]`:

```js
const bg = getComputedStyle(element).backgroundColor
// parsear color y exigir alpha === 1 para panel/chrome/popover/modal/inset estructural
```

La base opaca debe vivir en `background-color`; los gradientes en `background-image`. Así la prueba no depende de interpretar gradientes.

Probar al menos:

- TopBar;
- Dock;
- ViewControls;
- PanelFrame;
- DockGroup;
- CommandPalette;
- ContextMenu;
- SettingsModal;
- ConfirmDialog;
- AgentManager popover;
- Time popover;
- Folder/Spaces menu;
- Toast.

### 10.3 Prueba visual de oclusión

Colocar deliberadamente un panel con texto blanco y elementos coloridos debajo de cada superficie.

Capturas requeridas:

1. Files bajo TopBar.
2. Terminal bajo TopBar y Dock.
3. Files detrás de Command Palette.
4. Terminal detrás de Settings.
5. Sticky detrás de Context Menu.
6. Paneles detrás de Confirm Dialog.
7. Texto bajo Toast.

Criterio: no puede reconocerse ninguna letra, icono, fila o borde perteneciente a la capa inferior a través de la superficie superior. Solo el scrim alrededor de una ventana modal deja percibir contexto atenuado.

### 10.4 Jerarquía visual

- Panel es más oscuro que chrome.
- Popover se distingue claramente de chrome.
- Modal es la superficie más firme.
- Inset se percibe hundido.
- Header se diferencia del body sin parecer otro panel superpuesto.
- El tema mantiene una dirección de luz constante.
- Focus, hover y pressed son perceptibles sin cambiar layout.

### 10.5 Rendimiento y calidad

- `npm run typecheck`
- `npm run build`
- `git diff --check`
- cero `backdrop-filter` funcional;
- cero render React global por cada evento de wheel/pointer;
- p95 de frame objetivo menor de `20ms` en workspace representativo;
- prueba Windows 100 %, 125 % y 150 % DPI cuando sea posible;
- texto estable a 100 %, 75 %, 50 % y zoom-to-fit;
- xterm, CodeMirror y webview siguen interactivos.

---

## 11. Criterios de aceptación

- [ ] La cámara vive permanentemente en un único world layer.
- [ ] Paneles ya no incorporan variables de cámara.
- [ ] Cada panel tiene anchor de posición y un único visual shell.
- [ ] Fondo, borde, sombra, header y body se mueven juntos.
- [ ] Gravity lean y rotaciones internas fueron eliminados.
- [ ] Entrada/salida anima el shell completo.
- [ ] Todas las superficies estructurales tienen alpha computed `1`.
- [ ] TopBar bloquea completamente los paneles que pasan debajo.
- [ ] Search, Settings, menus y dialogs bloquean completamente contenido inferior.
- [ ] Transparencia interna solo aparece sobre padres opacos.
- [ ] La escala z está centralizada y el app root está aislado.
- [ ] Ningún modal/menu exterior usa directamente `var(--glass*)` o `bg-glass`.
- [ ] El material conserva gradientes, highlight, borders y sombras profesionales.
- [ ] No existe blur dinámico ni cambio de material durante interacción.
- [ ] Pan, zoom y drag pasan pruebas repetidas sin drift, salto o doble movimiento.
- [ ] Typecheck, build y pruebas instaladas pasan.

---

## 12. Prohibiciones

No aceptar como solución:

- subir un poco la opacidad únicamente de TopBar;
- añadir blur para ocultar contenido;
- agregar otro overlay semitransparente detrás de cada ventana;
- conservar el tilt aplicándolo solo al contenido;
- mover también la placa para “sincronizar” dos capas;
- mantener el handoff cámara world ↔ panel y ajustar delays;
- ocultar paneles cuando pasan bajo el chrome;
- añadir `z-index` enormes sin una escala;
- hacer settings opaco pero dejar command palette o menús transparentes;
- sustituir contenido real por thumbnails durante movimiento;
- declarar éxito usando solamente una captura estática.

La solución correcta reduce propietarios, reduce capas y crea una jerarquía visual explícita.

---

## 13. Entrega que debe producir la IA

1. Diagnóstico breve de los propietarios de transform eliminados.
2. Lista de archivos modificados por familia.
3. Tabla de superficies y alpha computed final.
4. Evidencia antes/después de las siete escenas de oclusión.
5. Resultado de 30 ciclos de zoom y drag.
6. Typecheck, build y búsqueda de filtros/tokens obsoletos.
7. Validación del ejecutable instalado.
8. Aplicación instalada abierta con un panel pasando bajo TopBar y Settings/Command Palette verificadas.

El resultado se considera profesional cuando el usuario entiende inmediatamente qué está delante, qué está detrás y qué está moviendo, sin esfuerzo visual.
