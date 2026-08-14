# HILO DE LANZAMIENTO — pega esto, sube esto

Nada de estrategia aquí. Esto es el hilo tal como queda en X.

**Cuándo:** martes o miércoles, 9:30–10:00 AM ET (15:30–16:00 CEST).

**Cómo se publica:**
1. Tweet 1 = post nuevo (no es un reply).
2. A los 10 segundos: Reply A y Reply B debajo del Tweet 1.
3. A los 30–60 segundos: Tweets 2 → 6 como hilo (cada uno es reply del anterior).
4. No numeres. No pongas link en el Tweet 1 ni en los Tweets 2–6.

**Archivos que tienes que tener en disco antes de abrir X:**

```
clips/
  01-mesh.mp4          ← Tweet 1
  02-morph.mp4         ← Tweet 2
  03-spawn.mp4         ← Tweet 3
  04-survive.mp4       ← Tweet 4
  05-phone.mp4         ← Tweet 5
  06-wide.mp4          ← Tweet 6
```

Todos: 1920×1080, 60 fps, **sin audio** (o audio que no importe). Del `01-mesh.mp4` exporta también `01-mesh-square.mp4` a 1080×1080 y sube **ese** en el Tweet 1.

---

## TWEET 1 — el ancla (post nuevo)

**Subes:** `clips/01-mesh-square.mp4`

**El vídeo es esto, segundo a segundo:**

| Tiempo | Qué se ve |
|---|---|
| 0:00 | Dos paneles grandes ya en cuadro. Una curva bezier **ya dibujada** entre ellos. Un pulso luminoso **ya a mitad de camino**. No hay fade-in. No hay escritorio vacío. |
| 0:00–0:02 | El pulso viaja del panel izquierdo al derecho. |
| 0:02–0:03 | Punto respirando en el extremo del receptor. |
| 0:03–0:06 | El pulso vuelve (la respuesta). |
| 0:06–0:09 | La línea se desvanece. |
| 0:09–0:12 | Hold. Nada más se mueve. |

Si el pulso no está en movimiento en el frame 0, no subas este archivo.

**Pegas esto (93 caracteres). Cero link. Cero emoji:**

```
You can watch your AI agents talk to each other.

A line draws itself. A pulse runs along it.
```

Así se ve el composer:

```
You can watch your AI agents talk to each other.

A line draws itself. A pulse runs along it.

[vídeo 01-mesh-square.mp4]
```

---

## REPLY A — debajo del Tweet 1, inmediato

**Subes:** nada. Solo texto.

**Pegas:**

```
Windows + macOS. Free. No account.

https://github.com/zqkra/plano-releases

v0.2.26. Built in about 3 months, one person.
```

Así se ve:

```
↩ Replying to @TU_CUENTA

Windows + macOS. Free. No account.

https://github.com/zqkra/plano-releases

v0.2.26. Built in about 3 months, one person.
```

---

## REPLY B — debajo del Tweet 1, justo después de A

**Subes:** nada.

**Solo si tienes el handle real.** Si no, no publiques este reply.

**Pegas** (cambia `<STREAMER_HANDLE>`):

```
hey <STREAMER_HANDLE> — I saw you sketch this on stream. spent the last 3 months turning that picture into a real desktop app.

agents talk to each other and you can see the messages as lines between the windows. wanted you to see it first. thanks for putting the image in my head.
```

---

## TWEET 2 — reply del Tweet 1

**Subes:** `clips/02-morph.mp4`

**El vídeo es esto:**

| Tiempo | Qué se ve |
|---|---|
| 0:00 | Un solo panel. Terminal normal. Prompt ya dice `claud`. |
| 0:00–0:01 | Escribes `e` y pulsas Enter. |
| 0:01–0:02 | El panel muta: borde se tiñe, aparece el logo del agente, el borde respira. |
| 0:02–0:06 | Hold sobre el panel ya convertido. |

**Pegas (86 caracteres):**

```
Type claude in a normal terminal.

The window changes. No settings. No AI-mode button.
```

Así se ve:

```
↩ Replying to @TU_CUENTA

Type claude in a normal terminal.

The window changes. No settings. No AI-mode button.

[vídeo 02-morph.mp4]
```

---

## TWEET 3 — reply del Tweet 2

**Subes:** `clips/03-spawn.mp4`

**El vídeo es esto:**

| Tiempo | Qué se ve |
|---|---|
| 0:00 | Un agente vivo a la izquierda. Canvas vacío a la derecha. El prompt **ya está escrito**, grande: `spawn two reviewers and wait`. |
| 0:00–0:01 | Enter. |
| 0:01–0:04 | Nacen tres paneles. |
| 0:04–0:07 | Se dibujan las curvas. Sale un pulso. |
| 0:07–0:10 | Hold. |

No se ve escribir el prompt. Si el agente tarda, jump-cut.

**Pegas (75 caracteres):**

```
One prompt. Three windows open themselves.

The lines show up on their own.
```

Así se ve:

```
↩ Replying to @TU_CUENTA

One prompt. Three windows open themselves.

The lines show up on their own.

[vídeo 03-spawn.mp4]
```

---

## TWEET 4 — reply del Tweet 3

**Subes:** `clips/04-survive.mp4`

**El vídeo es esto:**

| Tiempo | Qué se ve |
|---|---|
| 0:00–0:03 | Un agente emitiendo texto. Se ve el scroll. |
| 0:03–0:04 | Cierras PLANO (Alt+F4 / Cmd+Q). Se ve el close. |
| 0:04–0:05 | Escritorio. 1 segundo. |
| 0:05–0:10 | Reabres. El mismo panel, el mismo scroll, el mismo texto a medias. |

**Pegas (87 caracteres):**

```
Close the app. The agents keep working.

Open it again. Same scroll. Same conversation.
```

Así se ve:

```
↩ Replying to @TU_CUENTA

Close the app. The agents keep working.

Open it again. Same scroll. Same conversation.

[vídeo 04-survive.mp4]
```

---

## TWEET 5 — reply del Tweet 4

**Subes:** `clips/05-phone.mp4`

**El vídeo es esto:**

| Tiempo | Qué se ve |
|---|---|
| 0:00–0:02 | Split o corte: PC con PLANO cerrado. |
| 0:02–0:05 | Teléfono real (no emulador). Lista de agentes. Escribes una línea. Envío. |
| 0:05–0:08 | El agente responde en el teléfono. |

No sale QR, no sale IP, no sale “connecting…”.

**Pegas (61 caracteres):**

```
Same agents, from your phone.

The desktop app can be closed.
```

Así se ve:

```
↩ Replying to @TU_CUENTA

Same agents, from your phone.

The desktop app can be closed.

[vídeo 05-phone.mp4]
```

---

## TWEET 6 — reply del Tweet 5 (cierre)

**Subes:** `clips/06-wide.mp4`

**El vídeo es esto:**

| Tiempo | Qué se ve |
|---|---|
| 0:00–0:04 | Plano ancho. 4 o 5 paneles. 2 o 3 líneas vivas. Sin cursor. Hold. No hay acción. Es la postal. |

**Pegas (115 caracteres). Sin URL:**

```
PLANO. A desktop for Windows and Mac. Free.

If you already run two agents at once: what do you wish you could see?
```

Así se ve:

```
↩ Replying to @TU_CUENTA

PLANO. A desktop for Windows and Mac. Free.

If you already run two agents at once: what do you wish you could see?

[vídeo 06-wide.mp4]
```

---

## Cuenta secundaria (español) — solo el ancla

Mismo vídeo: `clips/01-mesh-square.mp4`.

```
Puedes ver a tus agentes de IA hablar entre ellos.

Una línea se dibuja sola. Un pulso corre por ella.
```

Reply del ancla:

```
Windows + macOS. Gratis. Sin cuenta.

https://github.com/zqkra/plano-releases
```

El hilo 2–6 lo puedes dejar en inglés o no publicarlo en la secundaria. No traduzcas el hilo si no vas a grabar los clips otra vez con UI en español (la UI es inglés).

---

## SI EL ANCLA NO ARRANCA

No borres el hilo. No publiques otro el mismo día.

**Jueves 9:30 AM ET — post nuevo, no quote:**

**Subes:** `clips/02-morph.mp4` (el mismo del Tweet 2)

**Pegas:**

```
I built a desktop where your AI agents live as windows.

You can see them talk.
```

Reply con el mismo link de GitHub.

---

## SEMANA SIGUIENTE — un post suelto al día

Cada uno es un tweet nuevo, no un hilo. Link solo si preguntan, o en la primera reply.

### Día +1

**Subes:** `clips/07-voice.mp4`  
8s. Hablas. Nacen dos paneles y se colocan. Sin transcripción en pantalla.

```
I said “open two Claudes next to the browser.” They appeared.
```

### Día +2

**Subes:** `clips/08-dock.mp4`  
6s. Arrastras un panel sobre otro. Se fusionan en split.

```
Drag one window onto another. They snap.
```

### Día +3

**Subes:** `clips/09-restore.mp4`  
8s. Último mensaje visible → cierras → abres → el mismo hilo del agente, no uno en blanco.

```
Quit. Reopen. The agent continues the same conversation, not a blank one.
```

### Día +4

**Subes:** `clips/10-git.mp4`  
5s. `git checkout` en el panel. El badge de rama cambia.

```
Each terminal wears the branch it's actually on.
```

### Día +5

**Subes:** `clips/11-browser.mp4`  
6s. Zoom out del canvas. La web se escala con él. Un click dentro sigue funcionando.

```
That's a live webview. It zooms with the canvas. Not a screenshot.
```

### Día +6

**Subes:** `clips/12-tabs.mp4`  
6s. Tres tabs. Cambias el tema. El borde del panel se tiñe.

```
Tabs per terminal. Theme per terminal. Font zoom per terminal.
```

### Día +7

**Subes:** `clips/13-focus.mp4`  
5s. Focus on. Todo lo demás se oscurece. El agente sigue.

```
One window. Everything else dims. The agent keeps running in the dark.
```

### Día +8

**Subes:** `clips/14-sticky.mp4`  
5s. Una nota pegada al lado del agente que la está reescribiendo.

```
A sticky note next to the agent that is rewriting it.
```

### Día +9

**Subes:** `clips/15-region.mp4`  
6s. Dibujas una región. Tres paneles dentro. Una línea cruza el borde.

```
A region is just a named rectangle. The agents inside it are a team.
```

### Día +10

**Subes:** `clips/16-palette.mp4`  
5s. Cmd-K → “new agent” → nace un panel.

```
Cmd-K. New agent, new terminal, zoom to fit.
```

---

## Mapa rápido

| Dónde | Pegar | Subir |
|---|---|---|
| Tweet 1 (ancla) | `You can watch your AI agents talk to each other.` + 2ª línea | `01-mesh-square.mp4` |
| Reply A | download + free + v0.2.26 | nada |
| Reply B | crédito al streamer | nada |
| Tweet 2 | `Type claude in a normal terminal.` | `02-morph.mp4` |
| Tweet 3 | `One prompt. Three windows open themselves.` | `03-spawn.mp4` |
| Tweet 4 | `Close the app. The agents keep working.` | `04-survive.mp4` |
| Tweet 5 | `Same agents, from your phone.` | `05-phone.mp4` |
| Tweet 6 | `PLANO. A desktop for Windows and Mac. Free.` | `06-wide.mp4` |
