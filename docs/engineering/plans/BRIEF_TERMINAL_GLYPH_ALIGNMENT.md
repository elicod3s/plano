# BRIEF — terminal text renders crooked until a selection redraws it

You are working in **`D:/Tools/Plano`** (branch `mac-build-odla`). Read `CLAUDE.md` first — the
terminal section carries hard-won rules you must not undo.

## The symptom (user evidence, three screenshots)

A list rendered by an agent CLI inside a PLANO terminal:

```
◇ Detected harnesses
  Claude Code      C:\...
  Codex CLI        C:\...
  Cursor           C:\...
  Gemini CLI       C:\...
  Grok Build       C:\...
```

- Normally the glyphs look **uneven — letters sit at slightly different baselines and horizontal
  offsets**, as if each character were nudged by a fraction of a pixel. The user's words: "el texto
  se ve chueco y nada centrado" ("the text looks crooked and nothing is centered").
- **Select that same text (drag-highlight) and it snaps straight**: correct baseline, even spacing.
  Same text, same font, same line — only the draw path changed.

That difference is the whole diagnosis: the content is fine, the RASTERISATION is off-grid, and the
selection layer forces a redraw that lands on the cell grid.

## Where to look (do not guess — measure)

The terminal uses the **render-scale model**: xterm is opened into a counter-scaled render
box and the font size is `fontSize × renderScale`, so the canvas stays crisp under canvas zoom.

- `src/renderer/panels/terminal/useXterm.ts` — the render-scale model, font size, resize/fit path.
- `src/renderer/panels/terminal/engine/TerminalEngine.ts` — session/renderer lifecycle (recently
  touched: font stack + cell recalculation).
- `src/renderer/panels/terminal/xtermTheme.ts` — theme + font family passed to xterm.
- `src/renderer/styles/terminal-symbols.css` — the layered fallback faces.
- `src/renderer/panels/terminal/TerminalView.tsx` — the padded/clipped container and the render box.

Prime suspects, in order:

1. **Fractional font size or cell size.** `fontSize × renderScale` (and any `devicePixelRatio`
   multiplication) can produce a non-integer px size; the WebGL renderer then rasterises glyphs at
   fractional cell origins and every character picks up a sub-pixel offset. Check what
   `terminal._core._renderService.dimensions` reports for `actualCellWidth/Height` and whether they
   are integers. Rounding the effective font size (or the cell metrics) to whole device pixels is
   the likely fix.
2. **A counter-scale transform with a non-integer factor** on the render box, which moves the whole
   canvas off the device-pixel grid. Snapping the transform to whole device pixels fixes the same
   class of blur.
3. **Font fallback mixing faces mid-line** (a separate bug already worked on — JetBrains Mono is now
   the primary face and Cascadia is limited to Braille/Powerline). Confirm a normal ASCII line uses
   exactly one face; if a fallback face has different metrics it will also look uneven.

## Hard constraints (from CLAUDE.md and past regressions)

- **Keep the WebGL renderer** with its one-shot context-loss guard. The DOM renderer garbles under
  canvas zoom and the 2D canvas duplicates glyphs — both were tried and reverted.
- **Do not raise the terminal `lineHeight` from 1.0** and do not delete the bundled fallback faces
  (`assets/fonts/*.woff2`): they exist so CLI box-drawing, Braille spinners and the Claude ✻✳ stars
  render at all.
- Keep the render-scale model. The right-edge clipping fix depends on it; do not replace it with
  layout-px reserves.

## How to verify (do not claim it by reasoning)

Run the app (`npm run dev`) and compare the SAME line before and after a selection at 100% canvas
zoom and at a zoom like 71% and 127%, where fractional scales appear. The bug is fixed when the
unselected text is already as straight as the selected text at every zoom level. Include a
before/after description of what you measured (cell metrics, font size, transform), not just "looks
better".

Also verify a box-drawing + Braille sample still renders (`╭─╮ │ ⠋⠙⠹` and the Claude ✻ mark).

## Rules

- `npm run typecheck` clean; `npx electron-vite build` before testing.
- **Do NOT run `npm run dist`, do not publish, do not touch the user's installed PLANO.**
- Another agent may be editing `src/main/daemon/**` concurrently — stay in the renderer/terminal
  files above and re-read a file before editing it.
- Comment the WHY of any metric rounding you introduce, in the style used in `useXterm.ts`.

Report: what you measured, what you changed, and anything you found but did not fix.
