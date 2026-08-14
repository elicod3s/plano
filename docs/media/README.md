# Shot list

Six screenshots. Real agents, real work — nothing staged. Each one has a fixed filename; drop the
file in this folder, then open `README.md` at the repo root, find the matching `MEDIA SLOT`
comment and uncomment the one line inside it. Nothing else to edit.

## How to shoot (applies to every shot)

- **Window**: maximised, on the darkest wallpaper you have — or full-screen the app. No other
  windows, no taskbar overlap.
- **Frame**: press **Zoom to fit** before capturing. It centres the content with equal air on
  every side, which is what makes a shot read as designed instead of cropped.
- **Nothing transient on screen**: no toasts, no open menus, no command palette, no hover
  tooltips, no text selection. Minimap off.
- **Real content, short content**: agents mid-work with a few clean lines beat a wall of scroll.
  Avoid stack traces, MCP boot errors and anything red.
- **No personal data**: check the paths in the terminal prompts, the workspace name, the git
  branch and the window title. `C:\Users\<you>` should not be readable anywhere.
- **Format**: PNG, captured at 2× if your display allows (a Retina/2× shot stays sharp when
  GitHub scales it down). Aim for ~2400 px wide; keep each file under ~2 MB.

---

## 1. `hero-canvas.png` — the one that sells it

The whole canvas, zoomed to fit, with **4–6 panels** doing different things at once: two or three
agent terminals mid-turn, a Files/editor panel with real code, a browser panel, and a markdown or
sticky note. Nothing overlapping.

This is the first image on the page. If someone only looks at one, it is this one — it has to say
"many things at once, and it is organised" without a caption.

## 2. `canvas.png` — a canvas, not tabs

Same canvas but **zoomed out further**, so the spatial idea reads: panels placed deliberately in
groups, plenty of empty space around them. A region or a text label in the background helps show
that the canvas is organised, not scattered.

## 3. `agent-mode.png` — a terminal becoming an agent

**Close in on ONE panel.** An agent CLI running inside it (Oh My Pi, Claude Code, Codex…), with
the panel tinted in that agent's accent and its badge visible in the header. Crop so the panel
fills most of the frame — this shot is about the morph, not the canvas.

Ideally capture it mid-turn, so the breathing glow and the "working" state are visible.

## 4. `orchestration-tree.png` — **the signature shot**

The one that shows what PLANO is for. A **coordinator agent with 3 workers spawned beneath it**,
in the tree layout:

1. Open one agent (this is the coordinator).
2. From inside it, run `plano spawn omp . --count 3 --prompt "<a real task>"`.
3. Wait until the three children have booted and are visibly working.
4. Zoom to fit and capture.

What must be visible: the parent on top, the three children in one row below it, centred, and the
mesh link lines connecting them. If the workers are still booting and look noisy, wait — the shot
is worth the extra minute.

## 5. `mesh.png` — agents talking to each other

Two or three agents where a **message has visibly travelled**: one agent's terminal showing the
`plano send` it ran, the other showing the message it received and its reply. The `Ctrl+Shift+A`
mesh overlay open on top is a good alternative if it reads more clearly.

The point is proof: they really do talk, and you can see both ends.

## 6. `mobile.png` — optional

The phone app showing a running agent, ideally photographed or screenshotted **with the desktop
app closed**, to make the "agents survive" claim concrete.

---

## When you have them

Drop the files here, uncomment the matching lines in the root `README.md`, then:

```sh
git add docs/media README.md
git commit -m "Add launch screenshots"
git push
```
