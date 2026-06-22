# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What PLANO is

A **desktop app** (Electron): an infinite-canvas workspace IDE. One spatial pan/zoom canvas per project where the user drops floating **panels** — terminals, code editors, browsers, AI agents, file explorer, git, markdown, sticky notes, text, regions. Layout persists per project. Signature feature: terminals **auto-detect** when an AI coding CLI (Claude Code, Codex, …) is running inside them and morph into "agent mode".

Full specs live in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and [`docs/DESIGN_SYSTEM.md`](docs/DESIGN_SYSTEM.md) — read them before non-trivial changes.

## Commands

```bash
npm install            # deps (see Electron-binary gotcha below)
npm run rebuild        # rebuild node-pty against Electron's ABI (needs VS C++ Build Tools on Windows)
npm run dev            # launch with HMR (renderer) + hot-reload (main/preload)
npm run build          # electron-vite production build into out/
npm run typecheck      # tsc --noEmit for BOTH projects (node + web); run before considering work done
npm run typecheck:node # main + preload + shared only
npm run typecheck:web  # renderer + shared only
npm run dist           # build + package an installer (electron-builder)
```

There is **no test runner wired yet** and **no linter configured** (ESLint is referenced in comments but not installed). `npm run typecheck` is the only automated gate — always run it after edits.

## Environment gotchas (Windows — hit these during setup)

- **Electron binary may be missing after `npm install`.** Symptom: `npm run dev` fails with `Error: Electron uninstall`. Cause: a corrupt zip in `%LOCALAPPDATA%\electron\Cache` makes `@electron/get` report a false "cache hit", and Electron's own `extract-zip` silently stops after the first file. Fix: extract the cached zip manually —
  `Expand-Archive <cache>\electron-v*-win32-x64.zip node_modules/electron/dist -Force` then write `electron.exe` into `node_modules/electron/path.txt`.
- **node-pty is native.** `npm run rebuild` (electron-rebuild) needs the Visual Studio *"Desktop development with C++"* workload. If it's absent, terminals can't be built from source. In practice the prebuilt node-pty binary for Node 20 has matched Electron 33's ABI, so terminals load without a rebuild — but don't rely on it across Electron upgrades.
- **node-pty loads tolerantly:** `PtyManager` lazy-`require`s node-pty and, on failure, streams a guidance message to the terminal panel instead of crashing the app. Keep that resilience when touching `PtyManager`.
- **Known open issue:** under Electron on Windows, node-pty's `conpty_console_list_agent` can throw `AttachConsole failed`. This is a ConPTY-console-list problem, not an ABI problem. Wrap `mod.spawn(...)` defensively when working in `PtyManager`.

## Architecture (the parts that span files)

Three TypeScript projects, hard-separated by `tsconfig.node.json` (main+preload+shared) vs `tsconfig.web.json` (renderer+shared):

```
renderer (Chromium, sandboxed)  ──window.plano──▶  preload (bridge)  ──IPC──▶  main (Node, privileged)
```

- **`src/shared/`** — types + IPC contracts imported by both sides. **Never** import node/electron/dom here; it must stay environment-agnostic. `ipc/channels.ts` is the single source of truth for channel names; `ipc/contracts.ts` defines payloads **and** the `PlanoApi` interface that `window.plano` implements.
- **`src/main/`** — owns all privilege. `index.ts` wires services and injects a `post(channel, payload)` fn (main→renderer events) into them. `ipc/registerIpc.ts` is the only place handlers are registered and is the trust boundary. Services in `services/` hold the logic.
- **`src/preload/index.ts`** — the only bridge; exposes a frozen `window.plano`. Its global type augmentation lives in **`src/renderer/types/global.d.ts`** (NOT `preload/index.d.ts`, which the renderer tsconfig doesn't include — adding `window.plano` members requires editing both the contract and that renderer d.ts or the renderer won't see them).
- **`src/renderer/`** — UI only. Talks to main exclusively via `window.plano`.

### Renderer mental model

- **Infinite canvas** (`canvas/`): `useViewportStore` is the camera `{x,y,zoom}`. `PanelLayer` is one `translate()+scale()` world container; panels are positioned at **world** coordinates inside it and inherit the transform for free (this is why browser panels use Electron `<webview>` — a DOM element that transforms with the canvas; it's also why Electron was chosen over Tauri). Screen↔world conversion is in `shared/domain/geometry.ts`.
- **State is zustand**, one store per concern (`stores/`). `usePanelStore` (immer) is the persisted heart — panels keyed by id with `{type, rect, z, props}`. `useViewportStore`, `useUiStore` (menus/palette), `useTerminalStore` (panelId→ptyId runtime), `useAgentStore` (ptyId→detection verdict), `useWorkspaceStore`.
- **Panels** (`panels/`): one folder per type. `panels/_base/PanelFrame.tsx` renders the shared rounded chrome + drag/8-way-resize + the agent-mode morph; `_base/PanelRegistry.ts` maps `PanelType → component`. Panel data model + per-type props + `PANEL_META` (label/icon/defaultSize) are in `shared/domain/panel.ts`.
- **App shell** (`chrome/`): `TopBar`, `Dock`, `ContextMenu` (the full canvas right-click menu), `CommandPalette` (⌘K), `EmptyState`. Cross-cutting actions live in `app/actions.ts` (add panel at world/center, zoom-to-fit) and `app/workspaceActions.ts` (open/load/save). `App.tsx` restores the most-recent workspace on launch and debounced-autosaves on panel/viewport changes.

### Signature feature — agent detection (`main/services/`)

`AgentDetectionService` fuses two signals per terminal: (1) the **descendant process tree** of the shell PID node-pty gives us, matched on name **and** command line against a signature table (Windows reads `Win32_Process` via PowerShell/CIM in `ProcessTreeService`; one shared snapshot is reused by all terminals); (2) **output banner** sniffing of the PTY stream. Hysteresis: quick to enter, sticky to leave. Emits `agent:signal` only on a changed verdict → the terminal panel morphs. When extending detected CLIs, edit the signature table in `AgentDetectionService.ts` and `AGENTS`/`AgentKind` in `shared/domain/agent.ts`.

### Persistence

Per-project at `<projectFolder>/.plano/workspace.json` (atomic temp+rename, `schemaVersion` for migrations). Runtime-only data (ptyId, webview ids) is deliberately not persisted — terminals respawn, browsers re-navigate. App-global recents live in Electron `userData`. App-global **settings** also live there as `userData/settings.json` (`SettingsService`, tolerant `mergeSettings` over `DEFAULT_SETTINGS`), surfaced to the renderer via `useSettingsStore` + the Settings modal (`chrome/settings/`).

## Hard design rules (do not break)

The "Monolith Draft" design system is the **locked default** (see `docs/DESIGN_SYSTEM.md`, tokens in `src/renderer/styles/theme.css`, referenced via `var(--…)` in `tailwind.config.js` so a runtime theme swap re-tints every utility class):

- **100% English UI.** Every label/menu/tooltip/placeholder.
- **Dark, monochrome BASE — color as a sparing, harmonious accent (NOT strictly monochrome-only).** Surfaces and the bulk of the chrome are white + WARM-neutral grays, but color **is** allowed for **small, meaningful accents** as long as it reads as harmonious, never a decorative flood. Established uses: a detected agent's panel tint, per-workspace colors, a themed terminal's panel border + status dot, and the user's chosen accent/theme. Red `#EF4444` stays reserved for destructive/armed. User content (terminal ANSI, code syntax, web pages) always keeps its own color. The warm ramp (Red ≥ Blue) still steers away from the cool/zinc "AI-SaaS" look.
- **User theming (opt-in, intentional — do NOT revert):** Settings → Appearance offers alternative themes (incl. colored Indigo/Cyber and a Light theme) + an accent picker; they override the `theme.css` variables at runtime via `src/renderer/theme/themes.ts` + `useSettingsStore`. The default ships as monochrome Monolith — a colored theme/accent a user picked is a feature, not a violation. New chrome must still style via tokens so it themes correctly.
- **Color-accent precedents (intentional — do NOT revert), every one token/CSS-var driven:** a detected agent tints its panel chrome (border + header accent + breathing glow) via `--agent-accent` (`AGENTS[kind].accent`, `src/shared/domain/agent.ts`); a themed terminal tints its OWN panel border + status dot via `getTerminalThemeAccent` (`panels/terminal/terminalThemes.ts`); workspaces carry their own color. Add new color the same way: scoped to one element, harmonious, sourced from a token/var — not hardcoded ad-hoc.
- **Rounded everywhere** (panels 16px, overlays 20px, regions 24px, pills for toggles/search). No sharp brutalist corners.
- Fonts: Space Grotesk (UI) + JetBrains Mono (terminals/code/numeric readouts), bundled offline via Fontsource.
- Style only via the design tokens / Tailwind theme — don't hardcode hex outside `theme.css`/`tailwind.config.js`.

## Common change recipes

- **Add a panel type:** extend `PanelType` + props + `PANEL_META` + `defaultProps` in `shared/domain/panel.ts`; add the component folder under `panels/`; register it in `panels/_base/PanelRegistry.ts`; add menu/dock/palette entries.
- **Add an IPC channel:** add the name to `shared/ipc/channels.ts`, types to `shared/ipc/contracts.ts` (+ the `PlanoApi` method), wrap it in `preload/index.ts`, and register the handler in `main/ipc/registerIpc.ts`. Renderer calls `window.plano.<domain>.<method>()`.
- **Add a setting:** extend the right group in `shared/domain/settings.ts` (+ `DEFAULT_SETTINGS`); add a `SettingRow`/control to the matching section in `renderer/chrome/settings/sections.tsx` (and an entry in `SETTINGS_INDEX` for search); consume it where it applies via `useSettingsStore`. Appearance side-effects (theme/accent/reduced-motion) run through `applyAppearance` in `theme/themes.ts`; grid/grain/terminal read the store reactively.
