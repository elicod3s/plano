# Implementation plan: crisp terminals while dragging and visual focus

**Status:** implementation paused; provisional changes exist that have not been accepted
**Date:** 2026-08-09
**Scope:** terminal panel movement, inactive visual state, terminal regressions, packaging, updating and installation

## 1. Expected outcome

PLANO must keep the terminal crisp during the entire drag, even with many panels and with canvas zoom. Movement will be rendered with a lightweight visual copy of the panel; the real terminal will not be moved, scaled or remounted until the pointer is released.

When a terminal is not active, the whole panel rests at 75 % opacity. On focus, hover, or keyboard navigation it returns to 100 %. The effect must feel integrated with PLANO's aesthetic: the internal xterm surface must not become transparent, and the previously investigated right-edge content clipping must not come back.

At the end, a verifiable installer must be produced, that build must be installed preserving user data, opened, and the auto-updater must be validated to still work.

## 2. Work bounds

### Included

- Crisp dragging of loose terminals.
- Dragging of docked groups that contain terminals.
- Active, inactive, hover and `focus-within` visual states.
- Snapping, docking, cancellation and pointer capture.
- xterm functional and visual regression.
- Performance with a high number of panels.
- Packaging, auto-update, installation and verification.

### Not included

- Redesigning other panel types.
- Changing the PTY engine or the IPC protocol.
- Re-enabling WebGL.
- Re-enabling dynamic xterm rasterization scaling.
- Releasing a version without explicit authorization.
- Deleting or migrating user data.

## 3. Exact state where the work stopped

| Element | Current status | Evidence / notes |
|---|---|---|
| Reference research | Complete | The reference hides the real node and moves a lightweight `DragOverlay`. |
| Drag ghost in `PanelFrame.tsx` | Provisional | The code exists, but it is not accepted yet. |
| Inactive-terminal dimming | Provisional | 0.75 was added for inactive and 1 for active/hover. Keyboard and all themes still need validation. |
| TypeScript renderer | Passes | `npx tsc --noEmit -p tsconfig.web.json`. |
| TypeScript main | Passes | `npx tsc --noEmit -p tsconfig.node.json`. |
| Dev build | Passes | `npm run build`. |
| Full E2E test | Fails | Exited with code 1 and did not report which assertion failed. It cannot be declared fixed. |
| Isolated movement test | Pending | Must be separated from the sound and Pi/agent scenarios. |
| Installable package of these changes | Not created | The installed app does not yet contain this provisional work. |
| Auto-updater | Audited in code | A full download, restart and install test with packaged builds is still missing. |

Files with relevant provisional changes:

- `src/renderer/panels/_base/PanelFrame.tsx`
- `src/renderer/styles/globals.css`
- `scripts/plano-motion-sound-e2e.mjs`
- `scripts/plano-smoothness-e2e.mjs`

The repository already contained numerous user changes before this work. `git reset` will not be used, whole files will not be restored, and any fix or rollback will be done by hunks strictly related to this plan.

## 4. What the reference research showed

The inspected reference app is installed at:

`<user-home>\AppData\Local\Programs\<reference-app>\resources\app.asar`

The useful behavior does not come from animating the real terminal:

1. When a real drag starts, the reference hides the source.
2. It moves a lightweight overlay with a border, background, title and drop-target indicator.
3. The original xterm surface stays still and is not re-scaled on every pointer move.
4. On release, the final position is applied to the real panel.
5. Unfocused panels rest at `UNFOCUSED_OPACITY = 0.75`; hover, selection or focus restore 1.

The concrete cause of the degradation observed in PLANO was applying this to the whole live panel:

`translate3d(0, -2px, 0) scale(1.006)`

Because xterm draws onto a rasterized surface, that fractional scale forces the compositor to resample the text and cursor. The result is temporary loss of crispness and a vibration feel while moving.

The existing render-scale system will not be re-enabled: it previously altered xterm's columns, scrolling and geometry. In the reference app it only takes effect above zoom 1, and it does not explain the defect reproduced at around 90 %.

## 5. Solution architecture

### 5.1 Drag state machine

```text
Idle
  └─ pointerdown → Armed
       ├─ pointerup before threshold → Idle (click/focus only)
       ├─ movement > 5 px → DraggingGhost
       │    ├─ pointermove → update only the ghost transform
       │    ├─ pointerup → Commit → Idle
       │    └─ Escape / pointercancel / lostpointercapture → Cancel → Idle
       └─ cancel → Idle
```

Rules:

- The 5 px threshold prevents a plain click from flashing the panel.
- During `DraggingGhost`, the real panel keeps exactly its original rect and transform.
- The source is hidden only after the threshold is exceeded, not on `pointerdown`.
- The ghost is updated imperatively, at most once per frame via `requestAnimationFrame`.
- The global position will not be written to Zustand on every `pointermove`.
- The panel position is committed exactly once on `pointerup`.
- Snapping and docking are computed against the ghost's logical position.
- Cancelling restores visibility and state without changing the position.

### 5.2 PLANO's visual ghost

The ghost must keep the drag mechanics established by the reference research but use PLANO's visual language:

- Solid high-opacity background based on the theme tokens.
- Clean border in the terminal or agent color.
- Title, status and a discreet grip handle.
- Short English text to stay consistent with the UI: `Moving` and `Release to place`.
- Contained shadow that separates the ghost from the canvas.
- No `backdrop-filter`, blur while moving or fractional scaling.
- `pointer-events: none` and `aria-hidden="true"`.
- Geometry equivalent to the source panel, with bounds to avoid oversized ghosts.

Once the behavior is proven, the ghost will be extracted into a shared component, e.g. `PanelDragGhost.tsx`. That refactor will not happen before the tests are stabilized.

### 5.3 Real terminal

During the drag:

- The xterm instance must be the same node before and after.
- It must not receive `transform`, `scale`, resize, `fit()` or remounting.
- Its PTY columns and rows must stay constant.
- `allowTransparency`, the internal canvas and the viewport will not be touched.
- The real panel will be hidden visually without altering layout or geometry.

### 5.4 Focus-based dimming

Intended visual states:

| State | Opacity |
|---|---:|
| Inactive | 0.75 |
| Active / frontmost | 1 |
| Hover | 1 |
| `focus-within` | 1 |
| Source during confirmed drag | 0 |
| Ghost | 1 |

Opacity is applied to the entire panel shell. The internal xterm surface stays opaque, so the background appears to recede without causing color blending, low legibility or the previously investigated right-edge clipping.

`isFront` will be verified to actually represent user focus. If it only reflects Z order, the visual attribute will be wired to the canonical focused-panel state instead of creating a second source of truth.

### 5.5 Groups and docking

The behavior cannot be limited to `PanelFrame`. `DockGroupFrame` will be audited:

- If a group contains a terminal, the whole group uses the same ghost mechanism when moved.
- An individual terminal inside a visible group will not be hidden.
- Tab switching, docking preview, group split and regroup must be preserved.
- The shared implementation avoids two distinct state machines.

## 6. Implementation phases

### Phase 0 — Protect the current state

1. Record `git status` and isolate the hunks introduced by this work.
2. Do not modify prior user changes in `PanelFrame.tsx`, `globals.css` or the scripts.
3. Save evidence of the passing build and of the failing test.
4. Confirm that no temporary test processes are left running.

**Output:** a precise map of our own hunks and a safe base to continue or revert.

### Phase 1 — Turn the E2E failure into a useful diagnosis

1. Separate the movement test from the sound and agent tests.
2. Make each scenario write structured results with name, observed values and error.
3. Capture a screenshot and DOM state at the first failure.
4. Run the isolated movement test at zoom 0.90, 1.00 and 1.25.
5. Determine whether the current failure is a selector/timing issue or a real regression.

**Condition to proceed:** the test must unambiguously indicate which rule is violated.

### Phase 2 — Stabilize the drag mechanics

1. Implement the `Armed` state and the 5 px threshold.
2. Centralize start, move, commit and cancel.
3. Coalesce moves with `requestAnimationFrame`.
4. Keep the real panel and xterm motionless.
5. Confirm a single position write per drag.
6. Cover `Escape`, `pointercancel` and `lostpointercapture`.
7. Validate snapping, docking and canvas bounds.

**Condition to proceed:** the xterm node identity, its rect and its PTY dimensions stay stable while the ghost moves.

### Phase 3 — Polish the ghost without compromising performance

1. Tune hierarchy, contrast, shadow, border and texts on dark and light themes.
2. Avoid expensive filters and properties that force terminal repaints.
3. Extract the shared component only after the mechanical test passes.
4. Reuse it for groups that contain terminals.

**Condition to proceed:** the ghost reads clearly on all themes and adds no measurable slow frames.

### Phase 4 — Complete focus and inactivity

1. Add `focus-within` in addition to active and hover.
2. Validate the canonical source of the active panel.
3. Test terminal overlap and focus changes with mouse and keyboard.
4. Review Monolith, Indigo, Orange, Tokyo, Sakura, Pearl and Mist.
5. Confirm contrast of text, cursor, selection, scrollbar and background.

**Condition to proceed:** inactive computes 0.75 and active, hover or keyboard focus compute 1, without affecting xterm's internal colors.

### Phase 5 — Functional regression and performance

Run the matrix from section 7 and fix only failures attributable to this change. Validate especially:

- input, cursor, selection, copy/paste and scrollback;
- full-width TUI applications;
- multiple tabs and agent terminals;
- resize before and after dragging;
- loose panels, docked panels and groups;
- snapping and cancellation;
- low, normal and high zoom;
- 1, 8 and at least 56 panels.

**Condition to proceed:** typechecks, build, functional E2E and benchmark pass repeatably.

### Phase 6 — Verify packaging and the auto-updater

Current audited configuration:

- Current version in `package.json`: `0.2.8`.
- `electron-updater` is configured for GitHub `zqkra/plano`.
- The check starts 15 seconds after launch and repeats every 4 hours.
- Auto-download and install-on-quit are enabled.
- `scripts/update-e2e.mjs` can observe states and test restart.

Procedure:

1. Query the existing feed and pick the next free SemVer; `0.2.9` is expected, but it will not be assumed without verifying.
2. Bump the version only at the end, when all local tests pass.
3. Generate the package with `npm run dist:win`, without publishing.
4. Validate `app-update.yml`, `latest.yml`, installer, blockmap, version and hashes.
5. Install and test the candidate package locally.
6. Verify that the updater UI and its IPC phases still work.
7. To test the full update, start from a lower installed version and use a higher candidate version.
8. Request explicit authorization before any `npm run release:win` or GitHub publish.
9. After publishing, run `scripts/update-e2e.mjs` and check download, quit, install, restart and final version.

`0.2.8` will not be reused for different content if that version was already published: clients and caches could receive inconsistent artifacts.

### Phase 7 — Install and open the final build

1. Identify the executable and the installed version.
2. Close PLANO normally and wait for the Agent Host and PTYs to finish.
3. Keep the user data directory intact.
4. Install the verified candidate package.
5. Compare version and hash of the installed `app.asar` with the tested package.
6. Open PLANO visibly.
7. Run a CDP smoke test and a manual visual check.
8. Confirm crisp terminal, focus/inactivity, groups and updater state.

## 7. Minimal test matrix

| Scenario | Main validation |
|---|---|
| Click without dragging | No ghost appears; normal focus. |
| Drag at zoom 0.90 / 1.00 / 1.25 | Text and cursor keep their crispness; real xterm does not move. |
| Drag and commit | The panel ends at the expected position with a single global write. |
| Escape / pointercancel | The panel becomes visible again and does not change position. |
| Snapping and docking | Preview and final target match the ghost. |
| Terminal in group | The group moves without resampling the terminal. |
| 1 / 8 / 56 panels | Fluid movement with no cumulative degradation. |
| Inactive terminal | Computed opacity 0.75. |
| Active / hover / keyboard | Computed opacity 1. |
| Light and dark themes | Text, cursor, selection and ghost keep contrast. |
| Full-width TUI | No right-edge clipping or column changes. |
| Resize after drag | `fit()` correct only when appropriate. |
| Agent running | The process continues; no output or session loss. |
| Auto-update | Check, download, ready, quit/install and restart all correct. |

## 8. Acceptance criteria

The work is only considered done when all of these hold:

- No ancestor of the real xterm receives `scale()` during the drag.
- The `.xterm` node keeps its identity before, during and after.
- The real panel keeps its rect until `pointerup`.
- PTY columns and rows do not change because of dragging.
- The global position is committed exactly once.
- The ghost follows the pointer without expensive filters or click flicker.
- In the 56-panel test, frame p95 does not exceed 16.7 ms and there are no visible sequences of dropped frames.
- Inactive = 0.75; active, hover and `focus-within` = 1.
- The right-edge content clipping does not reappear.
- `tsconfig.web.json`, `tsconfig.node.json`, build and packaged E2E pass.
- The installer opens the verified build, not an older version.
- The updater recognizes the version and completes an E2E cycle when publishing is authorized.

## 9. Planned verification commands

These commands will be run during implementation, not while writing this plan:

```powershell
npx tsc --noEmit -p tsconfig.web.json
npx tsc --noEmit -p tsconfig.node.json
npm run build
node scripts/plano-motion-sound-e2e.mjs
node scripts/plano-smoothness-e2e.mjs
npm run dist:win
node scripts/update-e2e.mjs
```

The tests will be adapted to support an isolated movement mode and emit structured results. `npm run release:win` stays out of automatic execution and will require approval.

## 10. Rollback

If the solution does not meet the criteria:

1. Revert only the ghost and dimming hunks from this work.
2. Keep all prior user changes.
3. Keep the last verified installer before replacing the installation.
4. Do not delete `%APPDATA%`, workspace data, sessions or configuration.
5. If the installed candidate fails, close normally and reinstall the previous verified package.
6. If a defective release already exists, publish a higher fixed version; never silently replace artifacts of the same version.

## 11. Summary execution order

- [ ] Isolate and explain the current E2E failure.
- [ ] Stabilize the state machine and the drag threshold.
- [ ] Confirm the real terminal is never transformed.
- [ ] Validate snapping, docking, cancellation and groups.
- [ ] Finish the visual ghost on all themes.
- [ ] Complete active, inactive, hover and `focus-within`.
- [ ] Pass functional regression and the high-load benchmark.
- [ ] Verify typechecks and build.
- [ ] Pick the next free version.
- [ ] Package and test locally without publishing.
- [ ] Ask for authorization before publishing.
- [ ] Validate the full update.
- [ ] Install the verified candidate, open it and run the final smoke test.

## 12. Decisions already made

- Adopt the ghost-drag mechanics as PLANO's own: lightweight overlay with border/background/title/drop-target indicator, PLANO visual language; the real terminal never animates or scales during drag; inactive state 75 % opacity; hover/focus restore 100 %.
- The real terminal is not animated or scaled during the drag.
- The inactive state uses 75 % opacity.
- Hover and focus restore 100 %.
- The xterm surface will not be made transparent.
- Dynamic render scale will not be re-enabled to fix this defect.
- Nothing will be packaged or installed until the current E2E failure is understood.
- No update will be published without explicit approval.
