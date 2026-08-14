# Documentación de PLANO

Este índice es el punto de entrada para la documentación activa del proyecto. Los respaldos históricos conservan su estructura original dentro de `Backups/` y la copia independiente de macOS permanece en `Plano mac version/`.

## Empezar aquí

- [Plan completo para salir al mercado](product/MARKET_LAUNCH_ROADMAP.md)
- [Arquitectura](architecture/ARCHITECTURE.md)
- [Sistema de diseño](design/DESIGN_SYSTEM.md)
- [Mobile & Remote](architecture/MOBILE_REMOTE.md)

## Producto

- [Plan de lanzamiento](product/MARKET_LAUNCH_ROADMAP.md) — tareas necesarias para publicar PLANO.
- [Roadmap de funciones](product/FEATURE_ROADMAP.md) — ideas y evolución posterior del producto.

## Arquitectura

- [Arquitectura general](architecture/ARCHITECTURE.md)
- [Mobile & Remote](architecture/MOBILE_REMOTE.md)

## Diseño

- [Sistema de diseño](design/DESIGN_SYSTEM.md)

## Ingeniería

### Planes de arquitectura

- [Interconexión universal de agentes (Mesh v2)](engineering/plans/PLAN_AGENT_MESH_INTERCONNECT.md) — que cualquier harness se detecte solo, se escriban entre sí de forma visible y puedan crear agentes nuevos en el canvas.
- [Mesh v3: orquestación robusta](engineering/plans/PLAN_AGENT_MESH_V3_ROBUSTNESS.md) — por qué la orden no se ejecuta hoy, estado real de cada agente, petición→respuesta, delegación por capacidad y enlaces persistentes.
- [Mesh v4: presencia visual + encadenado](engineering/plans/PLAN_AGENT_MESH_V4_PRESENCE_AND_CHAINING.md) — que se vea que todo está conectado (animación con criterio) y «cuando termines, que lo ejecute Codex».
- [Conciencia entre workspaces + avisos](engineering/plans/PLAN_AGENT_AWARENESS_AND_NOTIFICATIONS.md) — estado real por workspace, avisos dentro de PLANO con diseño propio, y slider de fuente de terminal.

### Planes de renderizado y movimiento

- [Fluidez del canvas y saneamiento del panel Files](engineering/plans/PLAN_CANVAS_FILES_SMOOTHNESS.md) — por qué un panel Files degrada todo el canvas y cómo acotarlo (cámara, containment, culling, I/O del árbol).
- [Terminales nítidas al arrastrar y foco visual estilo Deska](engineering/plans/PLAN_TERMINAL_DESKA_DRAG_AND_FOCUS.md) — estado actual, implementación, pruebas, actualización e instalación.
- [Cristal óptico unificado](engineering/plans/PLAN_OPTICAL_GLASS_UNIFIED_RENDER.md)
- [Movimiento unitario y oclusión](engineering/plans/PLAN_UNIFIED_MOTION_AND_OCCLUSION_HIERARCHY.md)
- [Nitidez y fluidez del canvas](engineering/plans/PLAN_CANVAS_SHARPNESS_AND_SMOOTHNESS.md) — propuesta superada, conservada como referencia.

### Terminal

- [Análisis de la terminal](engineering/terminal/ANALISIS_TERMINAL_PLANO.md)
- [Problema histórico de recorte derecho](engineering/terminal/TERMINAL_RIGHT_CLIPPING_PROBLEM.md)
- [Corrección histórica del zoom](engineering/terminal/TERMINAL_ZOOM_FIX.md)
- [Diagnóstico histórico de zoom y scroll](engineering/terminal/TERMINAL_ZOOM_SCROLL_BUG.md)

### Voz

- [Handoff técnico de Odla](engineering/voice/ODLA_VOICE_HANDOFF.md)

## Archivo

- [Prompt histórico de UI](archive/PROMPT_UI_PLANO.md)

## Regla de organización

- La raíz conserva únicamente `README.md` y `CLAUDE.md`.
- Los planes de producto van en `docs/product/`.
- La arquitectura viva va en `docs/architecture/`.
- Las decisiones visuales van en `docs/design/`.
- Los diagnósticos y planes técnicos van en `docs/engineering/`.
- La investigación de productos externos va en `docs/research/`.
- Los documentos reemplazados pero útiles van en `docs/archive/`.
- Al crear o mover un documento, este índice debe actualizarse.
