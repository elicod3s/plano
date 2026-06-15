# PROMPT — UI de PLANO (app de escritorio, infinite-canvas workspace)

> Cópialo y pégalo en tu IA generadora de UI (v0, Lovable, bolt, Claude, etc.).
> Es **solo UI / front-end** por ahora: maqueta navegable con datos simulados, sin lógica real todavía.

---

## INSTRUCCIÓN PARA CLAUDE (Artifacts)

Genérame esto como un **Artifact de React**. Empieza por el **shell completo** (barra superior + riel izquierdo + lienzo + dock inferior + sistema de color en dark) y **3 paneles de ejemplo**. Cuando te diga **"continúa"**, agrega el resto de paneles uno por uno. No intentes hacer los 12 de una sola vez.

## IDIOMA (obligatorio)

**Toda la interfaz debe estar en INGLÉS:** todos los textos, etiquetas, menús, botones, tooltips, placeholders y copys van en inglés. El nombre del producto es **PLANO**.

## ROL Y OBJETIVO

Eres un diseñador de producto + ingeniero front-end senior. Vas a construir **únicamente la interfaz** (UI navegable con datos mock, sin backend) de una app de **escritorio** llamada **PLANO**.

PLANO es un **espacio de trabajo de lienzo infinito (infinite canvas)**: por cada proyecto/carpeta, el usuario coloca **paneles flotantes** (terminal, editor de código, navegador, agentes de IA, notas, git, etc.) sobre un solo lienzo espacial con pan y zoom. Todo se guarda por workspace y se recupera exactamente como se dejó.

**Referencia conceptual (NO copiar):** existe una app llamada Deska con esta idea. Úsala SOLO como referencia funcional de *qué cosas se pueden hacer*. **Está terminantemente prohibido clonar su look & feel, su layout exacto, sus colores o su jerarquía visual.** PLANO debe sentirse como un producto **distinto y claramente mejor**: más legible, mejor uso del espacio, jerarquía visual más limpia, y más cómodo de navegar. Si algo se parece demasiado a la referencia, recházalo y rediséñalo.

---

## STACK Y ENTREGABLES

- **Stack:** React + TypeScript + Tailwind CSS. Componentes con shadcn/ui (Radix) donde aplique. Iconos con `lucide-react`. Animaciones sutiles con Framer Motion.
- Pensado para empaquetarse luego como **app de escritorio** (Tauri/Electron): usa controles de ventana propios, tipografías de sistema/locales, y asume ventana grande (1440×900+) además de responsive a 1280 y a pantallas ultrawide.
- **Solo front-end:** todo con estado local y datos mock realistas. Sin llamadas a red reales.
- Código **limpio, componentizado y reutilizable**: un componente por tipo de panel, tokens de diseño centralizados, theming por CSS variables.
- Entrega: componentes + una pantalla principal (`Workspace`) totalmente armada y navegable, más los estados vacíos y los overlays (command palette, menú contextual, panel library).

---

## PRINCIPIOS DE DISEÑO (la parte "mejor optimizado")

PLANO debe **superar** a la referencia en estos puntos concretos:

1. **Legibilidad a cualquier zoom.** Implementa *semantic zoom*: cuando el usuario aleja el lienzo, los paneles muestran un resumen compacto (icono + título + 1 línea de estado) en vez de contenido ilegible. Al acercar, se ve el contenido completo. (La referencia se vuelve ilegible al alejar; nosotros no.)
2. **Espacio bien usado, no caos flotante.** Lienzo libre PERO con: snap a grilla opcional, guías de alineación al arrastrar, y un **Auto-Layout** que ordena los paneles en una rejilla limpia de verdad. Añade un **modo de layout** conmutable: `Free canvas` / `Tiling (mosaico)` / `Focus (un panel)`.
3. **Navegación espacial clara.** Incluye un **minimapa** (esquina inferior, plegable) y atajos "Zoom to fit" / "Reset zoom". El usuario nunca debe "perderse" en el lienzo.
4. **Jerarquía visual limpia.** Chrome de panel consistente y discreto, contraste cuidado, tipografía con escala clara. Menos ruido que la referencia.
5. **Teclado primero + accesible.** Todo accionable por teclado, foco visible, roles ARIA, contraste AA. Command palette potente.
6. **Tema oscuro como base (obligatorio).** Todo se diseña en dark. Densidad `Comfortable` / `Compact` vía tokens. (Un Light/High-contrast opcional puede venir después, pero no condiciona el diseño principal.)
7. **Estados vacíos y onboarding cuidados** (no pantallas en negro vacías).
8. **Rendimiento percibido:** paneles fuera de pantalla se "congelan" visualmente (placeholder), animaciones a 60fps, sin parpadeos.

---

## SISTEMA DE DISEÑO (tú eliges; estas son las únicas reglas)

**Diseña tú el sistema visual completo: elige tú la paleta, el acento, la tipografía y la personalidad.** No te doy colores fijos a propósito — quiero tu mejor criterio de diseñador para que se vea premium y original. Pero respeta estas reglas innegociables:

- **DARK SÍ O SÍ.** El producto es de tema oscuro. Es el corazón de la identidad, no un modo opcional. (Un Light opcional puede existir más adelante, pero el diseño principal y todas las decisiones se toman en oscuro.)
- **NADA de copiar a la competencia.** Inventa tu propia paleta y tu propia firma de color. Si tu elección de colores/jerarquía se parece a la de la referencia, deséchala y haz otra distinta.
- **Define todo como tokens** (CSS variables): superficies (lienzo / panel / elevado), bordes, niveles de texto, un acento de marca propio, y colores semánticos (éxito/aviso/error/info). Centraliza para poder re-tematizar fácil.
- **Coherencia y profundidad:** escala tipográfica clara, radios consistentes, y sombras que den sensación real de panel flotando sobre el lienzo. Usa el acento **con moderación** (foco, selección, CTA) — que el oscuro respire, no lo satures de color.
- **Tipografía:** una sans limpia para la UI y una mono para terminal/código. Tú eliges cuáles.
- **Marca PLANO:** "plano" evoca plano/blueprint/lienzo/rejilla. Inspírate en eso para un logotipo simple y propio. No imites el logo de la referencia.

---

## ANATOMÍA DE LA PANTALLA PRINCIPAL (Workspace)

### 1. Barra superior (slim, arrastrable como title bar de escritorio)
- Izquierda: logo PLANO + nombre del workspace con dropdown (cambiar/crear/renombrar workspace).
- Botón **"Abrir carpeta"** (estado: "Sin carpeta" → "📁 nombre-proyecto").
- Centro: título sutil del workspace.
- Derecha: **time tracking** (chip "7m hoy" que al hover/click despliega Hoy / Esta semana / Ayer), botón de tema, y **controles de ventana propios** (min/max/close) para sensación de app nativa.

### 2. Riel izquierdo (workspace switcher, angosto)
- Avatares/iconos de workspaces (cuadraditos con iniciales o color), el activo resaltado con el acento.
- Botón **"+"** para nuevo workspace.
- Botón de **grid/overview** (ver todos los workspaces como tarjetas).
- Abajo: avatar de usuario y engranaje de **Ajustes**.

### 3. Lienzo infinito (el protagonista, ocupa todo)
- Pan: arrastrar con espacio o botón central, o scroll. Zoom: Ctrl/⌘ + scroll o pinch. Indicador de % de zoom.
- Paneles flotantes arrastrables y redimensionables, con snap y guías de alineación.
- Multi-selección (marquee + Shift-click), agrupar en **Regiones**, alinear/distribuir.
- **Menú contextual** (clic derecho en el lienzo) — ver abajo.
- **Minimapa** plegable (abajo-izquierda).

### 4. Dock inferior flotante (centrado, estilo "command bar")
- Botón **"Library" (Ctrl+Shift+E)** → abre el Panel Library.
- Botones rápidos para crear: Terminal, Editor, Browser, Agente, Nota.
- Botón de **voz** (micrófono) con menú.
- Controles de **zoom** (−, %, +, Zoom to fit) y **Ajustes**.

### 5. Overlays
- **Command Palette (Ctrl/⌘+K):** input "Buscar archivos, terminales, comandos…", con secciones `PANELES ABIERTOS`, `COMANDOS` (con atajos a la derecha), `ARCHIVOS`, y `ACCIONES IA`. Fuzzy search, navegación con flechas, recientes. Footer con hints (Navegar / Seleccionar / Esc).
- **Menú contextual del lienzo:** New Terminal, New Editor, New Browser, **New PLANO Agent**, New Sticky Note, Pinned ▸, **Panel Library (Ctrl+Shift+E)**, New Region, New Text, Paste. Con iconos y atajos.
- **Panel Library:** rejilla/lista de tipos de panel y plantillas guardadas, con buscador y categorías.

---

## TIPOS DE PANEL (componente independiente cada uno)

Cada panel comparte un **chrome común**: barra superior con punto de estado, icono+título editable, pestañas (cuando aplique), y acciones (split, refrescar, maximizar/focus, cerrar). Diseña los siguientes con datos mock convincentes:

1. **Terminal** — prompt, output mock (PowerShell/zsh), pestañas de terminal, badge de estado "ready".
2. **Editor de código** — árbol de archivos a la izquierda (colapsable) + editor con números de línea, resaltado de sintaxis (mock), pestañas de archivos, estado vacío "No file open / scratch buffer".
3. **Navegador / Web preview** — barra de URL, atrás/adelante/recargar, pestañas, área de contenido (about:blank / preview).
4. **Agente de IA ("PLANO Agent")** — selector/launcher de asistente (Claude Code, Codex, OpenCode — con estados INSTALLED / NOT INSTALLED), hilo de chat, input, **toggle "Auto-approve" SIEMPRE visible** (mensaje: "el agente nunca actúa a tus espaldas"), opción "usa tus propias keys".
5. **File Explorer** — árbol del proyecto, búsqueda, iconos por tipo.
6. **Git** — cambios (staged/unstaged), diff, lista de commits, branch actual, botones commit/push.
7. **Documento / Markdown** — editor de notas con vista previa.
8. **Sticky Note** — nota de color, redimensionable, texto libre.
9. **Scratchpad** — bloc rápido para ideas, autosave visual.
10. **Voz** — botón de grabación, forma de onda, transcripción en vivo (mock).
11. **Texto en lienzo** — etiqueta de texto libre (títulos/anotaciones sobre el lienzo).
12. **Region** — marco/sección para agrupar paneles (como secciones de Figma), con título y color.

---

## INTERACCIONES Y ATAJOS (maquetar visualmente, lógica simulada)

- `Ctrl/⌘+K` Command Palette · `Ctrl+Shift+E` Panel Library · `Ctrl+Shift+T/B/E` nuevo Terminal/Browser/Editor.
- `Ctrl+\` Toggle sidebar · `Ctrl+Shift+X` Toggle file explorer · `Ctrl+Space` Switch panel.
- `Ctrl+0` Reset zoom · `Ctrl+1` Zoom to fit · `Ctrl+Shift+L` Auto-Layout.
- Doble clic en lienzo vacío = crear panel rápido. Clic derecho = menú contextual.
- Arrastrar = mover (con snap/guías). Esquinas = redimensionar. Maximizar = modo focus.

---

## ESTADOS A DISEÑAR
- Workspace vacío (sin paneles): onboarding elegante con CTA "Abrir carpeta" + "Crear primer panel".
- Sin carpeta abierta dentro de Editor/Explorer.
- Loading/skeleton de paneles. Panel en error. Selección múltiple. Región agrupando paneles.
- Overview de todos los workspaces (tarjetas).

---

## CRITERIOS DE ACEPTACIÓN
1. **No se parece a la referencia**: distinto sistema de color, distinta marca, distinta disposición del chrome, mejor legibilidad. (Si dudas, aléjate más del original.)
2. Semantic zoom funcionando visualmente (resumen al alejar, detalle al acercar).
3. Los 12 tipos de panel maquetados con contenido mock creíble.
4. Command palette, menú contextual y panel library completos.
5. Minimapa + 3 modos de layout (free/tiling/focus) + auto-layout.
6. Tema oscuro (obligatorio) con paleta propia y original; densidad Comfortable/Compact vía tokens.
7. Teclado y accesibilidad cuidados; foco visible; contraste AA.
8. Todo en componentes reutilizables con tokens centralizados.

**Entrega la pantalla `Workspace` completa y navegable, con al menos 4–5 paneles distintos ya colocados sobre el lienzo para mostrar el resultado final.**
