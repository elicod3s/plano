# PLANO documentation

This is the documentation index for the PLANO repo. Docs are grouped by who they are for:
visitors wanting the big picture, contributors touching the code, and the project's own
open work items.

## Start here

- **[README](../README.md)** — what PLANO is, the download link, and what makes it different.
- **[Architecture](architecture/ARCHITECTURE.md)** — how the app is built: the three-process
  split (renderer / preload / main), the canvas model, agent detection, persistence.
- **[Design system](design/DESIGN_SYSTEM.md)** — the locked visual language ("Monolith Draft"):
  tokens, typography, color rules, what must never change.

## For contributors

### Architecture

- [Architecture](architecture/ARCHITECTURE.md) — the full system spec.
- [Mobile & Remote](architecture/MOBILE_REMOTE.md) — the detached agent host, the PLANO Mobile
  web app, and the packaging/install/deploy workflow. Read it before touching those modules;
  update it when something changes.

### Design

- [Design system](design/DESIGN_SYSTEM.md) — tokens, layout, motion, and the hard rules.

### Platform setup

- [Linux setup](engineering/LINUX_SETUP.md) — Fedora package list, node-pty rebuild, Wayland
  launch flags, and packaging for AppImage + rpm.

### Terminal

- [Terminal analysis](engineering/terminal/ANALISIS_TERMINAL_PLANO.md) — how the terminal is
  built: xterm + node-pty, the persistent-session registry, the render-box scaling model.
- [Glyph alignment brief](engineering/plans/BRIEF_TERMINAL_GLYPH_ALIGNMENT.md) — why the
  render-scale model exists and where the relevant code lives (paired with
  `tests/e2e/glyph-align-probe.mjs`).

### Voice

- [Odla voice handoff](engineering/voice/ODLA_VOICE_HANDOFF.md) — problem spec for the voice
  assistant work: what it is, where it should go, what is failing. Deliberately contains no
  solutions.

## Open work

These documents track work that is planned or in flight. Read them before picking anything up.

- [Mesh v7 orchestration](engineering/plans/PLAN_AGENT_MESH_V7_ORCHESTRATION.md) — the
  orchestration layer on top of the mesh transport; what exists and what is missing
  (`worker-start`, lifecycle commands, gates, tombstones).
- [Terminal drag & focus plan](engineering/plans/PLAN_TERMINAL_DRAG_FOCUS.md) — paused
  implementation plan for crisp drag ghosting and focus dimming; provisional changes exist
  but are not accepted yet.
- [Agents open issues](engineering/plans/STATUS_AGENTS_OPEN_ISSUES.md) — current state of the
  agent mesh, what is proven vs unverified, and the ordered next steps.

## Tests

- [tests/e2e](../tests/e2e/README.md) — the dev-run regression probes (one per regressible
  behavior, launched against isolated user data).

## House rules

- Everything in this repo is written in **English**.
- The repo root keeps only `README.md` and `CLAUDE.md`.
- Living architecture goes in `docs/architecture/`, visual decisions in `docs/design/`,
  engineering diagnosis and plans in `docs/engineering/`, reusable probes in `tests/e2e/`.
- Personal / unreleased material (e.g. launch-marketing drafts) lives in `docs/private/`,
  which is gitignored — never commit it.
- When a document moves, update this index.
