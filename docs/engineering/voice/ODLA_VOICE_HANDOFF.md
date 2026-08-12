# Odla (asistente de voz de PLANO) — Especificación de problema y objetivo

> **Propósito de este documento.** Es un *brief* de traspaso para que **otra IA** retome el trabajo
> del asistente de voz de PLANO. Aquí se describe **qué es**, **a dónde queremos llegar**, **qué está
> fallando** y el **contexto técnico**. **No** contiene soluciones ni recomendaciones de cómo
> arreglarlo — eso es lo que la otra IA debe diseñar y ejecutar. Solo problemas, objetivo y hechos.

---

## 1. Qué es PLANO y qué es "Odla"

**PLANO** es una app de escritorio (Electron + React + TypeScript) tipo IDE de lienzo infinito: un
canvas espacial por proyecto donde el usuario coloca *paneles* flotantes (terminales, editores,
navegadores, agentes de IA, explorador, git, markdown, notas, regiones, etc.).

**Odla** es el **asistente de voz global** de PLANO. La idea: el usuario **habla** (manteniendo una
tecla push-to-talk o pulsando un botón de micrófono) y Odla **ejecuta acciones en la app** — abrir,
cerrar, mover y organizar paneles, gestionar workspaces, lanzar agentes de IA en terminales, etc.
Mientras se habla, toda la ventana se enciende con un "aura" reactiva a la voz.

Odla NO debe reinventar acciones: mapea **voz → comandos/acciones que ya existen** en la app.

---

## 2. A dónde queremos llegar (objetivo)

El objetivo es **uno y simple de enunciar, pero hoy no se cumple**:

> **Que Odla entienda lo que digo, SIEMPRE, perfectamente, en español Y en inglés (mezclados, sin
> que se confunda de idioma), y que ejecute el comando correcto cada vez.**

Concretamente, "terminado" significa:

1. Hablo una frase normal a velocidad normal y Odla **transcribe bien** lo que dije.
2. Funciona **igual de bien en español que en inglés**, sin tener que configurar el idioma.
3. **Cada comando** de la lista (sección 4) se reconoce y se ejecuta de forma **fiable y repetible**
   (no "a veces sí, a veces no").
4. Funciona **con mi micrófono real**, tal como tengo el PC configurado, sin que yo tenga que tocar
   ajustes del sistema operativo.
5. La transcripción en vivo (lo que se va escribiendo mientras hablo) **corresponde** a lo que digo.
6. Es **robusto**: frases cortas, frases largas, palabras sueltas, acento latino, etc.

**Importante:** el usuario afirma que **al principio del desarrollo esto funcionaba bien** (entendía
español e inglés con el modelo Parakeet) y que **en algún momento se rompió**. El objetivo es volver a
ese estado y dejarlo perfecto y estable.

---

## 3. El problema actual (síntomas)

- **No entiende casi nada, ni en español ni en inglés.** Es el síntoma principal y bloqueante.
- El comportamiento es **inconsistente**: a veces capta algo, la mayoría de las veces no.
- La experiencia es de "no me escucha" / "no me entiende" de forma generalizada.
- Se han hecho múltiples cambios al pipeline de captura/transcripción que **no han resuelto** el
  problema (y en algún punto lo empeoraron). El usuario quiere que se llegue al fondo y quede
  **perfecto, sin errores**.

---

## 4. Comandos que deben funcionar (bilingüe es/en)

Todos estos deben reconocerse y ejecutar la acción correcta, dichos en **español o inglés**:

**Crear paneles**
- "abre una terminal" / "open a terminal"; "abre tres terminales" / "create three terminals"
- "abre un navegador" / "open a browser"; "abre un navegador con YouTube" / "open a browser with GitHub"
- "abre un editor / archivos" / "open the files / editor"
- "crea una nota / documento" / "create a note"; "nota adhesiva" / "sticky note"
- "abre git", "crea una región", "pon una etiqueta", "pomodoro", "lista de tareas", etc.

**Agentes de IA en terminal**
- "abre claude" / "open claude", "abre codex", "abre gemini", "kiro", "opencode", "aider"
- "corre claude en todas las terminales" / "run claude in every terminal"

**Cerrar / enfocar**
- "cierra esto" / "close this"; "cierra todo" / "close everything"
- "cierra el navegador" / "close the browser"; "cierra todas las terminales"
- "ve a la terminal 2" / "go to terminal two"; "muéstrame el navegador"

**Escribir un prompt en una terminal/agente concreto**
- "Terminal 1, <lo que sea>" → escribe/ejecuta ese texto en la terminal 1
  (ej: "Terminal 1, de qué trata este folder")
- "dile a claude que <...>" / "tell claude to <...>"

**Vista / organización**
- "organiza todo" / "organize everything"; "ajusta la vista" / "zoom to fit"; "acerca/aleja"

**Workspaces**
- "crea un workspace" / "new workspace" (y todas las formas lógicas: haz/agrega/dame un workspace…)
- "siguiente workspace" / "next workspace"; "workspace anterior"; "ve al workspace 2"; "cierra el workspace"

**Deshacer**
- "deshaz eso" / "deshazlo" / "undo that" / "reviértelo" / "me equivoqué" / "cancela eso"

**Consultas**
- "qué está corriendo" / "what is running"; "qué paneles tengo abiertos"

**Entrada por texto (sin voz)**
- Una barra de texto (centro-abajo del HUD) para escribir el comando cuando no se usa la voz; debe
  pasar por el mismo motor de interpretación que la voz.

**Transcripción en vivo**
- Mientras se habla, lo dicho se va escribiendo en el HUD y, al terminar, se ejecuta solo.

---

## 5. Requisitos y restricciones (no negociables)

1. **ASR 100% local con el modelo NVIDIA Parakeet** (TDT 0.6B v3 multilingüe, int8), vía
   `sherpa-onnx-node`. El modelo va **empaquetado** en el instalador. El usuario pidió expresamente
   **usar Parakeet** ("yo quiero parkeet, el mejor de parkeet").
2. **No enviar audio a la nube.** El usuario fue explícito: *"no le pongamos la carga a Gemini, porque
   de pronto no sirve bien"*. El audio nunca sale de la máquina. (Gemini puede usarse, opcionalmente,
   solo para interpretar **texto** ya transcrito — nunca audio — y siempre con la gramática local como
   respaldo. La API key jamás se hardcodea en el código fuente; vive solo en `userData/settings.json`.)
3. **Bilingüe es + en simultáneo.** Debe entender ambos sin que el usuario cambie de idioma y sin
   confundirse entre ellos.
4. **UI 100% en inglés** (regla del proyecto), aunque el usuario hable español. El sistema de diseño
   es oscuro/monocromo "Monolith"; nuevos controles deben usar los tokens de diseño.
5. **Robusto y estable**: no regresiones, no "a veces". El usuario valora mucho que quede fiable.
6. La arquitectura debe seguir el patrón de la app: `renderer` (UI/captura) ↔ `preload` (puente) ↔
   `main` (Node/privilegiado, donde vive el ASR nativo).

---

## 6. Mapa del código relevante (dónde mirar)

> Esto es contexto de ubicación, no instrucciones de qué cambiar.

**Main (Node, privilegiado)**
- `src/main/services/VoiceService.ts` — carga el `OfflineRecognizer` de sherpa-onnx (Parakeet) y
  expone `transcribe(pcm, sampleRate)` e `interpret(...)` (Gemini, opcional). Aquí se resuelve la ruta
  del modelo empaquetado.
- `src/main/ipc/registerIpc.ts` — registra los handlers IPC del dominio `voice`.
- `src/main/index.ts` — cablea servicios.

**Preload (puente)**
- `src/preload/index.ts` — expone `window.plano.voice.*`.

**Shared (tipos/contratos, sin DOM/Node/Electron)**
- `src/shared/ipc/channels.ts` y `src/shared/ipc/contracts.ts` — nombres de canal + tipos
  (`VoiceTranscribeRequest/Result`, etc.) + interfaz `PlanoApi`.
- `src/shared/domain/settings.ts` — `VoiceSettings` (config de Odla) + `DEFAULT_SETTINGS`.

**Renderer (UI + captura + orquestación)**
- `src/renderer/voice/audio/mic.ts` — **captura de micrófono** (getUserMedia → AudioContext →
  PCM). Punto crítico del problema actual.
- `src/renderer/voice/controller.ts` — máquina de estados: push-to-talk, captura, transcripción,
  transcripción en vivo (parciales), ejecución, SFX, aura.
- `src/renderer/voice/VoiceOverlay.tsx` + `voice.css` — HUD: aura full-window, botón de micrófono,
  barra de texto, caption en vivo.
- `src/renderer/voice/orchestrator/` — interpretación texto → acción:
  - `synonyms.ts` (vocabulario bilingüe), `grammar.ts` (`parseIntent`), `fuzzy.ts` (matching
    tolerante a errores de ASR), `execute.ts` (ejecuta el intent contra los stores/acciones),
    `gemini.ts` (interpretación opcional por LLM), `types.ts`, `index.ts`.
- `src/renderer/types/global.d.ts` — augmentación de tipos de `window.plano`.

**Empaquetado**
- `package.json` (electron-builder: `extraResources` para el modelo, `asarUnpack` para el binario
  nativo de sherpa) y `scripts/fetch-model.mjs` (descarga/staging del modelo).

---

## 7. Lo que se ha observado durante el diagnóstico (hechos, no soluciones)

> Datos recogidos para no empezar a ciegas. Son **observaciones**, no conclusiones cerradas ni
> indicaciones de qué hacer.

- Con **audio limpio** (archivos de prueba), el modelo Parakeet int8 **transcribe bien español e
  inglés** y la gramática rutea los comandos correctamente. Es decir: el modelo y la gramática, sobre
  audio bueno, responden.
- El fallo se manifiesta con el **audio que llega del micrófono real en vivo**, no con archivos.
- Existe un volcado de diagnóstico opcional en `%APPDATA%\PLANO\voice-debug\` (último audio capturado
  como `.wav`, su transcripción, nivel RMS/pico, y un `transcripts.log`). En las pruebas del usuario,
  varias capturas salieron **prácticamente en silencio** (nivel RMS muy bajo) o **demasiado cortas**
  para contener una frase; el modelo entonces devuelve vacío o sílabas sueltas.
- El equipo del usuario tiene **varios dispositivos de entrada de audio**, incluyendo **dispositivos
  virtuales/de software** (p. ej. del tipo "SteelSeries Sonar Virtual Audio Device") además del
  **micrófono físico** ("HyperX SoloCast"). El dispositivo de entrada *por defecto* del sistema y el
  que toma la app pueden no ser el micrófono físico.
- El `AudioContext` del navegador en esta máquina corre a **96 kHz** (no 44.1/48 kHz).
- El botón de micrófono del HUD funciona como **toggle** (clic para empezar, clic para terminar); el
  push-to-talk por defecto es `Ctrl+Shift+Space`.
- "deshaz eso" en particular es difícil para el modelo (a veces lo transcribe como otra cosa o salta
  al inglés); otras formas de "deshacer" se transcriben de forma más consistente.

---

## 8. Criterio de éxito (definición de "hecho")

La otra IA debe considerar el trabajo terminado **solo cuando**, con el micrófono real del usuario y
hablando a velocidad normal:

1. Una batería de comandos en **español** (los de la sección 4) se reconoce y ejecuta **fiablemente**.
2. La **misma** batería en **inglés** también, sin cambiar configuración de idioma.
3. Mezclar idiomas entre comandos no rompe nada (no se "queda" en un idioma).
4. La transcripción en vivo corresponde a lo dicho.
5. Es **repetible**: el mismo comando dicho varias veces se entiende todas las veces.
6. `npm run typecheck` pasa (gate obligatorio del proyecto; no hay tests ni linter configurados).

> El usuario insiste: **no terminar hasta que ambos idiomas funcionen perfectamente, juntos, siempre.**

---

## 9. Comandos útiles del proyecto

```bash
npm run dev          # desarrollo con hot-reload
npm run typecheck    # tsc --noEmit de los dos proyectos (node + web) — ÚNICO gate automático
npm run build        # build de producción (electron-vite → out/)
npm run dist         # build + instalador (electron-builder)
```

(En esta máquina, el instalador NSIS ha dado problemas; se ha instalado copiando `release/win-unpacked`
a `%LOCALAPPDATA%\Programs\PLANO`. Es un detalle de entorno, no del objetivo.)
