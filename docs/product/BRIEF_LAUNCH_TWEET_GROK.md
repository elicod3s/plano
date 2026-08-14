# BRIEF PARA GROK — Tweet de lanzamiento de PLANO + hilo de features

> **Cómo usar este archivo:** pégalo entero en Grok (X). Es un encargo, no una descripción.
> Grok debe (1) investigar en X, (2) rankear, (3) escribir. En ese orden.

---

## 0. Tu rol

Eres el estratega de lanzamiento de un producto en X. El autor es un desarrollador **solo**,
**sin comunidad**, **sin presupuesto** y **sin audiencia previa**. No hay ads, no hay
newsletter, no hay Product Hunt pagado. El único activo es el producto y el vídeo que se
grabe de él.

Eso cambia todo el diseño del lanzamiento: **el tweet ancla tiene que funcionar por sí solo
entre desconocidos, sin contexto y sin autoridad de cuenta.** Optimiza para *retweet de
alguien que no me conoce*, no para *aplauso de mis seguidores* (no los hay).

---

## 1. Fase 1 — INVESTIGACIÓN (hazla antes de escribir una sola línea)

Busca en X lanzamientos **reales** de apps/herramientas de desarrolladores publicados por
**cuentas pequeñas** (menos de ~5.000 seguidores en el momento del post) que **explotaron**
(>300k views, >2k likes). Prioriza los últimos 18 meses. Ejemplos del terreno donde vive
PLANO: herramientas de terminal, wrappers/orquestadores de agentes de IA, apps de canvas
infinito, IDEs alternativos, apps de escritorio hechas por una persona.

Para cada uno extrae:

| Campo | Qué anotar |
|---|---|
| Hook | Las **primeras 7 palabras** exactas. Son las que deciden si alguien para de hacer scroll. |
| Arquetipo | ¿Es demo mudo? ¿Confesión personal? ¿Contraste antes/después? ¿Afirmación provocadora? ¿"Llevo X meses"? |
| Media | Vídeo/GIF/imagen. Duración. ¿Se entiende sin sonido? ¿En qué segundo aparece "el momento"? |
| Longitud | ¿Cuántos caracteres tenía el tweet ancla? |
| CTA | ¿Había link en el ancla o en la primera respuesta? ¿Pedía algo? |
| Formato | ¿Tweet suelto, hilo, o ancla + hilo colgado después? |
| Timing | Día y hora (convierte todo a **ET**, es donde está el dev-twitter). |

**Entrega D1:** tabla con 15–20 casos + un párrafo con **el patrón que se repite** y, más
importante, **qué NO aparece nunca** en los que funcionaron.

Regla dura: no inventes ejemplos. Si no encuentras el dato, escribe "no verificado".

---

## 2. Qué es PLANO (contexto de producto — es real, está construido, v0.2.26)

**Una sola frase:** un lienzo infinito de escritorio donde tus terminales, editores,
navegadores y **agentes de IA** viven como paneles flotantes — y los agentes **se hablan
entre ellos delante de ti**.

App de escritorio (Electron, Windows + macOS). Un canvas con pan/zoom por proyecto. El
usuario suelta paneles: terminales, editores de código, navegadores, explorador de
archivos, git, markdown, notas, regiones. El layout persiste por proyecto. Estética oscura,
monocroma, esquinas redondeadas.

### Inventario de features (materia prima — tú decides el orden final)

**TIER S — se entienden en 3 segundos, en silencio, y nadie más lo tiene**

1. **Mesh: líneas entre agentes que se comunican.** ⭐ *La joya.*
   Cuando dos agentes hablan, se dibuja una **curva bezier entre sus paneles**, en el propio
   canvas, por detrás de las ventanas. No es decoración: la línea *significa* cosas.
   - Un **punto de pulso viaja del emisor al receptor** → ves la dirección del mensaje.
   - **Punto respirando** en el extremo del receptor → el que preguntó está esperando.
   - Al resolverse, **el pulso vuelve hacia atrás** (respuesta) y la línea se desvanece.
   - **Línea discontinua** = cadena armada, aún no disparada.
   - **Contador numérico** en el centro si esa pareja ha intercambiado varios mensajes.
   - Rojo y flash corto si falla o hay timeout.
   - Las líneas **siguen al panel si lo arrastras**.
   Traducción para X: *"puedes VER a tus agentes de IA hablando entre ellos."* Esto es el
   plano-secuencia del lanzamiento. Nadie tiene esta imagen.

2. **La terminal se convierte en agente sola.** Escribes `claude` (o `codex`, `gemini`,
   `cursor`, `kiro`) en una terminal normal y el panel **se transforma**: se tiñe con el
   color de ese agente, aparece su logo, y el borde respira mientras trabaja. Cero
   configuración, cero botón "modo IA". PLANO lo detecta leyendo el árbol de procesos y el
   banner de salida. Shot: escribir 6 letras → la ventana muta.

3. **`plano`, el CLI que le das a los agentes.** El agente que corre dentro de PLANO tiene
   un comando en su PATH y puede: listar qué otros agentes hay vivos en el canvas, leer lo
   que están haciendo, **mandarles trabajo**, **abrir nuevas terminales con agentes nuevos**,
   quedarse **bloqueado esperando respuesta** (no polling), y reportar `worker_done`.
   Es decir: le pides algo a un agente y **él solo se monta el equipo**. Y todo eso se ve en
   el canvas como líneas nuevas apareciendo. Shot: un solo prompt → aparecen 3 paneles
   solos → se conectan con líneas.

4. **Cierra el portátil; los agentes siguen. Y los llevas en el móvil.** Las terminales no
   son hijas de la ventana: viven en un daemon aparte. Cierras PLANO, lo reabres y **siguen
   corriendo, con su historial**. Y desde el móvil, en la misma red, abres una web y
   **hablas con tus agentes con la app cerrada** — ver, responder, crear y matar sesiones.
   Shot: cerrar la app con un agente currando → reabrir → sigue ahí, mismo scroll.

**TIER A — muy buenas, pero necesitan una frase de contexto**

5. **Voz (Odla).** Hablas y los paneles aparecen/se mueven. ASR local (Parakeet, sin nube).
6. **Paneles que encajan como Lego** + docking estilo VS Code: arrastras un panel sobre otro
   y se fusionan en un grupo con splits. Y zonas de tile tipo Windows.
7. **Las conversaciones de los agentes se restauran.** Reabres el workspace y el agente
   retoma *su conversación anterior*, no una sesión en blanco.
8. **Badge de git por terminal:** rama + estado + repo, en vivo, leyendo el cwd real.
9. **Navegadores reales dentro del canvas** que hacen zoom con él (no capturas: webviews
   vivos; puedes tener tu app corriendo mientras el agente la edita al lado).
10. **Terminales con pestañas**, temas por terminal, zoom de fuente por terminal.

**TIER B — no van en el hilo de lanzamiento** (temas, ajustes, focus mode, isla de uso,
paleta de comandos, notas, regiones). Guárdalas para tweets sueltos de las semanas
siguientes.

### Datos honestos que puedes usar (y que suelen convertir bien)

- Desarrollador solo. **~3 meses** de trabajo. v0.2.26.
- Sin comunidad, sin financiación, sin equipo.
- La idea nace **inspirada en un concepto que enseñó un streamer pequeño** (handle:
  `<STREAMER_HANDLE>`). **Esto se dice, no se esconde** — el crédito público es más
  simpático que el silencio, y además es el mejor canal de distribución disponible.
- Sale **gratis y open source**. (Si el estado exacto de la licencia cambia, ajústalo, pero
  el ancla debe dejar clarísimo que no se está vendiendo nada.)

---

## 3. Fase 2 — RANKING (entrega D2)

Con lo aprendido en la Fase 1, **rankea las features por "tweetabilidad"**, no por lo
difíciles que fueron de programar. Criterio único:

> ¿Un desconocido, con el sonido quitado, haciendo scroll, entiende qué está pasando en
> **menos de 3 segundos**?

Mi hipótesis es que el orden es **1 → 3 → 2 → 4** (mesh, CLI, morph, móvil). **Discútela.**
Si tus datos de la Fase 1 dicen otra cosa, cámbiala y explica por qué en dos líneas.

---

## 4. Fase 3 — ENTREGABLES

### D3 — Tweet ancla: 5 variantes

Cinco variantes, **cada una con un arquetipo de hook distinto** de los que encontraste en la
Fase 1. Para cada una:
- El texto exacto, listo para copiar.
- Cuántos caracteres tiene.
- Qué media lleva y **qué se ve en el segundo 0–1** (ahí se gana o se pierde).
- Por qué debería funcionar, citando el caso de la Fase 1 en el que te basas.

Al final: **tu recomendación, una sola**, y por qué las otras cuatro son peores.

Restricciones del ancla:
- **Inglés.** (Aparte, tradúceme la ganadora al español para una cuenta secundaria.)
- Menos de 200 caracteres. El vídeo hace el trabajo, no el texto.
- **Sin link en el ancla** — va en la primera respuesta (el link mata el alcance).
- Nada de: "🚀 Introducing", "game-changer", "I'm excited to announce", "the future of",
  "so I built", listas con emojis, hilos numerados "1/12", falsa escasez, cifras inventadas.
- Nada de jerga interna: "mesh", "daemon", "PTY", "canvas infinito" no significan nada para
  un desconocido. Se describe lo que se VE.

### D4 — El hilo, tweet a tweet

Un tweet por feature, **en orden de virulencia descendente** (el segundo tweet del hilo es
el segundo mejor gancho, no una introducción). Para cada uno:

```
Tweet N
Texto:        <máx 2 líneas, en inglés>
Media:        <clip / GIF, duración, plano exacto>
Momento wow:  <en qué segundo ocurre>
Por qué aquí: <una línea>
```

Reglas del hilo:
- Entre **5 y 7 tweets**. Si dudas, menos.
- **Cada tweet lleva media.** Un tweet de solo texto en mitad del hilo hunde el resto.
- El último cierra con: qué es, que es gratis, dónde bajarlo, y una pregunta abierta real
  (no "¿qué opinas?").

### D5 — Playbook de la primera hora

- **Cuándo publicar**: día + hora en ET, justificado con la Fase 1.
- **Respuesta 1** (colgada del ancla, inmediata): link de descarga + una línea de contexto.
- **Respuesta al streamer**: redáctala. Tono: crédito genuino, sin pelotear, sin pedir RT
  explícitamente. Es la jugada de distribución más importante del lanzamiento.
- **10–15 cuentas** a las que responder ese día con algo útil (no spam del link): gente que
  publica sobre orquestar varios agentes de IA, Claude Code, Cursor, herramientas de
  terminal. Dame handles reales y por qué cada uno.
- **Qué hacer si a las 2 horas tiene menos de 5.000 views**: plan B concreto (re-post con
  otro hook, otro clip, otro día — dime cuál).

### D6 — Munición para la semana siguiente

10 tweets sueltos, uno por feature de Tier A/B, que se puedan publicar de uno en uno.
El lanzamiento no es un día; es el hilo + dos semanas de clips.

### D7 — Lista de grabación

Dime **exactamente qué tengo que grabar** antes de publicar: cada clip, su duración
objetivo, el encuadre, y qué NO debe salir en pantalla (buscar el cursor, menús abiertos,
esperas muertas, texto ilegible al tamaño de un móvil). Ordénala por prioridad, porque
grabar es lo que más tiempo me va a costar.

---

## 5. Reglas duras

1. **Investiga primero.** Si la Fase 1 no está hecha, el resto es opinión.
2. **Honestidad total.** Es un proyecto de una persona, de 3 meses, inspirado en la idea de
   otro. Todo eso se dice. Fingir escala de startup en una cuenta de 200 seguidores se nota
   y hunde el post.
3. **El vídeo es el producto.** El texto solo tiene que conseguir que alguien mire el vídeo.
4. Nada de humo: sin métricas falsas, sin "usado por X equipos", sin waitlist inventada.
5. Escribe como un dev enseñando algo que hizo, no como un departamento de marketing.

---

## 6. Formato de tu respuesta

En este orden, con estos títulos: `D1 Investigación` · `D2 Ranking` · `D3 Ancla (5+1)` ·
`D4 Hilo` · `D5 Primera hora` · `D6 Semana siguiente` · `D7 Lista de grabación`.

Sin preámbulo. Empieza en D1.
