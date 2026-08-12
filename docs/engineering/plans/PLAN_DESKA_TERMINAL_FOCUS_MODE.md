# PLANO Terminal Focus Mode: Exact Deska-Behavior Plan

## Status and purpose

This is an implementation plan only. It is based on a read-only comparison of the current PLANO canvas/terminal code and Deska's original TypeScript source inside `C:\Users\Administrator\AppData\Local\Programs\deska\resources\app.asar`. No application was launched and no source code was changed during the audit.

The goal is to reproduce the relevant Deska focus interaction on PLANO's infinite canvas:

- clicking a canvas panel makes that surface the focused one and brings it forward;
- the focused surface is fully opaque;
- all other floating surfaces rest at 75% opacity;
- hovering an unfocused surface temporarily restores it to full opacity;
- the first click on an unfocused panel focuses it without accidentally clicking or typing inside its content;
- when the target contains a terminal, xterm reliably receives keyboard focus without losing its scroll position;
- clicking empty canvas clears focus;
- focus changes never restart, detach, resize, or otherwise disturb terminal sessions.

## What Deska actually does

The requested effect is not implemented as a terminal-only CSS selector in Deska. It is a canvas-node focus system applied to every floating canvas node; terminals add a terminal-specific keyboard-focus hook. Exact parity therefore means dimming all unfocused floating panels/groups, while applying the xterm focus routine only to terminal content.

The relevant Deska source establishes these exact rules:

- `canvas-node/data.ts`: `UNFOCUSED_OPACITY = 0.75`.
- `canvas-node/lib.ts`: focused, selected, or hovered nodes use opacity `1`; other nodes use `0.75`.
- `canvas-node/hooks.ts`: opacity transitions for `var(--motion-base)`, which is `180ms`, with the ease-out curve.
- `canvas-node/canvas-node-view.tsx`: a transparent unfocused overlay intercepts input until focus changes; its own opacity transition is `150ms ease`.
- `stores/canvas/nodes.ts`: `focusedNodeId` is independent state and `focusEpoch` increments on every focus action, including refocusing the same node.
- `use-canvas-mouse-down.ts`: an empty-canvas click calls both selection clear and `unfocus()`.
- `panels/terminal/hooks/use-terminal-focus.ts`: the focused terminal repeatedly focuses `.xterm-helper-textarea` with `preventScroll`, tolerates delayed DOM attachment, restores terminal scroll, and rechecks during the short detach/reattach race window.

Deska's transparent overlay is not an extra dark tint: its `--node-dim-overlay` token is transparent. The visible dimming is the node's `0.75` opacity. The overlay exists to control input and make the first click a focus action.

## Current PLANO gap

### Front order is being used as a visual hint, but it is not focus state

`usePanelStore.ts` has `zCounter` and `bringToFront()`, but no `focusedPanelId`, no focus epoch, and no unfocus operation. `PanelFrame.tsx` derives `isFront` from `s.zCounter === panel.z` and calls `bringToFront(panel.id)` during `onPointerDownCapture`.

This means:

- the same pointer event continues into the panel body;
- an unfocused terminal can receive the click at the same time it is brought forward;
- there is no way to represent “no focused panel” after an empty-canvas click;
- clicking the already-front terminal does not create a new focus signal;
- z-order persistence is unnecessarily coupled to keyboard/input focus.

### PLANO explicitly disabled inactive terminal dimming

`src/renderer/styles/globals.css` contains a comment stating that inactive terminal dimming is intentionally absent. Only the front panel receives a different shadow through `.surface-layer--front`; opacity remains one for all panels.

### xterm is focused only during unrelated engine operations

`TerminalEngine.ts` currently calls `term.focus()` after DOM attachment and after toolbar clear. It does not expose a focus operation tied to canvas focus state. A panel click may happen while the active terminal DOM is being attached, a tab is switching, or a canvas interaction just changed layout; relying on native click focus is not equivalent to Deska's guarded routine.

### Focus must not live in the persisted panel store

`App.tsx` subscribes every `usePanelStore` change to `scheduleAutosave()`. Adding `focusedPanelId` to that store would mark the whole workspace dirty and schedule serialization on every focus click. Focus is ephemeral UI state and belongs in a separate transient store.

## Required semantics

### Focus target

Use the top-level floating surface as the visual focus target:

- a standalone panel focuses its own surface ID;
- a dock group focuses as one outer surface, matching Deska's node behavior;
- the clicked member panel ID is also recorded so a terminal inside a group can receive keyboard focus;
- regions, text labels, grid, minimap, and fixed application chrome are not dimmed.

A suitable transient value is:

```ts
type CanvasFocus = {
  surfaceId: string
  panelId: string
} | null
```

The store also owns a monotonically increasing `focusEpoch`.

### Visual state table

| State | Opacity | Input behavior |
|---|---:|---|
| focused surface | 1.00 | content receives pointer and keyboard input |
| unfocused but hovered | 1.00 | transparent shield still consumes the first primary click |
| unfocused and not hovered | 0.75 | transparent shield consumes content input |
| being closed/hidden | existing close opacity | no input |
| drag source | existing drag behavior | do not add focus animation work per frame |

Selection is not currently a first-class PLANO panel state. Do not invent a fake selected state merely to match Deska's `isSelected` branch. If panel multi-selection is added later, selected surfaces should use opacity one exactly as Deska does.

### Click sequence

For a primary click on an unfocused panel body:

1. the transparent shield receives pointer-down;
2. it prevents the event from reaching terminal/editor/browser content;
3. it focuses the surface and clicked member panel;
4. it brings the top-level surface to front;
5. it increments `focusEpoch` even if the same target is requested again;
6. if the member is a terminal, the terminal focus routine focuses its active xterm textarea;
7. the next click operates normally inside the now-focused content.

Header drag and resize handles must remain usable from an unfocused surface. A drag that crosses the movement threshold focuses and moves the surface without accidentally clicking its body. Right-click/context-menu and file drag/drop behavior must be explicitly preserved.

## Implementation plan

### P0: add transient canvas focus state

#### 1. Create a dedicated non-persisted focus store

Preferred file: `src/renderer/stores/useCanvasFocusStore.ts`.

State and actions:

- `focus: CanvasFocus | null`;
- `focusEpoch: number`;
- `focusSurface(surfaceId, panelId)`;
- `clearFocus()`;
- `removeFocusForSurface(surfaceId)` for panel/group teardown.

Every `focusSurface` call increments `focusEpoch`, even if the IDs are unchanged. This is required for same-terminal refocus after an overlay, palette, browser control, or other element stole DOM focus.

Do not add this state to `usePanelStore`, `useSpacesStore`, the workspace document, or autosave. It must reset during workspace hydration/switch and when the focused surface is removed, with no disk write.

Focus and z-order are coordinated actions but separate concepts. A focus action may call the existing `bringToFront`; clearing focus must not alter z-order.

#### 2. Define surface/member identity for groups

Files:

- `src/renderer/panels/_base/PanelFrame.tsx`
- `src/renderer/canvas/DockGroupFrame.tsx`
- relevant dock pane rendering helpers

For `PanelFrame`, both surface and member ID are `panel.id`.

For `DockGroupFrame`, the surface ID is the group panel ID and the member ID is the pane clicked. The outer group is dimmed/brightened as a unit. Clicking from one terminal pane to another in the already-focused group increments the epoch and redirects xterm focus without changing the group's visual opacity.

### P0: implement Deska's visual and input behavior

#### 3. Drive opacity from focus plus hover, not `zCounter`

Files:

- `src/renderer/panels/_base/PanelFrame.tsx`
- `src/renderer/canvas/DockGroupFrame.tsx`
- `src/renderer/styles/globals.css`

Each top-level surface subscribes to the narrow boolean `focusedSurfaceId === surfaceId`, plus local hover state. The style rule is:

```text
focused OR hovered => opacity 1
otherwise          => opacity 0.75
```

Use Deska's timing: `opacity 180ms` with the existing PLANO ease-out equivalent. Do not use `filter: brightness()`, blur, backdrop changes, fractional scale, or a permanent `will-change`. The panel's content and shell dim together, as in Deska.

Keep PLANO's existing front shadow unless visual review shows a conflict. If strict Deska focus-border parity is desired later, treat it as a separate visual enhancement; it is not necessary for the requested dim/focus interaction.

The existing comment in `globals.css` that explicitly disables inactive-terminal dimming must be removed or rewritten when implementation begins so the source no longer contradicts the intended behavior.

#### 4. Add a transparent unfocused input shield

Add an absolutely positioned, transparent element over the content area of every unfocused top-level surface. It must:

- have `pointer-events: auto` only while unfocused;
- use `pointer-events: none` when focused;
- sit above content but below independent resize/header controls;
- transition its own opacity over `150ms ease`, matching Deska;
- remain visually transparent;
- consume the first left click before it reaches xterm, CodeMirror, a webview, buttons, or links;
- permit header drag and the external resize bands;
- temporarily get out of the way for supported file/dock drag-enter/drop flows and restore itself afterward;
- not appear in the accessibility tree.

Do not implement this only with `onPointerDownCapture` on the existing anchor. Capture alone focuses/raises the panel but does not prevent the same event from activating descendants. The shield is what gives Deska its deliberate first-click behavior.

For browser `<webview>` panels, validate Electron guest input separately because native guest surfaces can have special hit-testing behavior. If an ordinary DOM shield cannot reliably intercept it on the target Electron version, use the smallest browser-specific input gate while preserving the same visible semantics.

#### 5. Clear focus from the empty canvas

File: `src/renderer/canvas/CanvasRoot.tsx`.

When a primary pointer gesture starts on the true canvas background, clear focus. Match Deska's distinction between a click and a drag if PLANO should retain focus during a pan: record the start, apply the existing movement threshold, and call `clearFocus()` only on pointer-up when no pan occurred. If product behavior is intended to clear immediately on background pointer-down, document that deliberate deviation.

Escape may optionally clear focus only when no modal, command palette, editor escape binding, or terminal program owns the key. Do not globally steal Escape from applications running inside xterm.

#### 6. Clean up focus lifecycle

Clear or redirect focus when:

- the focused panel/group closes;
- workspace/space hydration replaces the canvas;
- the focused member is removed from a dock group;
- a dock/undock operation changes the top-level surface ID;
- the active terminal tab changes within the focused terminal panel.

For docking, transfer focus to the destination group and retain the clicked member panel. For undocking, transfer it to the new standalone surface. These transitions should increment the epoch but must not restart the PTY.

### P0: implement reliable terminal keyboard focus

#### 7. Expose a safe terminal focus operation from the engine

Files:

- `src/renderer/panels/terminal/engine/TerminalEngine.ts`
- `src/renderer/panels/terminal/useXterm.ts` or a new `useTerminalFocus.ts`
- `src/renderer/panels/terminal/TerminalPanel.tsx` / `TerminalView.tsx`

Add an engine method that focuses the active terminal session by terminal tab ID without exposing the mutable registry. It should:

- verify that the session and terminal DOM exist and are connected;
- prefer `.xterm-helper-textarea.focus({ preventScroll: true })`;
- fall back to `term.focus()`;
- preserve the xterm scroll position before focusing and restore it immediately plus on the next animation frame;
- perform bounded retries when the DOM is temporarily detached during tab/workspace attachment;
- perform a short bounded recheck after first success to survive a detach/reattach race;
- cancel all retries when focus moves elsewhere or the component unmounts.

Deska uses up to 80 wait attempts at 25 ms and 20 post-success checks at 25 ms. Start with those values for behavioral parity, then confirm they do not leave needless timers in PLANO. At most one focus run may exist for a terminal at a time.

#### 8. Subscribe narrowly to the focus epoch

The active `TerminalPanel`/`TerminalView` should react only when:

- its panel ID becomes the focused member; or
- `focusEpoch` changes while it remains the focused member; or
- its active tab changes while it is focused.

Use an imperative narrow store subscription, as Deska does, so focusing terminal A does not rerender every terminal body. The focus operation must not call fit, resize, reattach, recreate `Terminal`, or touch PTY state.

### P1: keyboard navigation and accessibility

After click parity is stable, add focus-next/focus-previous commands using creation order or z-order, matching the product's command system. A keyboard focus action must run the same `focusSurface` path and terminal hook as a mouse action.

Expose `data-panel-focused="true|false"` separately from the existing front marker. Use appropriate accessible labels for focused state, but keep the transparent pointer shield `aria-hidden` and non-focusable.

Do not use browser `:focus-within` as the source of truth. It cannot represent focus while the terminal DOM is temporarily detached and does not provide the same-node epoch needed for reliable refocus.

## Performance and compositor safeguards

The current PLANO CSS explicitly avoided terminal opacity because earlier motion work was concerned with text rasterization. Deska does animate outer-node opacity, so exact behavior requires testing rather than substituting a visually different filter.

Rules:

- opacity changes only when focus/hover state changes, never on pointer-move frames;
- no permanent per-panel `will-change`;
- no fractional transform or scale;
- no new backdrop-filter or blur;
- no React rerender of terminal bodies on focus changes;
- terminal sessions and DOM remain mounted;
- only the old focused and new focused surfaces should rerender on a focus change; unaffected surfaces' boolean selectors remain false and bail out;
- hover updates only the hovered surface;
- if Chromium promotes temporary opacity layers, confirm they are released after the transition and that GPU memory remains bounded.

If whole-surface opacity produces unacceptable xterm text softening on the target integrated GPU, collect a compositor trace before changing the design. A fallback that dims only chrome/content overlays would not be literal Deska parity and must be approved as a product deviation, not silently substituted.

## Confirmation plan

Before implementing the full behavior, use a development-only prototype and record:

1. the current event path from pointer-down to `bringToFront` and the focused DOM element;
2. whether the same click reaches xterm/CodeMirror before the panel becomes active;
3. opacity and compositor-layer changes for 1, 10, and 30 terminal panels;
4. React commit counts for a focus change;
5. active element after focusing, switching terminal tabs, opening/closing the command palette, and refocusing the same terminal;
6. terminal scrollTop before and after every focus action;
7. PTY ID, xterm instance identity, rows/cols, scrollback length, and WebGL/canvas identity before and after focus changes.

The cause and parity are confirmed when the shield prevents first-click content activation, the epoch reliably restores the helper textarea, and no terminal runtime identity changes.

## Verification plan

### Safety boundary

- Never close, overwrite, update, automate, or publish `%LOCALAPPDATA%\Programs\PLANO\PLANO.exe`.
- Launch only development Electron with a unique disposable `PLANO_USER_DATA_DIR`.
- Use a unique CDP port.
- Identify and stop test processes only by the exact development/release path or CDP port. Never kill `PLANO.exe` by name.
- Do not launch Deska for verification; its inspected source is the behavioral reference.

### Automated interaction matrix

Extend the isolated dev E2E harness with assertions for:

- click terminal A: A is `1`, every other floating surface is `0.75`;
- hover terminal B while A remains focused: B is `1`, A remains the logical focus;
- leave B: B returns to `0.75`;
- first click on B's content changes focus but sends no character/click to B;
- second click operates inside B;
- refocus already-focused B after an overlay stole DOM focus: `focusEpoch` increments and xterm textarea becomes active;
- click empty canvas without dragging: no focused surface;
- pan empty canvas: behavior matches the chosen clear-on-click rule;
- header drag and all resize handles work from unfocused state;
- right-click/context menus work without unintended focus or command input;
- docked terminals focus the outer group while the correct member xterm receives keyboard input;
- dock/undock, tab switch, panel close, workspace switch, and restore leave no stale focus ID;
- terminal PTY/session/xterm identities remain unchanged;
- no autosave is scheduled solely by a focus or hover change.

### Visual/performance matrix

Verify light/dark themes, terminal color themes, zoom levels, 240 Hz input, and an integrated GPU with:

- one terminal;
- ten terminals;
- thirty mixed panels;
- a running high-output terminal;
- an active AI agent terminal;
- overlapping panels and dock groups;
- canvas pan/zoom during and immediately after a focus transition.

Capture screenshots at rest, hover, focused, and no-focus states. Capture a Chrome performance/compositor trace for rapid focus switching. Acceptance requires no text shimmer, no fractional-scale rasterization, no sustained layer explosion, no dropped terminal output, and no whole-app frame stalls.

## Delivery order

1. Add the transient focus store and lifecycle cleanup.
2. Add top-level surface/member identity, including dock groups.
3. Add exact `1.00 / 0.75 / hover 1.00` opacity behavior and 180 ms transition.
4. Add the transparent first-click shield with header/resize/drop exceptions.
5. Add empty-canvas unfocus.
6. Expose engine-level terminal focus and implement the epoch subscription/retry/scroll preservation.
7. Add dock/tab/workspace transfer rules.
8. Run isolated functional, visual, accessibility, and integrated-GPU performance tests.

## Definition of done

The mode is complete when PLANO reproduces Deska's relevant focus semantics—not merely its color: one logical focused canvas surface, unfocused opacity `0.75`, hover restoration to `1`, a transparent first-click input shield, explicit empty-canvas unfocus, same-node focus epochs, and reliable xterm textarea focus with preserved scroll. The implementation must remain transient, avoid autosave, preserve every terminal runtime, and pass the isolated many-panel integrated-GPU matrix without touching the installed application.
