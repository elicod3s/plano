# BRIEF — make agent↔agent comms instant and reliable, and fix the terminal font fallback

You are working in **`D:/Tools/Plano`** (branch `mac-build-odla`). Read `CLAUDE.md` first, then
`docs/engineering/plans/PLAN_AGENT_MESH_V6_RELIABLE_COMMS.md` (the plan already executed) so you do
not redo work. This brief is the NEXT step.

Two independent jobs. Job 1 is the important one.

---

## JOB 1 — agents must talk fluidly, and never go silent

### The observed failure (real session, screenshots)

An orchestrator asked a peer a question:

```
plano ask bec8d7a1 "¿Me escuchas? Responde solo con una palabra si me oyes." --timeout-ms 60000
Output: {"_keepalive":true}
[Timeout: 90s]
```

Nothing came back. The peer's TUI showed its input box holding text with the hint
`esc again to edit previous message`: our line had been typed into a harness that was in an
editing/paste state, the Enter was swallowed, and the message never became a turn. Both sides then
waited on each other. Earlier in the same session the same pair traded messages fine — it degrades
after a while, which is what makes it feel random.

Related evidence from another agent's own bug report:
- `plano ask <id>` reported `queued` and the answer never arrived anywhere.
- A spawned agent sat in `working` for minutes with `pendingMessages: 1` while connecting MCP
  servers, so its mailbox never drained.
- `plano wait <full-id>` produced keepalives indefinitely instead of ending.

### What is ALREADY fixed (0.2.18 → 0.2.22) — do not redo

- Sessions are mirrored into a headless xterm (`src/main/daemon/screen.ts`); the mesh reads the
  RENDERED screen, so peer reads are no longer a pile of repaint frames.
- `send` to a busy peer auto-queues; every terminal outcome (delivered / expired / undeliverable /
  peer-exited / target-blocked) is reported into the SENDER's mailbox.
- `plano watch <messageId>` waits on a specific message.
- Short-prefix ids resolve on every command (`findAgent`).
- `plano context` falls back to the daemon's screen when the desktop app is closed or slow.
- A stale-`working` watchdog demotes an inferred `working` after 4 min with no screen change and no
  worker process (`STALE_WORKING_MS` in `src/main/daemon/index.ts`).
- Delivery is written in 24-char bursts with a 90 ms settle before the Enter
  (`deliverTyped` / `submitLine` in `src/main/daemon/mesh/bus.ts`).
- A first cut of submit-verification exists: `submitAndConfirm` + `stillInInputBox` in `bus.ts`.
  **It is naive — improve or replace it using the model below.**

### What Orca does, and what to copy (read their source)

Repo: <https://github.com/stablyai/orca>. Concrete files worth reading:

| File | What to take from it |
|---|---|
| `src/renderer/src/lib/active-agent-terminal-send-readiness.ts` | **Guarded send.** Before typing, they ask the runtime `terminal.agentStatus` and classify: `sendable` / `no-agent` / `permission` / `status-unavailable`. A peer sitting on a permission prompt is NEVER written to. Legacy path falls back to waiting for `tui-idle`. |
| `src/main/runtime/rpc/methods/terminal.ts` | The RPC surface behind `terminal send / wait / read / agentStatus` — how readiness is computed server-side. |
| `src/main/agent-hooks/*`, `src/main/claude/statusline-script.ts` | How they drive status from harness hooks rather than guessing from output. |
| `skill-guides/orchestration.md`, `skill-guides/orca-cli.md` | The contract they hand agents: `create → wait --for tui-idle → send --enter`, blocking ask/reply with obligations, `worker_done`, escalation. Every blocking flow ends in an ANSWER. |

The lesson: **a handoff is not "typed", it is "accepted"** — readiness is checked BEFORE writing and
acceptance is verified AFTER.

### What to build

1. **Readiness gate before every write.** Add a real `agentReadiness(ptyId)` in the daemon that
   returns something like `sendable | busy | permission-prompt | not-an-agent | unknown`, computed
   from the rendered screen (`readScreen`) + the existing `awaitingInput()` detector + worker
   processes + harness hook state. `send`/`ask`/spawn-prompt/chain delivery must consult it:
   - `permission-prompt` → do NOT type; queue and tell the sender a human must clear it.
   - `busy` → queue (already the behaviour).
   - `sendable` → type.
2. **Editing/paste state must be handled, not ignored.** The concrete killer is the harness being in
   "edit previous message" mode. Detect it from the screen (harness-specific hints are fine — keep
   them in one table with a comment per entry) and recover deterministically (e.g. send Escape,
   re-verify the box is clean, then type). Never leave a message parked in an input box.
3. **Verify acceptance.** After the Enter, confirm the line LEFT the input box (the prompt-marker
   line no longer carries our text) and retry a bounded number of times. Improve
   `stillInInputBox` — today it only knows `›`, `❯`, `>`; make it robust across the harnesses PLANO
   supports (claude, codex, pi, omp, gemini, opencode, cursor, kiro, aider, grok).
4. **A blocking call must always end in an answer.** Audit `wait` / `ask` / `watch` for paths that
   can keepalive forever. Every one must resolve with a state + whatever output exists.
5. **Prove it with the e2e**, `.plano-tests/mesh-cli-e2e.mjs` (currently C1–C14, all green). Add
   cases for: a peer in a permission prompt is never written to; a message parked in an input box is
   detected and recovered; a saturation drill (3+ agents, 20 messages both directions under
   deliberate mid-turn collisions) ends with zero lost messages and every sender informed.

### Hard rules

- `npm run typecheck` clean and `node .plano-tests/mesh-cli-e2e.mjs` fully `ok:true` before you
  claim done. Run the e2e TWICE — the failures here are intermittent.
- `npx electron-vite build` before running the e2e, or you will test the previous build (this has
  bitten us).
- **Do NOT run `npm run dist`, do not publish, do not touch the user's installed PLANO.**
- Keep the daemon working with the desktop app CLOSED — that is a core invariant.
- Comment the WHY of any non-obvious rule, in the style already used in `bus.ts`.

---

## JOB 2 — the terminal renders one line in several different fonts

Screenshot evidence: a path line renders with mixed letterforms — uppercase and some glyphs clearly
come from a different face than the rest of the same word, so the line looks ransom-noted:

```
C:/Users/Administrator/Desktop/Curiozy Vid/FINAL_MJGARAGE_1080p.mp4
```

Cause to investigate: the layered terminal font stack falls back PER GLYPH, so a font missing a
character hands that character to the next family mid-word. Relevant places:

- `--font-mono` in `src/renderer/styles/theme.css` (JetBrains Mono + `PLANO Term Symbols` +
  `PLANO Term Dingbats` + Cascadia + DejaVu subset).
- `src/renderer/panels/terminal/useXterm.ts` (xterm `fontFamily`), and the bundled faces in
  `assets/fonts/`.
- Read the memory notes in `CLAUDE.md` about terminal fonts before changing anything: the layered
  fallback exists to make CLI box-drawing/Braille/star glyphs work, and `lineHeight` 1.0 is
  deliberate. **Do not delete the fallback faces or raise the line height.**

Goal: ordinary text (letters, digits, punctuation, paths) must all come from ONE face; the fallback
faces must only serve glyphs the primary genuinely lacks. Verify by rendering a path like the one
above plus a box-drawing/Braille sample and confirming both look right.

---

## Reporting

When done, report: what you changed and why, the e2e results (both runs), and anything you found but
did not fix. Do not invent success — if something still fails, say so plainly.
