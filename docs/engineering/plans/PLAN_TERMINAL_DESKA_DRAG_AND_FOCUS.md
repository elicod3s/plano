# Plan de implementación: terminales nítidas al arrastrar y foco visual estilo Deska

**Estado:** implementación pausada; existen cambios provisionales sin aceptar  
**Fecha:** 2026-08-09  
**Alcance:** movimiento de paneles de terminal, estado visual inactivo, regresiones de terminal, empaquetado, actualización e instalación  

## 1. Resultado esperado

PLANO debe conservar la nitidez de la terminal durante todo el arrastre, incluso con muchos paneles y con zoom del canvas. El movimiento se representará con una copia visual ligera del panel; la terminal real no se moverá, escalará ni remontará hasta soltar el puntero.

Cuando una terminal no esté activa, el panel completo descansará al 75 % de opacidad. Al enfocarlo, pasar el puntero o navegar hacia él con teclado, volverá al 100 %. El efecto debe sentirse integrado con la estética de PLANO, sin volver transparente la superficie interna de xterm ni reintroducir el recorte de contenido.

Al finalizar, se deberá producir un instalador verificable, instalar esa compilación conservando los datos del usuario, abrirla y validar que el actualizador automático siga funcionando.

## 2. Límites del trabajo

### Incluido

- Arrastre nítido de terminales sueltas.
- Arrastre de grupos acoplados que contengan terminales.
- Estado visual activo, inactivo, hover y `focus-within`.
- Snapping, docking, cancelación y captura del puntero.
- Regresión funcional y visual de xterm.
- Rendimiento con una cantidad alta de paneles.
- Empaquetado, actualización automática, instalación y verificación.

### No incluido

- Rediseñar otros tipos de panel.
- Cambiar el motor PTY o el protocolo IPC.
- Reactivar WebGL.
- Volver a habilitar el escalado dinámico de rasterización de xterm.
- Publicar una versión sin autorización explícita.
- Borrar o migrar los datos del usuario.

## 3. Estado exacto donde quedó el trabajo

| Elemento | Estado actual | Evidencia / observación |
|---|---|---|
| Comparación con Deska 1.1.0 | Terminada | Deska oculta el nodo real y mueve un `DragOverlay` liviano. |
| Arrastre fantasma en `PanelFrame.tsx` | Provisional | El código existe, pero no está aceptado todavía. |
| Atenuación de terminales inactivas | Provisional | Se añadió 0.75 para inactivo y 1 para activo/hover. Falta validar teclado y todos los temas. |
| TypeScript renderer | Pasa | `npx tsc --noEmit -p tsconfig.web.json`. |
| TypeScript main | Pasa | `npx tsc --noEmit -p tsconfig.node.json`. |
| Build de desarrollo | Pasa | `npm run build`. |
| Prueba E2E integral | Falla | Terminó con código 1 y no informó cuál aserción falló. No se puede declarar corregido. |
| Prueba de movimiento aislada | Pendiente | Debe separarse del sonido y de escenarios Pi/agentes. |
| Paquete instalable de estos cambios | No creado | La aplicación instalada aún no contiene este trabajo provisional. |
| Actualizador automático | Auditado en código | Falta la prueba completa de descarga, reinicio e instalación con builds empaquetados. |

Archivos con cambios provisionales relevantes:

- `src/renderer/panels/_base/PanelFrame.tsx`
- `src/renderer/styles/globals.css`
- `scripts/plano-motion-sound-e2e.mjs`
- `scripts/plano-smoothness-e2e.mjs`

El repositorio ya tenía numerosos cambios del usuario antes de este trabajo. No se usará `git reset`, no se restaurarán archivos enteros y cualquier corrección o rollback se hará por fragmentos estrictamente relacionados con este plan.

## 4. Qué se aprendió de Deska

La referencia inspeccionada está instalada en:

`C:\Users\Administrator\AppData\Local\Programs\deska\resources\app.asar`

El comportamiento útil no proviene de animar la terminal real:

1. Al comenzar un arrastre real, Deska oculta la fuente.
2. Mueve un overlay liviano con borde, fondo, título e indicación de destino.
3. La superficie xterm original permanece quieta y no se reescala por cada movimiento del puntero.
4. Al soltar, aplica la posición final al panel real.
5. Los paneles sin foco reposan con `UNFOCUSED_OPACITY = 0.75`; hover, selección o foco recuperan 1.

La causa concreta del deterioro observado en PLANO era aplicar a todo el panel vivo:

`translate3d(0, -2px, 0) scale(1.006)`

Como xterm se dibuja sobre una superficie rasterizada, ese escalado fraccional obliga al compositor a remuestrear el texto y el cursor. El resultado es pérdida temporal de nitidez y una sensación de vibración al moverlo.

El sistema de render scale existente no se reactivará: anteriormente alteró columnas, scroll y geometría de xterm. Además, en Deska solo entra en juego por encima de zoom 1 y no explica el defecto reproducido alrededor de 90 %.

## 5. Arquitectura de la solución

### 5.1 Máquina de estados del arrastre

```text
Idle
  └─ pointerdown → Armed
       ├─ pointerup antes del umbral → Idle (solo click/foco)
       ├─ movimiento > 5 px → DraggingGhost
       │    ├─ pointermove → actualizar solo el transform del ghost
       │    ├─ pointerup → Commit → Idle
       │    └─ Escape / pointercancel / lostpointercapture → Cancel → Idle
       └─ cancelación → Idle
```

Reglas:

- El umbral de 5 px evita que un click normal haga parpadear el panel.
- Durante `DraggingGhost`, el panel real conserva exactamente su rectángulo y transform original.
- La fuente se oculta solo después de superar el umbral, no en `pointerdown`.
- El ghost se actualiza de forma imperativa, como máximo una vez por frame mediante `requestAnimationFrame`.
- No se escribirá la posición global en Zustand en cada `pointermove`.
- La posición del panel se confirma una sola vez en `pointerup`.
- Snapping y docking se calculan contra la posición lógica del ghost.
- Cancelar restaura visibilidad y estado sin cambiar la posición.

### 5.2 Ghost visual de PLANO

El ghost debe conservar la mecánica de Deska, pero usar el lenguaje visual de PLANO:

- Fondo sólido de alta opacidad basado en los tokens del tema.
- Borde limpio con el color del terminal o del agente.
- Título, estado y una empuñadura discreta.
- Texto breve en inglés para mantener consistencia con la interfaz: `Moving` y `Release to place`.
- Sombra contenida que separe el ghost del canvas.
- Sin `backdrop-filter`, blur en movimiento ni escalado fraccional.
- `pointer-events: none` y `aria-hidden="true"`.
- Geometría equivalente al panel de origen, con límites para evitar ghosts enormes.

Cuando el comportamiento esté probado, el ghost se extraerá a un componente compartido, por ejemplo `PanelDragGhost.tsx`. No se hará esa refactorización antes de estabilizar las pruebas.

### 5.3 Terminal real

Durante el arrastre:

- La instancia xterm debe ser el mismo nodo antes y después.
- No debe recibir `transform`, `scale`, cambio de tamaño, `fit()` ni remontaje.
- Sus columnas y filas PTY deben permanecer constantes.
- No se tocará `allowTransparency`, el canvas interno ni el viewport.
- El panel real se ocultará visualmente sin alterar layout ni geometría.

### 5.4 Atenuación por foco

Estados visuales previstos:

| Estado | Opacidad |
|---|---:|
| Inactivo | 0.75 |
| Activo / frontal | 1 |
| Hover | 1 |
| `focus-within` | 1 |
| Fuente durante arrastre confirmado | 0 |
| Ghost | 1 |

La opacidad se aplicará al shell completo del panel. La superficie interna de xterm seguirá siendo opaca; así el fondo parece retroceder sin provocar mezclas de color, baja legibilidad ni el recorte derecho ya investigado.

Se verificará que `isFront` represente realmente el foco del usuario. Si solo indica orden Z, se conectará el atributo visual al estado canónico de panel enfocado, sin crear una segunda fuente de verdad.

### 5.5 Grupos y docking

El comportamiento no puede limitarse a `PanelFrame`. Se auditará `DockGroupFrame`:

- Si un grupo contiene una terminal, el grupo completo usará el mismo mecanismo de ghost al moverse.
- No se ocultará individualmente una terminal dentro de un grupo visible.
- Tab switching, docking preview, separación y recomposición del grupo deben conservarse.
- La implementación compartida evitará dos máquinas de estados distintas.

## 6. Fases de implementación

### Fase 0 — Proteger el estado actual

1. Registrar el `git status` y aislar los fragmentos introducidos por este trabajo.
2. No modificar cambios previos del usuario en `PanelFrame.tsx`, `globals.css` ni scripts.
3. Guardar evidencia del build que pasa y de la prueba que falla.
4. Confirmar que ningún proceso de pruebas temporal quede ejecutándose.

**Salida:** mapa preciso de hunks propios y base segura para continuar o revertir.

### Fase 1 — Convertir la falla E2E en un diagnóstico útil

1. Separar la prueba de movimiento de la prueba de sonido y agentes.
2. Hacer que cada escenario escriba resultado estructurado con nombre, valores observados y error.
3. Capturar screenshot y estado DOM al primer fallo.
4. Ejecutar el movimiento aislado a zoom 0.90, 1.00 y 1.25.
5. Determinar si la falla actual es de selector/tiempo o una regresión real.

**Condición para avanzar:** la prueba debe señalar inequívocamente qué regla se incumple.

### Fase 2 — Estabilizar la mecánica de arrastre

1. Implementar el estado `Armed` y el umbral de 5 px.
2. Centralizar inicio, movimiento, commit y cancelación.
3. Coalescer movimientos con `requestAnimationFrame`.
4. Mantener el panel y la xterm reales inmóviles.
5. Confirmar una única escritura de posición por arrastre.
6. Cubrir `Escape`, `pointercancel` y `lostpointercapture`.
7. Validar snapping, docking y límites del canvas.

**Condición para avanzar:** la identidad del nodo xterm, su rectángulo y sus dimensiones PTY permanecen estables mientras se mueve el ghost.

### Fase 3 — Pulir el ghost sin comprometer rendimiento

1. Ajustar jerarquía, contraste, sombra, borde y textos en temas oscuros y claros.
2. Evitar filtros costosos y propiedades que fuercen repintado de la terminal.
3. Extraer el componente compartido solo después de que la prueba mecánica pase.
4. Reutilizarlo para grupos que contengan terminales.

**Condición para avanzar:** el ghost se lee claramente en todos los temas y no agrega frames lentos medibles.

### Fase 4 — Completar foco e inactividad

1. Añadir `focus-within` además de activo y hover.
2. Validar la fuente canónica del panel activo.
3. Probar superposición de terminales y cambios de foco con mouse y teclado.
4. Revisar Monolith, Indigo, Orange, Tokyo, Sakura, Pearl y Mist.
5. Confirmar contraste de texto, cursor, selección, scrollbar y fondo.

**Condición para avanzar:** inactivo computa 0.75 y activo, hover o foco por teclado computan 1, sin afectar el color interno de xterm.

### Fase 5 — Regresión funcional y rendimiento

Ejecutar la matriz de la sección 7 y corregir únicamente fallas atribuibles a este cambio. Validar especialmente:

- entrada, cursor, selección, copiar/pegar y scrollback;
- aplicaciones TUI de ancho completo;
- múltiples pestañas y terminales de agentes;
- resize antes y después de arrastrar;
- paneles sueltos, acoplados y grupos;
- snapping y cancelación;
- zoom bajo, normal y alto;
- 1, 8 y al menos 56 paneles.

**Condición para avanzar:** typechecks, build, E2E funcional y benchmark pasan de forma repetible.

### Fase 6 — Verificar empaquetado y actualizador automático

Configuración actual auditada:

- Versión actual en `package.json`: `0.2.8`.
- `electron-updater` está configurado para GitHub `zqkra/plano-releases`.
- El chequeo inicia 15 segundos después de abrir y se repite cada 4 horas.
- Descarga automática e instalación al salir están habilitadas.
- `scripts/update-e2e.mjs` puede observar estados y probar reinicio.

Procedimiento:

1. Consultar el feed existente y escoger el siguiente SemVer libre; se espera `0.2.9`, pero no se asumirá sin verificar.
2. Cambiar versión solo al final, cuando todas las pruebas locales pasen.
3. Generar el paquete con `npm run dist:win`, sin publicar.
4. Validar `app-update.yml`, `latest.yml`, instalador, blockmap, versión y hashes.
5. Instalar y probar localmente el paquete candidato.
6. Verificar que la UI del actualizador y sus fases IPC siguen funcionando.
7. Para probar la actualización completa, partir de una versión instalada inferior y usar una versión candidata superior.
8. Solicitar autorización explícita antes de cualquier `npm run release:win` o publicación en GitHub.
9. Tras publicar, ejecutar `scripts/update-e2e.mjs` y comprobar descarga, cierre, instalación, reinicio y versión final.

No se reutilizará `0.2.8` para un contenido distinto si esa versión ya fue publicada: los clientes y cachés podrían recibir artefactos inconsistentes.

### Fase 7 — Instalar y abrir la versión final

1. Identificar el ejecutable y la versión instalada.
2. Cerrar PLANO de forma normal y esperar la finalización del Agent Host y PTYs.
3. Conservar intacto el directorio de datos del usuario.
4. Instalar el paquete candidato verificado.
5. Comparar versión y hash del `app.asar` instalado con el paquete probado.
6. Abrir PLANO de forma visible.
7. Ejecutar smoke test por CDP y comprobación visual manual.
8. Confirmar terminal nítida, foco/inactividad, grupos y estado del actualizador.

## 7. Matriz mínima de pruebas

| Escenario | Validación principal |
|---|---|
| Click sin arrastrar | No aparece ghost; foco normal. |
| Arrastre a zoom 0.90 / 1.00 / 1.25 | Texto y cursor no cambian de nitidez; xterm real no se mueve. |
| Arrastre y commit | El panel termina en la posición prevista con una sola escritura global. |
| Escape / pointercancel | El panel vuelve visible y no cambia de posición. |
| Snapping y docking | Preview y destino final coinciden con el ghost. |
| Terminal en grupo | Se mueve el grupo sin remuestrear la terminal. |
| 1 / 8 / 56 paneles | Movimiento fluido y sin degradación acumulativa. |
| Terminal inactiva | Opacidad computada 0.75. |
| Activa / hover / teclado | Opacidad computada 1. |
| Temas claros y oscuros | Texto, cursor, selección y ghost mantienen contraste. |
| TUI ancho completo | Sin recorte derecho ni cambio de columnas. |
| Resize después de drag | `fit()` correcto solo cuando corresponde. |
| Agente ejecutándose | El proceso continúa; no se pierde salida ni sesión. |
| Actualización automática | Check, download, ready, quit/install y reinicio correctos. |

## 8. Criterios de aceptación

El trabajo solo se considerará terminado si se cumplen todos:

- Ningún ancestro de la xterm real recibe `scale()` durante el arrastre.
- El nodo `.xterm` conserva identidad antes, durante y después.
- El panel real conserva su rectángulo hasta `pointerup`.
- Columnas y filas PTY no cambian por arrastrar.
- La posición global se confirma exactamente una vez.
- El ghost sigue al puntero sin filtros costosos ni parpadeo al hacer click.
- En la prueba de 56 paneles, p95 de frame no supera 16.7 ms y no hay secuencias visibles de frames cortados.
- Inactivo = 0.75; activo, hover y `focus-within` = 1.
- No reaparece el recorte derecho del contenido.
- Pasan `tsconfig.web.json`, `tsconfig.node.json`, build y E2E empaquetado.
- El instalador abre la compilación verificada, no una versión anterior.
- El actualizador reconoce la versión y completa un ciclo E2E cuando se autorice publicar.

## 9. Comandos de verificación previstos

Estos comandos se ejecutarán durante la implementación, no durante la redacción de este plan:

```powershell
npx tsc --noEmit -p tsconfig.web.json
npx tsc --noEmit -p tsconfig.node.json
npm run build
node scripts/plano-motion-sound-e2e.mjs
node scripts/plano-smoothness-e2e.mjs
npm run dist:win
node scripts/update-e2e.mjs
```

Las pruebas se adaptarán para admitir un modo aislado de movimiento y emitir resultados estructurados. `npm run release:win` queda fuera de la ejecución automática y requerirá aprobación.

## 10. Rollback

Si la solución no supera los criterios:

1. Revertir únicamente los hunks de ghost y atenuación de este trabajo.
2. Mantener todos los cambios previos del usuario.
3. Conservar el último instalador verificado antes de reemplazar la instalación.
4. No eliminar `%APPDATA%`, datos de espacios, sesiones ni configuración.
5. Si el candidato instalado falla, cerrar normalmente y reinstalar el paquete anterior verificado.
6. Si ya existiera una release defectuosa, publicar una versión superior corregida; nunca reemplazar silenciosamente artefactos de la misma versión.

## 11. Orden de ejecución resumido

- [ ] Aislar y explicar la falla E2E actual.
- [ ] Estabilizar la máquina de estados y el umbral de arrastre.
- [ ] Confirmar que la terminal real nunca se transforma.
- [ ] Validar snapping, docking, cancelación y grupos.
- [ ] Terminar el ghost visual en todos los temas.
- [ ] Completar activo, inactivo, hover y `focus-within`.
- [ ] Pasar regresión funcional y benchmark con alta carga.
- [ ] Verificar typechecks y build.
- [ ] Elegir la siguiente versión libre.
- [ ] Empaquetar y probar localmente sin publicar.
- [ ] Pedir autorización antes de publicar.
- [ ] Validar actualización completa.
- [ ] Instalar el candidato verificado, abrirlo y hacer smoke test final.

## 12. Decisiones ya tomadas

- Se adopta la mecánica de ghost de Deska, no su apariencia literal.
- La terminal real no se anima ni escala durante el drag.
- El estado inactivo usa 75 % de opacidad.
- El hover y el foco restauran 100 %.
- No se hará transparente la superficie xterm.
- No se reactivará render scale dinámico para resolver este defecto.
- No se empaquetará ni instalará hasta entender la falla E2E actual.
- No se publicará una actualización sin aprobación explícita.

