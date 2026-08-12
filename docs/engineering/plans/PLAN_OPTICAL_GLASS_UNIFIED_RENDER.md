# PLANO — Plan maestro para un cristal óptico unificado, nítido y estable

> **ADDENDUM CORRECTIVO OBLIGATORIO:** después de la implementación parcial de este plan se
> detectaron movimiento compuesto y superficies todavía translúcidas. Antes de continuar, aplicar
> [`PLAN_UNIFIED_MOTION_AND_OCCLUSION_HIERARCHY.md`](./PLAN_UNIFIED_MOTION_AND_OCCLUSION_HIERARCHY.md),
> que reemplaza las decisiones de propiedad de cámara y fija opacidad estructural total.

> Estado: listo para implementación.
> Alcance: renderer de escritorio Electron/React completo.
> Prioridad: estabilidad visual y fluidez antes que blur real.
> Este documento reemplaza cualquier propuesta anterior que separe el vidrio y el contenido en dos capas transformadas.

## 0. Instrucción principal para la IA implementadora

Implementa este plan sobre el código existente, sin reescribir la aplicación ni cambiar React, Tailwind, Zustand, Electron, xterm o CodeMirror. Conserva toda la funcionalidad, el sistema de temas y el contenido real de los paneles.

La decisión de producto ya está tomada:

- PLANO dejará de usar `backdrop-filter` como material visual.
- El aspecto será **cristal óptico estático**: superficie sólida o casi opaca, gradientes suaves, iluminación superior, bordes calibrados y sombras tintadas.
- Cada panel tendrá **una sola caja transformada** que contiene marco, cabecera y contenido.
- El material será exactamente el mismo en reposo, durante pan, durante zoom y después del gesto.
- Todos los paneles, grupos, barras, menús, diálogos y overlays usarán la misma familia de superficies.
- No se ocultará, sustituirá ni cubrirá el contenido real a ningún nivel de zoom.

No intentes conservar el “blur real” parcialmente. Una mezcla de superficies con blur y superficies simuladas vuelve a introducir la falta de armonía que este plan pretende eliminar.

---

## 1. Problema que se debe resolver

La implementación actual contiene dos estrategias incompatibles:

1. En `PanelFrame.tsx` y `DockGroupFrame.tsx`, el vidrio y el contenido son hermanos separados y ambos reciben una matriz de cámara.
2. En `globals.css`, el `backdrop-filter` se apaga durante la interacción y se sustituye temporalmente por otra superficie.

Aunque ambas capas reciben nominalmente el mismo `transform`, Chromium puede promoverlas, rasterizarlas y redondear sus posiciones de forma independiente. En Windows, especialmente con escalado de pantalla fraccional, eso produce:

- desplazamiento aparente entre borde, fondo y contenido;
- pequeños saltos al comenzar o terminar el zoom;
- cambio visible del material al activar o desactivar el blur;
- texto suavizado o rasterizado a una resolución inadecuada;
- coste alto de composición durante pan y zoom;
- diferencias entre paneles, terminal, cabeceras, diálogos y chrome fijo.

El blur dinámico no es una base viable para una aplicación con canvas infinito, múltiples paneles vivos, xterm, CodeMirror y zoom fraccional. La solución profesional es preservar la **percepción** de cristal, no el algoritmo de blur.

---

## 2. Resultado final obligatorio

PLANO debe sentirse como un instrumento de escritorio premium: oscuro, preciso, técnico y coherente. El usuario debe percibir profundidad mediante iluminación y jerarquía, no mediante desenfoque en tiempo real.

Al finalizar:

- Los paneles no se separan visualmente de su contenido al hacer zoom.
- No existe un cambio de material cuando comienza el movimiento.
- El texto conserva la máxima nitidez físicamente posible a cada escala.
- El pan y el zoom usan solo transformaciones baratas del compositor.
- Terminal, editor, navegador, archivos, notas, tareas, pomodoro y grupos comparten el mismo marco.
- Top bar, dock, controles de vista, menús, toasts, diálogos y settings pertenecen a la misma familia visual.
- Las diferencias entre componentes expresan jerarquía o estado, nunca tecnologías de render distintas.
- El contenido real continúa visible incluso a zoom lejano. No se permiten tarjetas de resumen semántico sobre los paneles.

---

## 3. Reglas no negociables

### 3.1 Render

- Cero `backdrop-filter`, `-webkit-backdrop-filter`, `filter: blur()` o filtros SVG en superficies de UI.
- Cero hermanos duplicados que representen el fondo y el contenido de un mismo panel.
- Una sola transformación de cámara por panel o grupo.
- Nunca cambiar fondo, opacidad, borde o sombra en respuesta a `data-viewport-interacting`.
- Nunca animar `left`, `top`, `width` o `height` durante pan/zoom. La cámara usa `transform`.
- No aplicar `opacity` menor que `1` al ancestro que contiene texto; usar colores con alpha en fondos individuales.
- No aplicar `filter`, `perspective` o escalas compensatorias al ancestro de xterm/CodeMirror.
- `will-change` solo mientras exista una interacción o animación concreta; retirarlo al finalizar.

### 3.2 Contenido a distancia

- Mantener montado y visible el DOM real en todos los niveles de zoom.
- No reintroducir `PanelOverview`, placeholders, miniaturas opacas ni `invisible` según el detalle.
- No esconder resize handles, títulos o contenido por nivel de zoom, salvo controles puramente hover que ya funcionen así a escala normal.
- Aceptar el límite físico: un glifo de menos de un píxel no puede ser legible. El objetivo es eliminar degradación artificial, no inventar resolución.
- El comando “Zoom to fit” debe mostrar todos los paneles reales, no representaciones alternativas.

### 3.3 Diseño

- Una única dirección de luz: arriba y ligeramente a la izquierda.
- Una única familia de grises/tintes por tema.
- El color de tema o agente aparece como tinte sutil o borde de estado; nunca reemplaza la base material.
- Destructivo conserva rojo. Los demás colores funcionales pueden aparecer en datos, no en el chrome estructural.
- Radio exterior consistente: panel normal `26px`, sticky `24px`, overlay `20–28px`, controles internos `6–12px`.
- Los elementos internos deben tener radios menores que su contenedor.
- Sombras tintadas hacia el color del canvas, no sombras negras genéricas idénticas en todos los temas.

---

## 4. Dirección visual: “Optical Monolith”

### 4.1 Anatomía de la superficie

Cada superficie elevada debe construirse dentro de **la misma caja** con estas capas CSS, en este orden:

1. **Base opaca o casi opaca:** color derivado del tema, suficientemente sólido para que la cuadrícula no compita con el texto.
2. **Lavado vertical:** la parte superior es entre 2 % y 4 % más luminosa que la inferior.
3. **Luz ambiental localizada:** radial muy tenue desde `18% -12%`, sin animación y sin blur.
4. **Borde exterior de 1px:** visible arriba y laterales; nunca blanco duro uniforme.
5. **Reflejo interior superior de 1px:** simula refracción y define la dirección de luz.
6. **Sombra de contacto corta:** separa la superficie del canvas.
7. **Sombra ambiental larga:** aporta profundidad sin halo exagerado.

Estas capas deben implementarse con múltiples fondos y `box-shadow` en el mismo elemento. Un `::before` interno es aceptable si no tiene transform propio y no contiene filtros; preferir múltiples backgrounds para reducir nodos.

### 4.2 Jerarquía de superficies

Definir cuatro variantes, no estilos ad hoc por componente:

| Variante | Uso | Apariencia |
|---|---|---|
| `panel` | Paneles y grupos del canvas | Base firme, borde sobrio, sombra larga moderada |
| `chrome` | Top bar, dock y controles de vista | Ligeramente más clara, compacta, sombra corta |
| `raised` | Menús, paletas, settings, diálogos y popovers | Más opaca y elevada, borde más definido |
| `inset` | Terminal, campos, editores y zonas hundidas | Más oscura, sin sombra exterior, highlight interior mínimo |

Estados permitidos:

- `hover`: aumenta solo 2–3 % la luminosidad o la fuerza del borde.
- `active/pressed`: reduce 1–2 % la luminosidad y puede usar `translateY(1px)` únicamente en controles, nunca en paneles.
- `focused/front`: borde y sombra suben un nivel; no cambia el fondo completo.
- `agent/status`: borde lateral o ring interior muy tenue usando el color de estado.
- `danger`: rojo funcional exclusivamente en control o confirmación destructiva.

### 4.3 Tipografía y nitidez

- Conservar Space Grotesk para UI y JetBrains Mono para terminal, código y valores numéricos.
- Mantener pesos `500` y `600` para jerarquía sin depender del color.
- Usar `font-variant-numeric: tabular-nums` en zoom, temporizador y métricas.
- No usar sombras de texto, filtros o opacidades de ancestro.
- Usar colores de texto sólidos o alpha directamente en `color`.
- Evitar tamaños inferiores a `11px` en UI normal. Los micro-labels técnicos pueden usar `10.5–11px` con tracking controlado.
- No esperar que `text-rendering: geometricPrecision` arregle un problema de composición. Puede mantenerse si no perjudica, pero no es parte esencial de la solución.

---

## 5. Sistema de tokens propuesto

Modificar `src/renderer/styles/theme.css` y `src/renderer/theme/themes.ts`. El sistema de temas existente debe seguir siendo la fuente de color; ningún componente debe codificar su propia superficie principal.

Agregar una familia semántica equivalente a:

```css
--optical-panel-base;
--optical-panel-top;
--optical-panel-bottom;
--optical-chrome-base;
--optical-raised-base;
--optical-inset-base;
--optical-edge;
--optical-edge-strong;
--optical-highlight;
--optical-shadow-contact;
--optical-shadow-ambient;
--optical-shadow-focus;
```

Requisitos de implementación:

- Añadir las claves nuevas a `THEME_VAR_KEYS`.
- Producirlas dentro de `buildTheme()` para temas oscuros y claros.
- Derivar los valores desde `ThemeInput.bg`, `ThemeInput.base`, `ThemeInput.tint`, `ThemeInput.accent` e `isLight`.
- Los componentes consumen solamente tokens; no deben conocer qué tema está activo.
- Mantener temporalmente los tokens `--glass-*` por compatibilidad durante la migración y eliminarlos solo cuando `rg` confirme que ya no se usan como superficies estructurales.
- Renombrar comentarios y documentación de “real glass/frost blur” a “optical surface”.

Orientación de contraste, no valores rígidos:

- Panel oscuro: 92–97 % opaco respecto al canvas.
- Chrome oscuro: 94–98 % opaco.
- Raised oscuro: 97–100 % opaco.
- Inset oscuro: 6–12 % más oscuro que panel.
- Tema claro: superficies suficientemente opacas para que la cuadrícula jamás atraviese el texto.
- Borde normal: contraste local bajo pero visible.
- Borde focus/front: aproximadamente 1.5× el contraste del borde normal.

Crear utilidades en `globals.css` o una hoja específica pequeña:

```css
.optical-surface { /* geometría común y dirección de luz */ }
.optical-surface--panel { /* base y elevación de panel */ }
.optical-surface--chrome { /* chrome persistente */ }
.optical-surface--raised { /* overlays */ }
.optical-surface--inset { /* zonas hundidas */ }
```

No crear un sistema complejo si clases y variables resuelven el problema. Un componente React `Surface` es opcional únicamente si reduce duplicación real sin introducir wrappers innecesarios.

---

## 6. Arquitectura de panel correcta

### 6.1 `PanelFrame.tsx`

Eliminar la arquitectura experimental actual:

- `stackStyle` de ancho y alto cero;
- `glassPlateStyle`;
- nodo `[data-panel-glass-plate]`;
- nodo `[data-glass-motion-fill]`;
- nodo hermano `[data-panel-content-surface]` cuando solo existe para separar compositores;
- `backdropFilter` y `WebkitBackdropFilter`;
- comentarios que justifican vidrio y contenido como hermanos.

Restaurar una sola caja exterior absoluta con:

- `left: 0`, `top: 0`;
- `width` y `height` del `panel.rect`;
- una única matriz `translate camera → scale camera → translate panel`;
- `transform-origin: 0 0`;
- `z-index` del panel;
- eventos de pointer actuales;
- clase `optical-surface optical-surface--panel`;
- radio, borde, fondo y sombra en esa misma caja;
- contenido y cabecera como hijos directos.

La capa que recibe la transformación debe ser la misma que dibuja el fondo y contiene el texto. De esa forma borde, superficie y contenido comparten redondeo de subpíxel y ciclo de rasterización.

El sticky puede conservar su tinte, pero debe ser una variante del material de panel, no una tecnología distinta. Aplicar su tono como mezcla pequeña con `--optical-panel-base`; conservar contraste AA para texto.

Los acentos de terminal/agente deben afectar borde, rail o ring interior. Nunca crear una segunda placa detrás.

### 6.2 `DockGroupFrame.tsx`

Aplicar exactamente el mismo patrón de una caja:

- una transformación;
- una superficie `panel`;
- panes internos dentro de esa caja;
- divisores internos con `--optical-edge`;
- cero placa duplicada y cero blur.

Un grupo debe parecer un panel mayor subdividido, no varios materiales apilados.

### 6.3 Cabeceras

Todas las cabeceras normales y de panes deben compartir:

- altura coherente;
- lavado superior ligeramente más luminoso;
- divisor inferior de baja intensidad;
- datum grip, icono, título y acciones con la misma alineación;
- acciones secundarias visibles en hover/focus sin cambiar la geometría;
- foco accesible mediante la firma `focus-caliper` existente.

No crear otra superficie con alpha sobre el panel si produce bandas incoherentes. La cabecera puede usar un gradiente interno calculado desde tokens ópticos.

---

## 7. Unificación del resto de la aplicación

Realizar una búsqueda completa:

```powershell
rg -n "backdropFilter|WebkitBackdropFilter|backdrop-filter|data-glass|glass-motion" src/renderer
```

Migrar todos los resultados reales, incluyendo como mínimo:

- `canvas/DockGroupFrame.tsx`
- `canvas/Minimap.tsx`
- `chrome/TopBar.tsx`
- `chrome/Dock.tsx`
- `chrome/ViewControls.tsx`
- `chrome/CommandPalette.tsx`
- `chrome/ContextMenu.tsx`
- `chrome/ConfirmDialog.tsx`
- `chrome/TerminalCloseDialog.tsx`
- `chrome/LastPromptsOverlay.tsx`
- `chrome/AgentControlCenter.tsx`
- `chrome/AgentManager.tsx`
- `chrome/TimeChip.tsx`
- `chrome/Toasts.tsx`
- `chrome/EmptyState.tsx`
- `chrome/settings/SettingsModal.tsx`
- `chrome/settings/controls.tsx`
- `chrome/settings/sections.tsx`
- `chrome/workspaces/FolderMenu.tsx`
- `chrome/workspaces/SpacesMenu.tsx`
- `panels/sticky/StickyNotePanel.tsx`
- `panels/terminal/TerminalView.tsx`
- `voice/voice.css`

Asignación de variantes:

- Top bar, dock, view controls y chips persistentes → `chrome`.
- Menús, command palette, modales, overlays, toasts → `raised`.
- Panel frame y dock group → `panel`.
- Terminal well, inputs, campos, bloques de código → `inset`.
- Sticky → `panel` con modificador de tono.

Revisar también componentes que usan `bg-glass`, `var(--glass-bar)` o fondos inline sin blur. Deben mapearse a la misma jerarquía aunque no sean costosos; el objetivo es coherencia, no solo rendimiento.

No eliminar colores de datos legítimos: diff, estados, prioridades y acentos de agente siguen siendo información. Reducirlos a bordes/indicadores si actualmente dominan toda una superficie.

---

## 8. Cámara, pan y zoom

### 8.1 Mantener lo que sí es correcto

Conservar del `ViewportController`:

- acumulación de deltas de cámara por `requestAnimationFrame`;
- aplicación síncrona del último delta antes de finalizar un gesto;
- invalidación de callbacks de settle anteriores al comenzar una interacción nueva;
- snap de `x/y` a píxel físico después del settle;
- escritura imperativa de variables de cámara para evitar renders React por frame.

### 8.2 Simplificar lo relacionado con material

- `interacting` puede seguir existiendo para promoción temporal de la capa mundo, cursor o telemetría.
- Eliminar toda regla visual que cambie el material bajo `[data-viewport-interacting='true']`.
- Actualizar comentarios en `CanvasRoot.tsx`, `usePanZoom.ts` y `ViewportController.ts`; no deben mencionar “glass off/on”.
- Durante pan/zoom, promover solo el contenedor de mundo o los elementos estrictamente necesarios.
- Al terminar, retirar `will-change` después de dos frames estables.

### 8.3 Invariantes matemáticos

- El punto bajo el cursor debe permanecer bajo el cursor al hacer wheel zoom.
- Un ciclo zoom in → zoom out que vuelve al mismo valor no puede alterar las coordenadas mundiales de paneles.
- La cámara no debe perder el último `pointermove` antes de `pointerup`.
- No redondear coordenadas mundiales de panel por frame; redondear únicamente la cámara al asentarse.
- Mantener idéntica la matriz de fondo, marco y contenido porque ahora pertenecen al mismo nodo.

---

## 9. Terminal, editor y contenido especializado

### Terminal/xterm

- Eliminar `data-glass` y blur de `TerminalView.tsx`.
- Usar `optical-surface--inset` o un token de inset sólido.
- No escalar xterm con un segundo transform independiente del panel.
- Mantener el addon WebGL si está disponible y el fallback existente si falla.
- Ejecutar `fit()` cuando cambie el tamaño real del panel; el zoom de cámara no debe provocar recreación continua de la terminal.
- Confirmar que el texto no desaparece durante pan y que el scroll de xterm no mueve el canvas.

### CodeMirror/Markdown/File tree

- Usar fondos inset sólidos derivados del tema.
- No envolver CodeMirror en padres con `opacity`, `filter` o blur.
- Conservar selección, cursor y focus con contraste correcto.
- Verificar que los paneles siguen mostrando contenido real a 35 %, 50 %, 75 % y 100 %.

### Browser/webview

- No aplicar filtros a la superficie que contiene el webview.
- Evitar overlays transparentes permanentes durante movimiento.
- Confirmar input, scroll y selección después de la migración.

---

## 10. Secuencia de implementación

### Fase 0 — Seguridad y línea base

1. Leer `git status` y conservar todos los cambios existentes del usuario.
2. No usar `git reset --hard`, `checkout --` ni reemplazos masivos destructivos.
3. Capturar screenshots instalados a 100 %, 75 %, 50 % y zoom-to-fit.
4. Registrar FPS/frame time durante pan y zoom en un workspace representativo.
5. Enumerar todos los usos de filtros y tokens glass.

Salida: evidencia antes del cambio y lista exhaustiva de superficies.

### Fase 1 — Tokens y primitivas ópticas

1. Añadir tokens en `theme.css`.
2. Añadir claves y generación por tema en `themes.ts`.
3. Crear las cuatro clases `optical-surface`.
4. Crear una página/estado de prueba con panel, chrome, raised e inset juntos.
5. Verificar temas oscuro, claro, cálido y cromático antes de migrar componentes.

Salida: material estable, sin filtros, validado aisladamente.

### Fase 2 — Panel y grupo de una sola capa

1. Colapsar `PanelFrame.tsx` a una caja transformada.
2. Colapsar `DockGroupFrame.tsx` del mismo modo.
3. Migrar sticky y acentos de terminal/agente.
4. Eliminar placas y fills de movimiento.
5. Probar drag, resize, docking, undocking, selección y cierre.

Salida: no existe divergencia geométrica entre fondo y contenido.

### Fase 3 — Chrome persistente

1. Migrar top bar, dock y view controls a variante `chrome`.
2. Migrar chips y controles persistentes.
3. Alinear radios, bordes, sombras y estados interactivos.
4. Confirmar que el chrome no compite visualmente con los paneles.

Salida: la aplicación ya se percibe como una sola familia.

### Fase 4 — Overlays y superficies elevadas

1. Migrar command palette, menus, settings, diálogos, overlays y toasts.
2. Usar variante `raised` y scrim neutral.
3. Revisar foco de teclado, hover, pressed, loading, empty y error.
4. Eliminar fondos inline redundantes.

Salida: todos los niveles de elevación siguen la misma iluminación.

### Fase 5 — Contenido inset

1. Migrar terminal, inputs, editores y bloques internos.
2. Confirmar contraste y clipping.
3. Validar xterm, CodeMirror y webview.

Salida: contenido técnico nítido dentro de pozos coherentes.

### Fase 6 — Limpieza

1. Eliminar reglas `data-glass` y `data-glass-motion-fill` obsoletas.
2. Eliminar comentarios que describen blur real.
3. Eliminar imports, componentes o stores de detail level que ya no tengan consumidores.
4. Ejecutar la búsqueda de filtros hasta obtener cero usos en UI.
5. Actualizar `DESIGN_SYSTEM.md` y arquitectura relevante.

Salida: no quedan dos sistemas visuales coexistiendo.

### Fase 7 — Compilación, paquete e instalación

1. Ejecutar typecheck y build.
2. Empaquetar Windows.
3. Instalar o reemplazar de forma segura la versión instalada.
4. Abrir la aplicación instalada, no solo preview/dev.
5. Repetir las pruebas usando el binario instalado.

Salida: la versión que ve el usuario contiene el resultado validado.

---

## 11. Pruebas obligatorias

### 11.1 Pruebas estáticas

```powershell
npm run typecheck
npm run build
git diff --check
rg -n "backdropFilter|WebkitBackdropFilter|backdrop-filter|filter:\s*blur|data-glass-motion-fill|data-panel-glass-plate" src/renderer
```

La última búsqueda debe devolver cero usos funcionales. Comentarios/documentación también deben actualizarse para no inducir a futuras IAs a reintroducir el sistema anterior.

### 11.2 Invariantes DOM/computed style

En una build real:

- Cada panel visible tiene exactamente un nodo exterior con la matriz de cámara.
- Ese mismo nodo dibuja el material y contiene el panel.
- No existen placas hermanas de glass.
- `getComputedStyle(panel).backdropFilter === 'none'`.
- El `background`, `borderColor`, `boxShadow` y `opacity` del panel son iguales antes, durante y después de pan/zoom.
- Ningún contenido principal tiene clase `invisible` por nivel de zoom.

### 11.3 Estabilidad geométrica

Automatizar al menos estas secuencias:

1. Registrar rects de paneles y cámara.
2. Zoom `100 → 75 → 50 → 35 → 50 → 75 → 100` alrededor del mismo punto.
3. Esperar settle.
4. Confirmar que cámara y rects vuelven a su posición con error máximo de `0.25px` de pantalla.
5. Repetir 20 veces.
6. Realizar pan rápido con `pointerup` inmediatamente después del último movimiento y confirmar que no hay salto hacia atrás.
7. Iniciar un nuevo gesto durante el settle anterior y confirmar que el callback viejo no termina la interacción nueva.

### 11.4 Calidad visual

Capturar en reposo y durante movimiento:

- 100 %;
- 75 %;
- 50 %;
- 35 %;
- zoom-to-fit;
- selección de panel;
- grupo docked;
- sticky;
- command palette;
- settings;
- tema oscuro, tema claro y un tema con tinte.

Revisión visual:

- bordes y contenido no se separan;
- el material no parpadea;
- no aparece la cuadrícula detrás del texto;
- todos los paneles reales siguen visibles;
- la dirección de iluminación es constante;
- no hay una superficie “liquid” junto a otra plana;
- sticky y agentes se sienten variantes del mismo sistema;
- texto y cursores conservan contraste.

### 11.5 Rendimiento

Workspace mínimo de prueba:

- una terminal con salida activa;
- un editor CodeMirror;
- Files;
- Sticky;
- Pomodoro;
- un grupo docked;
- un overlay abierto en prueba separada.

Objetivos en Windows con aceleración de hardware:

- no long tasks repetitivas durante pan/zoom;
- p95 de frame idealmente menor a `20ms` y nunca degradación sostenida severa;
- cero recalculados de blur por frame;
- cero renders React globales por cada `pointermove`/wheel;
- memoria GPU estable después de 50 ciclos de zoom;
- respuesta visual al input sin salto al iniciar o terminar.

Probar escalado de pantalla de Windows al menos en 100 %, 125 % y 150 % si el entorno lo permite.

### 11.6 Funcionalidad regresiva

- mover y redimensionar panel;
- multi-select si existe;
- dock/undock;
- zoom al cursor;
- zoom-to-fit;
- minimap;
- terminal input, selección, paste, scroll y resize;
- editor input y selección;
- webview/browser input y scroll;
- abrir/cerrar menús y modales;
- cambiar tema;
- restaurar workspace;
- cerrar y volver a abrir la aplicación instalada.

---

## 12. Criterios de aceptación finales

La tarea solo está terminada si se cumplen todos:

- [ ] No existe `backdrop-filter` funcional en `src/renderer`.
- [ ] No existen placas de vidrio separadas del contenido.
- [ ] Cada panel/grupo usa una sola transformación exterior.
- [ ] El material no cambia durante interacción.
- [ ] Todo el contenido real permanece visible a cualquier zoom soportado.
- [ ] No existe `PanelOverview` cubriendo paneles.
- [ ] Paneles, chrome, overlays e inset usan la misma familia óptica.
- [ ] Todos los temas siguen funcionando mediante tokens.
- [ ] Typecheck, build y `git diff --check` pasan.
- [ ] Las pruebas de zoom repetido no muestran drift superior a `0.25px` de pantalla al volver al mismo estado.
- [ ] Pan rápido no pierde el último delta.
- [ ] Terminal, editor y webview conservan interacción.
- [ ] Screenshots confirman coherencia a 100/75/50/35 % y zoom-to-fit.
- [ ] La aplicación empaquetada e instalada fue probada y queda abierta para revisión.

---

## 13. Prohibiciones para evitar recaídas

No aceptar ninguna de estas “optimizaciones”:

- apagar blur durante movimiento y encenderlo al terminar;
- usar un fondo alternativo temporal durante zoom;
- duplicar la matriz en dos hermanos para separar vidrio y texto;
- congelar paneles como bitmap durante interacción;
- cubrir contenido con tarjetas de resumen a zoom lejano;
- hacer el fondo demasiado transparente para simular vidrio;
- aplicar `opacity` al panel completo;
- introducir Canvas/WebGL para toda la UI sin una justificación y benchmark independientes;
- cambiar de framework o añadir una librería visual solo para este rediseño;
- corregir el drift con offsets manuales dependientes del zoom.

Si una propuesta necesita que el material sea diferente mientras el usuario mueve el canvas, esa propuesta incumple el objetivo.

---

## 14. Entrega esperada de la IA

La IA implementadora debe entregar:

1. Resumen de la arquitectura final.
2. Lista exacta de archivos modificados.
3. Confirmación de que preservó cambios preexistentes.
4. Resultado de typecheck, build y búsqueda de filtros.
5. Métricas o evidencia de pan/zoom.
6. Screenshots en los niveles solicitados.
7. Confirmación de pruebas funcionales de terminal/editor/webview.
8. Ruta del ejecutable instalado probado.
9. Aplicación instalada abierta en zoom-to-fit.

La calidad final no se juzga por cuántos efectos se añadieron, sino por la ausencia de inestabilidad, la nitidez del contenido y la coherencia de todo el sistema.
