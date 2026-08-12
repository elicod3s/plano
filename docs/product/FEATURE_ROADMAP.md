# PLANO — Feature Roadmap

> Research-grounded feature roadmap for PLANO (infinite-canvas workspace IDE).
> Produced 2026-06-16 from a multi-agent pass: web research across comparable apps
> (Warp, Cursor, Zed, Conductor/Crystal, Claude Code, tldraw, Figma/FigJam, Heptabase,
> Raycast, tmux/zellij…), grounded in PLANO's actual codebase, then adversarially
> pressure-tested for real feasibility.
>
> **Guiding fact:** nearly everything here rides infrastructure PLANO *already has* —
> `PtyManager` fans out every terminal byte, `AgentDetectionService` knows which agent
> runs in each terminal (+ first prompt + phase), `DevUrlService` extracts dev URLs.
> Most features are **consumers** of existing data, not new plumbing.

---

## How to read this

Features are grouped into **waves** by dependency order and impact-per-effort. Each wave's
"⚠️ Gotchas" are the corrections the adversarial review surfaced — they are the difference
between a demo and something that actually works. Effort: **S** (days) · **M** · **L** · **XL**.
Impact: 1–5.

---

## 🌊 Wave 1 — Quick wins (days, on data that already exists)

No new infrastructure. These make a many-agent canvas livable immediately.

| Feature | What it does | Effort | Impact |
|---|---|:---:|:---:|
| **Agent-finished / needs-input notifications + jump-to-panel** | When an off-screen agent finishes its turn or asks for confirmation, fire an OS notification + in-app toast; clicking flies the camera to that panel | S | 5 |
| **Enriched status dot** (Working / Idle / Needs-input / Error) | Extend the existing Working/Done morph with richer states on the header + minimap dot | S | 4 |
| **Saved camera views (waypoints)** | Name `{x,y,zoom}` positions ("CI logs", "Frontend") and jump via hotkey / ⌘K | S | 4 |
| **Dev-server URL → browser panel auto-wire** | On a detected `localhost:xxxx`, open/update a sibling browser panel (no copy-the-URL, no stale-port 5173→5174) | S | 4 |
| **Command Palette superpowers** | Fuzzy-search panels by title/agent/first-prompt and fly there; run command snippets into the focused terminal | S | 4 |
| **Marquee multi-select + bulk move/align/tidy/close** | Rubber-band selection + bulk ops (prerequisite for broadcast & framing) | M | 4 |

### ⚠️ Gotchas (so it actually works)

- **The "finished" signal is NOT the 900 ms idle flip.** `AgentDetectionService` derives phase
  purely from output cadence (`WORKING_WINDOW_MS = 900`); modern CLIs go quiet >900 ms *mid-turn*
  (thinking between tool calls). A naive `working→idle = done` notification fires repeatedly during
  one turn → spam. Add a separate, stickier **"turn-settled"** signal (quiet for several seconds AND
  the output tail looks like a returned prompt). Keep the 900 ms phase for the live chip only.
- **The camera animation does NOT exist to "reuse."** `useViewportStore` is 100 % instant `set()`
  calls. The "teleport the camera" UX needs a net-new `flyTo(rect)` tween via `requestAnimationFrame`,
  cancellable on user pan/zoom, gated by `appearance.reduceMotion`. Small, but new code — and it pays
  for itself (saved views + the mission-control rail's focus action reuse it).
- **Only OS-notify when the window is unfocused** (`document.hasFocus()` — pattern already used in
  `useTimeTracker.ts`). Focused-but-off-screen → in-app toast + Dock badge only. Kills most spam.
- **Dedicated setting** `agentNotifications` — do **not** reuse `smartActions` (already defined,
  defaults true; reusing it silently turns notifications on for every user).
- **needs-input is best-effort.** Confirmation prompts in TUI agents are often drawn via alt-screen /
  cursor-addressed redraws, so a `(y/n)` regex over the ANSI-stripped tail may never match cleanly and
  prose `(y/n)` false-positives. Ship it as a **soft badge only**, never an OS notification.
- **ptyId↔panelId is indirect.** `useAgentStore` is keyed by ptyId; rects live in `usePanelStore` by
  panelId; bridge is `useTerminalStore.byPanel`. Reverse-map defensively and drop the notification if
  the panel/pty is gone.

---

## 🌊 Wave 2 — Parallel-agent infrastructure ("watch agents" → "ship agents")

| Feature | What it does | Effort | Impact |
|---|---|:---:|:---:|
| **Per-agent git worktree isolation** (1 branch per terminal) | Each agent edits in its own worktree/branch → run 3–5 in parallel with zero file-stomping | L | 5 |
| **Per-hunk diff review + merge-back panel** | Review an agent's worktree diff, keep/reject hunks, merge back — without leaving PLANO | L | 5 |
| **Agent mission-control rail** (list view of the canvas) | Dockable rail listing every agent (incl. cross-space): kind, task, status, actions (focus/stop/diff). Canvas = spatial view; rail = list view of the same panels | M | 5 |

### ⚠️ Gotchas (worktrees — the part most people get wrong)

- **You cannot "isolate a running agent."** The `cwd` is read once in `terminal.create()`
  (`useXterm.ts:207`) and node-pty has no live `chdir`. Honest reframe: **"launch an isolated agent"**
  bound at panel creation, not a hot-swap of a live PTY (that would destroy scrollback + kill the agent).
- **Do NOT put worktrees under `.plano/`.** That dir is hardcoded in `FileSystemService.IGNORED` and
  skipped by `FileWatcherService`, so an editor rooted in a worktree there shows an empty tree. Put them
  **outside** the repo (sibling dir or `userData`-scoped).
- **`GitService` is read-only today** (4000 ms `execFile` timeout). Worktree add/remove are *write* ops
  and slow → need their own write path with a longer timeout + branch-name sanitization in `registerIpc`
  (keep the `execFile` arg-array discipline; never interpolate user text into args).
- **Teardown is a guarded state machine:** dirty-check → `PtyManager.kill` the pty (+ detach any sibling
  editor/watcher) → `git worktree remove` (`--force` only after the dirty-check) → optionally delete the
  branch. Surface the failure path if git still refuses.
- **GC story is mandatory.** Each isolated agent = a full checkout (hundreds of MB) + a surviving branch.
  Ship a visible **"Worktrees" management surface** (list + branch + dirty + size + prune/delete) or the
  disk silently fills.
- **Dangling reference.** The worktree path rides in `panel.props` (persists to `workspace.json`), but the
  dir is runtime state that can vanish out-of-band. On reload, `resolveCwd` falls back to HOME *silently* —
  the "isolated" agent would write to your home dir. Mark the panel "worktree missing" and offer
  recreate-or-detach; never fall back silently.

---

## 🌊 Wave 3 — Force multipliers (on top of Wave 2 infra)

| Feature | What it does | Effort | Impact |
|---|---|:---:|:---:|
| **Broadcast input to selected terminals** | Select terminals, arm (red `#EF4444`), type once → fans out to every selected PTY | M | 4 |
| **Same-prompt fan-out across models** | Launch the identical seed prompt to N agents (different CLIs), each in its own worktree, compare diffs side by side, keep the best | L | 4 |
| **Saved workspace layout recipes** (tmuxinator-style) | Stamp a wired cluster ("Agent workstation": dev-server + browser + editor + git) in one click, auto-running startup commands | M | 4 |
| **Semantic-zoom / LOD agent card face** | Below a zoom threshold a terminal collapses to a compact "agent card" (brand tint + prompt + state) and suspends the heavy xterm render | M | 4 |
| **Per-worktree environment bootstrap** | On worktree creation: copy env files, run setup, reserve a free port, start the dev server, open a browser panel | L | 4 |

### ⚠️ Gotchas

- **Broadcast is dangerous** — require an explicit armed toggle and highlight every targeted panel before
  any keystroke fires. Reuse the reserved red destructive/armed token.
- **Fan-out depends on worktrees + diff review shipping first**, and on detect-then-inject (seed the prompt
  only once the agent is actually ready, not racing CLI startup).
- **Layout recipes must re-resolve runtime/path fields per project** (ptyId, absolute folder paths) so a
  stamped editor/terminal targets the right files.
- **LOD must not lose scrollback** — keep the pty alive, detach only the renderer, replay from the transcript
  buffer on reattach. Pairs naturally with the Context Engine's ring buffer.

---

## 🧠 The Context Engine — the local "project brain" (the owner's core idea)

> "A local guide that reads all the terminals to give context." Fully designed below.

A fully **local** project brain that turns the canvas's scattered terminals + detected agents into one
shared, queryable, injectable context layer. It does three things:

1. **Human awareness** — a surface (panel or rail) shows, in one place, what every agent is doing:
   a brand-tinted lane per agent (first prompt, Working/Idle/Needs-input phase, last N output lines,
   commands run, detected dev URLs).
2. **Cross-agent awareness** — a **localhost MCP server** exposes that same aggregated context back to the
   CLIs themselves, so a Claude Code instance can ask *"what is the other agent doing?"* and get a real
   answer instead of being blind to its siblings.
3. **Project memory** — transcripts feed a searchable index + an event timeline + a shared **scratchpad**
   (a common blackboard the human and agents read/write).

### How it works

- **Ingest:** a new `TranscriptService` registers on `PtyManager.create`'s `pty.onData` fan-out — the exact
  `register(ptyId) / feed(ptyId,data) / unregister` pattern `history`/`devUrls`/`detection` already use.
  Keeps a per-pty rolling, ANSI-stripped transcript (copy `TerminalHistoryService`'s ANSI strip + bounded
  window).
- **Enrich:** join each transcript with `AgentDetectionService`'s verdict (kind, phase), `useAgentStore`'s
  captured first prompt, and `DevUrlService` URLs.
- **Events:** `AgentDetectionService` already emits structured transitions only-on-change via
  `CH.agentSignal` → aggregating those into a timeline store is nearly free.
- **Surface to human:** brand-tint lanes (reuse `AGENTS[kind].accent`, stays inside monochrome-with-accents)
  + a ⌘K-style query bar that deep-links to the originating panel.
- **Surface to agents:** main hosts a localhost MCP server exposing `list_terminals`,
  `get_terminal_transcript(id, tail)`, `search_context(query)`, `read_scratchpad` / `append_scratchpad`.

### Phases

| Phase | What | Effort |
|:---:|---|:---:|
| **1** | `TranscriptService` consumer on the `PtyManager` fan-out + read-only context surface with per-agent lanes | S–M |
| **2** | Event timeline aggregating the existing `CH.agentSignal` transitions + dev-URL + command events, click-to-focus | M |
| **3** | `@-mention` another panel to inject its snapshot into the focused terminal (`PtyManager.write`) + shared scratchpad | M |
| **4** | Keyword search index over persisted transcripts (`search_context`), persist + rotate in `.plano/` | L |
| **5** | Local **MCP server** (`list_terminals`/`get_transcript`/`search_context`/scratchpad) with per-workspace auto-discovery seeding | L |
| **6** (optional) | Local embeddings (MiniLM / Transformers.js) for semantic recall + NL query bar answered locally / by an on-canvas agent | XL |

### ⚠️ Gotchas (uncomfortable truths to respect)

- **Build Phase 1 renderer-only.** The renderer already receives every byte (`CH.terminalData`) and
  `useAgentStore` already has verdict + phase + first-prompt. A renderer-side ring buffer = a context panel
  in a day, **zero new main code, zero IPC, zero persistence.** A main-side `TranscriptService` + persistence
  is only justified once search (Phase 4) needs it.
- **PLANO does NOT track live cwd.** `resolveCwd` runs once at spawn; there's no OSC-7 shell integration. So a
  cwd column shows the *spawn* dir, not where the agent actually is. Either drop cwd, or add an OSC-7 emit into
  the `PS_PREDICTIVE_INIT` you already inject and parse it off the byte stream.
- **First-prompt lives in the renderer**, not main (`useXterm` keystroke capture). The MCP server / main-side
  service need a new `CH.agentPrompt` push or main-side capture — it's not free to join.
- **Secrets in scrollback.** The moment you persist to `.plano/` or expose via MCP, echoed tokens/passwords/.env
  dumps leak — and between agents. Persistence is **opt-in** (gate on the already-declared `saveTerminalHistory`
  setting), bounded + rotated, with redaction and a one-click Clear.
- **The MCP server is the real payoff but the riskiest piece** — a localhost surface in the privileged main
  process, auto-seeding config into the user's repo, exposing secret-bearing transcripts. Bind to loopback only,
  scope tools to the active workspace, write a PLANO-namespaced `.mcp.json` (never overwrite the user's), and
  treat every agent call as untrusted input at the `registerIpc` trust boundary. If redaction can't be trusted,
  expose metadata/summaries, not raw tails.
- **Context panel vs. mission-control rail are ~80 % the same surface.** A panel that lists agents is itself a
  panel that drifts off-screen; the dockable **rail** (`chrome/`, cross-space) is the better Phase-1 home.
  Consider shipping the rail as Phase 1 and reserving the floating panel for the query-bar/timeline phases.

---

## 🌉 Other big bets (lower priority / more orthogonal)

- **Issue-to-canvas linking** (Linear / GitHub Issues panel): drag an issue → spawns a pre-wired terminal
  (creates+checks out the branch, ideally in a worktree) + an editor on the relevant files; PR/branch status
  flows back. *Risk:* external API auth/rate-limits/token storage; somewhat orthogonal to the freeform-canvas
  ethos — keep it optional.
- **Searchable cross-terminal transcript index (RAG over scrollback):** ask "which terminal ran the migration"
  and click-to-focus. This is literally Context Engine Phase 4 (keyword) → Phase 6 (embeddings).

---

## 🎯 Recommended first build (top 3)

1. **Agent notifications + `flyTo` camera tween** — biggest parallelism unlock at the lowest cost; the camera
   tween is reused across half the roadmap (saved views, rail focus).
2. **Per-agent git worktree isolation** — the keystone. Without it, parallel agents are *net-negative* (they
   stomp each other). Diff-review, fan-out, and bootstrap all consume its two-tree / per-agent-cwd output.
3. **Context Engine Phase 1 as the mission-control rail** (renderer-only) — stands up the project-brain vision
   as a pure consumer of existing data, and becomes the substrate for search, timeline, and the MCP server.

### Sequencing

- **Wave 1** first (days, no new infra): notifications, status dot, saved views, dev-URL→browser, ⌘K
  extensions. Build `flyTo` + marquee multi-select as shared foundations here.
- **Wave 2**: worktree isolation (keystone) → per-hunk diff review → mission-control rail.
- **Wave 3**: broadcast, model fan-out, layout recipes, LOD, env bootstrap.
- **Context Engine**: ship Phase 1 (rail) early alongside Wave 1; layer Phases 4–6 + the MCP server **last**
  (they depend on transcripts/search/scratchpad existing — and the MCP server is the payoff that lets the
  *agents*, not just the human, see the whole canvas).

> Everything stays inside the existing architecture (4-file IPC seam, `PtyManager` fan-out, `post()` events,
> the add-a-panel recipe, token/var-driven accents) — no wave requires re-platforming.

## Agent Mesh (implemented)

Cross-workspace agent coordination, provider-neutral:

- First-class detection + resume for any CLI (incl. Hermes via `hermes --continue`, id-less).
- Canonical main-process context: clean bounded tails, timeline, first/last prompts, redaction.
- Agent Mesh overlay (`Ctrl+Shift+A`): roster across workspaces, multi-select, focus, interrupt,
  Compose (send one message to N agents with shared-context block), Snippets (persistent library),
  Context (search + scratchpad), Timeline.
- Local MCP Context Bridge (loopback + token, read-only by default; mutating tools opt-in).
- Git worktree fan-out for parallel writing agents (dirty worktrees protected).

Remaining ideas: persistent search index across restarts (opt-in already wired), MCP config copy
helpers for specific agent hosts, per-agent model/provider labels from API capability discovery.
