# PLANO — Terminal loses its scroll position (jumps to old content) when the canvas is zoomed

This document describes a bug precisely, with captured runtime evidence, for another AI to fix.
It deliberately does **not** propose solutions — only the problem, the evidence, and the requirement.

---

## 1. App context

PLANO is an Electron infinite-canvas IDE. The renderer (React + Zustand) draws a single pan/zoom
canvas; panels (terminals, editors, etc.) live at world coordinates inside one world layer that has a
single CSS `transform: scale(zoom)` applied to it. Canvas zoom is changed by **Alt + mouse wheel** and
by the Dock **+ / −** buttons (both write `useViewportStore.zoom`).

Terminal panels use **xterm.js 5.5.0** with the **WebGL renderer addon** (`@xterm/addon-webgl`). The
relevant code is `src/renderer/panels/terminal/useXterm.ts` (the hook that owns the xterm instance),
with the render box laid out by `src/renderer/panels/terminal/TerminalView.tsx`.

## 2. The "render-scale" model (why the terminal font changes when you zoom the canvas)

To keep glyphs crisp when the world layer is scaled up (zoom > 1), the terminal is **not** opened
directly into the world layer. Instead xterm is opened into a counter-scaled **render box**:

- `snapRenderScale(zoom)` snaps the live canvas zoom to a discrete step: `[1.0, 1.5, 2.0, 2.5]`
  (zoom ≤ 1 ⇒ 1.0; the 1.0↔1.5 boundary is at zoom ≈ 1.25, etc.).
- For the current step `s`, the render box is sized `width = height = (100 × s)%` of its container and
  given `transform: scale(1/s)` (origin `0 0`), and `term.options.fontSize` is set to `base × s`
  (base = 13, rounded to an integer: 13, 20, 26, 33 for s = 1, 1.5, 2, 2.5).
- Net effect: at higher zoom xterm rebuilds its glyph atlas at a higher resolution, then the box is
  scaled back down, so the on-screen size is unchanged but crisp.

So: **crossing a render-scale step while zooming the canvas changes `term.options.fontSize` (and hence
the xterm cell height) and resizes the render box.** The grid (`cols`/`rows`) is intentionally NOT
re-fit on zoom (box and font scale together, so the row count is unchanged).

This logic lives in the `onZoom` handler inside `useXterm.ts`, which is subscribed to
`useViewportStore`. It applies the new box size + font size and (currently) tries to re-pin the
viewport to the bottom.

## 3. Symptom (user-facing)

When the user zooms the canvas over a terminal that is scrolled to the bottom (showing the latest
output — e.g. an AI-CLI "conversation" such as Claude Code, which runs in xterm's **normal** buffer
with scrollback), the terminal **jumps up to older content** instead of staying pinned to the latest
line. The latest output goes off-screen ("se pierde la conversación"). It does **not** recover by
itself — it stays scrolled up. The effect is more pronounced the more the user zooms (i.e. the larger
the render-scale step / font change). Reported repro: "when it goes from ~122% to ~142%" (i.e. crossing
a render-scale boundary), and worst at the highest zoom.

## 4. Reproduction

1. Open a terminal panel; produce enough output to have a long scrollback (hundreds of lines) and stay
   at the bottom (latest line visible).
2. Zoom the canvas in/out with Alt + wheel (or the Dock +/− buttons) across the render-scale step
   boundaries (≈125%, ≈175%, ≈225%), especially up to the maximum.
3. Observe: the terminal's visible content jumps to an earlier point in the buffer and stays there.

## 5. Instrumented runtime evidence (this is the key data)

`useXterm.ts` was temporarily instrumented to log, on every render-scale settle and on every native
`.xterm-viewport` `scroll` event: the snapped scale, the live zoom, `term.options.fontSize`,
`term.rows`/`term.cols`, `term.buffer.active.type`, and — crucially — xterm's internal buffer scroll
indices `baseY` (= bottom row index of the scrollback, "ybase") and `viewportY` (= top visible row
index, "ydisp"), plus the DOM `.xterm-viewport` `scrollTop` / `scrollHeight` / `clientHeight`.

Across 321 captured snapshots from a real zoom session (terminal at `rows: 55, cols: 157`,
`buffer length: 1866`, `baseY: 1811`, `bufType: "normal"` in 100% of samples):

- In **221** snapshots `viewportY === baseY === 1811` (buffer correctly at the bottom).
- In **61** snapshots `viewportY === 1058` while `baseY === 1811` — i.e. **the buffer itself is
  scrolled up by 753 lines** (this is the bug state, not merely a visual/DOM artifact).
- A few transient values (`1799`, `1805`).

The exact transition into the drifted state (consecutive log lines; `[renderer]` prefix removed):

```
settle  from 1.5 to 2.5   before: fontSize 20, viewportY 1811, baseY 1811, scrollTop 31777, scrollH 48021, clientH 1430
after-sync   scale 2.5    fontSize 33, viewportY 1811, scrollTop 31777, scrollH 48021, clientH 1430   (scrollH/clientH still stale)
after-rAF    scale 2.5    fontSize 33, viewportY 1811, scrollTop 46591, scrollH 48021, clientH 1430
scroll       scale 2.5    fontSize 33, viewportY 1811, scrollTop 46545, scrollH 48021, clientH 1476
scroll       scale 2.5    fontSize 33, viewportY 1058, scrollTop 46545, scrollH 52571, clientH 1697   <-- DRIFT
settle  from 2.5 to 2     before: fontSize 33, viewportY 1058, baseY 1811 ...                          (now stuck scrolled up)
```

Reading of the drift line: the cell height at `fontSize 33` is ≈ 44 px. The DOM `scrollTop` is stuck at
`46545`. `46545 / 44 ≈ 1058`. So when a native `scroll` event fired (the viewport's `scrollHeight`
changed from `48021` → `52571` and `clientHeight` from `1476` → `1697` as the box/cell sizes were still
settling), **xterm's viewport scroll handler recomputed the top visible line from the stale pixel
`scrollTop` and the new cell height, yielding line 1058 instead of 1811, and set `viewportY = 1058`.**
The buffer is now genuinely scrolled up by 753 lines.

Corroborating "at the bottom" math from the same session at the base step (`fontSize 13`, cell height
≈ 17 px): `viewportY = baseY = 1811`, `scrollTop = 30787 = 1811 × 17`. So at a stable step the DOM
`scrollTop` correctly equals `viewportY × cellHeight`. The drift only appears when the cell height
changes (render-scale step) and the DOM pixel `scrollTop` is not reconciled with the new cell height.

## 6. Established mechanism (from the evidence)

- `bufType` is always `"normal"` — this is **not** an alternate-screen (full-screen TUI) issue.
- The buffer's logical scroll (`viewportY`) is the thing that drifts (1811 → 1058), so the wrong content
  is genuinely rendered — it is not only a scrollbar/DOM cosmetic.
- The drift is triggered by the **render-scale font change**: changing `term.options.fontSize` changes
  the xterm cell height and the viewport's `scrollHeight`, while the render box (`.xterm-viewport`
  `clientHeight`) is simultaneously being resized. During that transition a native `scroll` event
  fires, and xterm derives the new `viewportY` from the **stale DOM pixel `scrollTop` ÷ the new cell
  height**, landing on an earlier line. The DOM `scrollTop` is never rescaled to keep `viewportY`
  pinned across the cell-height change.
- The magnitude of the drift scales with the size of the cell-height change → worse at higher zoom.
- Once `viewportY < baseY` (scrolled up), the terminal does not return to the bottom on subsequent
  zoom steps: every later settle measures "not currently at the bottom", so any conditional re-pin is
  skipped and the terminal stays scrolled up.

## 7. Already attempted and confirmed NOT to fix it (stated only so they are not repeated)

These were tried in `onZoom` and verified ineffective against the behavior above:

- Calling `term.scrollToBottom()` after the font/box change, including re-pinning across several
  animation frames. (Ineffective: when xterm already considers itself at the bottom,
  `scrollToBottom()` is a no-op; and once the drift has happened the re-pin is gated off by the
  "was at bottom" check.)
- Reordering so the render box is resized **before** the font is changed (so xterm's font-triggered
  re-sync sees the new box). The drift still occurs.

A standalone reproduction (the same render-scale model + WebGL addon, driven programmatically through
the exact step changes) did **not** reproduce the drift — so the trigger involves the real interactive
zoom sequence / live viewport scroll events, not the isolated font+box change.

## 8. Requirement

Fix this definitively. After any canvas zoom (any render-scale step change, in either direction, at any
speed, up to the maximum), a terminal that was showing its latest output must **remain pinned to the
latest line** — the buffer must not drift to older content. A terminal that the user had deliberately
scrolled up to read history should keep showing that same logical position (it must not be force-jumped
to the bottom either). The fix must hold for the WebGL renderer and for normal-buffer content
(shells and AI CLIs such as Claude Code / Codex).

## 9. Relevant files

- `src/renderer/panels/terminal/useXterm.ts` — the xterm instance, the `onZoom` render-scale handler,
  `applyRenderBoxStyle`, `applyFontSize`, `snapRenderScale`, `safeFit`, the ResizeObserver, and the
  WebGL addon loading.
- `src/renderer/panels/terminal/TerminalView.tsx` / `TerminalPanel.tsx` — the container + render box DOM.
- `src/renderer/canvas/hooks/usePanZoom.ts` — Alt+wheel → `useViewportStore.zoomAt`.
- `src/renderer/stores/useViewportStore.ts` — the `zoom` value `onZoom` subscribes to.
- Reference implementation that does not exhibit the bug: an app called "Deska" — extracted source at
  `D:/tmp/deska/src/renderer/...` (`panels/terminal/hooks/use-render-scale.ts`,
  `lib/terminal-registry/registry.ts`) and `DESKA_TERMINAL_REFERENCE.md` in this repo.
