# Odla (PLANO's voice assistant) — Problem and goal specification

> **Purpose of this document.** This is a handoff brief for **another AI** to take over the voice
> assistant work in PLANO. It describes **what it is**, **where we want to get to**, **what is
> failing** and the **technical context**. It deliberately contains **no** solutions or
> recommendations on how to fix it — that is what the other AI must design and execute. Only
> problems, the goal, and facts.

---

## 1. What PLANO is and what "Odla" is

**PLANO** is a desktop app (Electron + React + TypeScript) with an infinite-canvas IDE model: a
spatial canvas per project where the user places floating *panels* (terminals, editors, browsers, AI
agents, explorer, git, markdown, notes, regions, etc.).

**Odla** is PLANO's **global voice assistant**. The idea: the user **speaks** (holding a push-to-talk
key or pressing a microphone button) and Odla **executes actions in the app** — opening, closing,
moving and organizing panels, managing workspaces, launching AI agents in terminals, etc. While the
user speaks, the whole window lights up with a voice-reactive "aura".

Odla must NOT reinvent actions: it maps **voice → commands/actions that already exist** in the app.

---

## 2. Where we want to get to (the goal)

The goal is **one and simple to state, but not met today**:

> **That Odla understands what I say, ALWAYS, perfectly, in Spanish AND in English (mixed, without
> confusing the languages), and executes the right command every time.**

Concretely, "done" means:

1. I speak a normal sentence at normal speed and Odla **transcribes well** what I said.
2. It works **as well in Spanish as in English**, without having to configure the language.
3. **Every command** on the list (section 4) is recognized and executed **reliably and repeatably**
   (not "sometimes yes, sometimes no").
4. It works **with my real microphone**, with the PC configured as it is, without me having to touch
   operating-system settings.
5. The live transcription (what gets written as I speak) **matches** what I say.
6. It is **robust**: short phrases, long phrases, single words, Latin American accent, etc.

**Important:** the user states that **early in development this worked well** (it understood Spanish
and English with the Parakeet model) and that **at some point it broke**. The goal is to get back to
that state and leave it perfect and stable.

---

## 3. The current problem (symptoms)

- **It barely understands anything, in Spanish or English.** This is the main, blocking symptom.
- The behavior is **inconsistent**: sometimes it catches something, most of the time it does not.
- The experience is one of "it is not listening" / "it does not understand me" across the board.
- Multiple changes to the capture/transcription pipeline **have not solved** the problem (and at some
  point made it worse). The user wants it investigated to the root and left **perfect, error-free**.

---

## 4. Commands that must work (bilingual es/en)

All of these must be recognized and execute the right action, spoken in **Spanish or English**:

**Create panels**
- "abre una terminal" / "open a terminal"; "abre tres terminales" / "create three terminals"
- "abre un navegador" / "open a browser"; "abre un navegador con YouTube" / "open a browser with GitHub"
- "abre un editor / archivos" / "open the files / editor"
- "crea una nota / documento" / "create a note"; "nota adhesiva" / "sticky note"
- "abre git", "crea una región", "pon una etiqueta", "pomodoro", "lista de tareas", etc.

**AI agents in terminal**
- "abre claude" / "open claude", "abre codex", "abre gemini", "kiro", "opencode", "aider"
- "corre claude en todas las terminales" / "run claude in every terminal"

**Close / focus**
- "cierra esto" / "close this"; "cierra todo" / "close everything"
- "cierra el navegador" / "close the browser"; "cierra todas las terminales"
- "ve a la terminal 2" / "go to terminal two"; "muéstrame el navegador"

**Write a prompt in a specific terminal/agent**
- "Terminal 1, <whatever>" → types/runs that text in terminal 1
  (e.g. "Terminal 1, de qué trata este folder")
- "dile a claude que <...>" / "tell claude to <...>"

**View / organization**
- "organiza todo" / "organize everything"; "ajusta la vista" / "zoom to fit"; "acerca/aleja"

**Workspaces**
- "crea un workspace" / "new workspace" (and every logical form: haz/agrega/dame un workspace…)
- "siguiente workspace" / "next workspace"; "workspace anterior"; "ve al workspace 2"; "cierra el workspace"

**Undo**
- "deshaz eso" / "deshazlo" / "undo that" / "reviértelo" / "me equivoqué" / "cancela eso"

**Queries**
- "qué está corriendo" / "what is running"; "qué paneles tengo abiertos"

**Text input (no voice)**
- A text bar (center-bottom of the HUD) for typing the command when not using voice; it must go
  through the same interpretation engine as voice.

**Live transcription**
- While speaking, what is said gets written into the HUD and, when finished, executes on its own.

---

## 5. Requirements and constraints (non-negotiable)

1. **100% local ASR with the NVIDIA Parakeet model** (TDT 0.6B v3 multilingual, int8), via
   `sherpa-onnx-node`. The model ships **packaged in the installer**. The user explicitly asked to
   **use Parakeet** ("I want parakeet, the best of parakeet").
2. **No audio to the cloud.** The user was explicit: *"let's not put the load on Gemini, because it
   might not work well"*. Audio never leaves the machine. (Gemini may optionally be used only to
   interpret **text** that is already transcribed — never audio — and always with the local grammar
   as fallback. The API key is never hardcoded in the source code; it lives only in
   `userData/settings.json`.)
3. **Simultaneous bilingual es + en.** It must understand both without the user switching languages
   and without confusing the two.
4. **UI 100% in English** (project rule), even though the user speaks Spanish. The design system is
   dark/monochrome "Monolith"; new controls must use the design tokens.
5. **Robust and stable**: no regressions, no "sometimes". The user highly values it being reliable.
6. The architecture must follow the app pattern: `renderer` (UI/capture) ↔ `preload` (bridge) ↔
   `main` (Node/privileged, where the native ASR lives).

---

## 6. Map of the relevant code (where to look)

> This is location context, not instructions on what to change.

**Main (Node, privileged)**
- `src/main/services/VoiceService.ts` — loads the sherpa-onnx `OfflineRecognizer` (Parakeet) and
  exposes `transcribe(pcm, sampleRate)` and `interpret(...)` (Gemini, optional). The packaged model
  path is resolved here.
- `src/main/ipc/registerIpc.ts` — registers the IPC handlers for the `voice` domain.
- `src/main/index.ts` — wires services.

**Preload (bridge)**
- `src/preload/index.ts` — exposes `window.plano.voice.*`.

**Shared (types/contracts, no DOM/Node/Electron)**
- `src/shared/ipc/channels.ts` and `src/shared/ipc/contracts.ts` — channel names + types
  (`VoiceTranscribeRequest/Result`, etc.) + the `PlanoApi` interface.
- `src/shared/domain/settings.ts` — `VoiceSettings` (Odla config) + `DEFAULT_SETTINGS`.

**Renderer (UI + capture + orchestration)**
- `src/renderer/voice/audio/mic.ts` — **microphone capture** (getUserMedia → AudioContext → PCM).
  Critical point of the current problem.
- `src/renderer/voice/controller.ts` — state machine: push-to-talk, capture, transcription, live
  transcription (partials), execution, SFX, aura.
- `src/renderer/voice/VoiceOverlay.tsx` + `voice.css` — HUD: full-window aura, microphone button,
  text bar, live caption.
- `src/renderer/voice/orchestrator/` — text → action interpretation:
  - `synonyms.ts` (bilingual vocabulary), `grammar.ts` (`parseIntent`), `fuzzy.ts` (matching
    tolerant of ASR errors), `execute.ts` (executes the intent against the stores/actions),
    `gemini.ts` (optional LLM interpretation), `types.ts`, `index.ts`.
- `src/renderer/types/global.d.ts` — type augmentation of `window.plano`.

**Packaging**
- `package.json` (electron-builder: `extraResources` for the model, `asarUnpack` for sherpa's native
  binary) and `scripts/fetch-model.mjs` (model download/staging).

---

## 7. What has been observed during diagnosis (facts, not solutions)

> Data collected so we do not start blind. These are **observations**, not closed conclusions or
> indications of what to do.

- With **clean audio** (test files), the Parakeet int8 model **transcribes Spanish and English well**
  and the grammar routes commands correctly. In other words: the model and the grammar, given good
  audio, respond.
- The failure shows up with the **audio arriving from the real live microphone**, not with files.
- There is an optional diagnostic dump in `%APPDATA%\PLANO\voice-debug\` (last captured audio as
  `.wav`, its transcription, RMS/peak level, and a `transcripts.log`). In the user's tests, several
  captures came out **practically silent** (very low RMS level) or **too short** to contain a
  sentence; the model then returns empty or isolated syllables.
- The user's setup has **several audio input devices**, including **virtual/software devices** (e.g.
  of the "SteelSeries Sonar Virtual Audio Device" kind) in addition to the **physical microphone**
  ("HyperX SoloCast"). The system's *default* input device and the one the app picks up may not be
  the physical microphone.
- The browser `AudioContext` on this machine runs at **96 kHz** (not 44.1/48 kHz).
- The HUD microphone button works as a **toggle** (click to start, click to end); the push-to-talk
  default is `Ctrl+Shift+Space`.
- "deshaz eso" in particular is hard for the model (sometimes it transcribes it as something else or
  jumps to English); other "undo" forms transcribe more consistently.

---

## 8. Success criteria (definition of "done")

The other AI must consider the work finished **only when**, with the user's real microphone and
speaking at normal speed:

1. A battery of **Spanish** commands (those in section 4) is recognized and executed **reliably**.
2. The **same** battery in **English** too, without changing the language configuration.
3. Mixing languages between commands breaks nothing (it does not "stick" to one language).
4. The live transcription matches what is said.
5. It is **repeatable**: the same command said several times is understood every time.
6. `npm run typecheck` passes (mandatory project gate; there are no tests or linter configured).

> The user insists: **do not finish until both languages work perfectly, together, always.**

---

## 9. Useful project commands

```bash
npm run dev          # development with hot-reload
npm run typecheck    # tsc --noEmit for both projects (node + web) — the ONLY automatic gate
npm run build        # production build (electron-vite → out/)
npm run dist         # build + installer (electron-builder)
```

(On this machine the NSIS installer has caused problems; PLANO has been installed by copying
`release/win-unpacked` to `%LOCALAPPDATA%\Programs\PLANO`. This is an environment detail, not part of
the goal.)
