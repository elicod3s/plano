# E2E probes

Dev-run verification probes. Each one checks behavior that has broken before and can break
again — they are the closest thing the repo has to a regression suite. They are NOT wired into
CI: they launch the real app (or the daemon) against an isolated user-data dir and assert
observable behavior over CDP or the mesh protocol.

There is no test runner. Run a probe with `node <probe>.mjs` from the repo root. Most need a
built app first (`npm run build`), a few can run against the dev checkout.

## What each probe verifies

| Probe | Verifies | Needs |
|---|---|---|
| `glyph-align-probe.mjs` | Terminal glyph alignment: box-drawing / block glyphs stay inside their cell at every zoom step | Built app |
| `mesh-cli-e2e.mjs` | The `plano` CLI against a real freshly booted daemon: spawn → answer the trust prompt → `send --wait` / `spawn --wait` real turns (C1–C17+) | Built app + a real agent CLI (codex) on PATH |
| `retired-panels-migration.mjs` | Workspaces saved with retired panel types (`agent`, `git`, `voice`) still load — they migrate instead of breaking the canvas | Built app |
| `files-instant-probe.mjs` | Files panel instant-open contract: shell paints immediately, root entries after one shallow read, no `Loading…` block, editor instance stable across file switches | Dev checkout |
| `watch-fix-probe.mjs` | Files-panel watcher semantics: writing an unrelated file must NOT re-read the open file; writing the open file still live-reloads | Dev checkout |
| `appearance-polish-probe.mjs` | Appearance UI: theme count, accent swatches, background picker live-updates the canvas | Built app |
| `mesh-wait-robust.mjs` | `plano wait` always answers: already-finished peer → `alreadyIdle`, `--next-turn` keeps old semantics, permission prompt → `blocked` | Built app (no model calls) |
| `mesh-path-provision.mjs` | Production provisioning path: CLI installed into `<userData>/bin`, spawned shells have it on PATH, harness mesh briefing written into a throwaway HOME | Built app |
| `usage-probe.mjs` | Usage/status-bar chips against LOCAL mock provider endpoints — deterministic, no real credentials leave the machine | Built app |
| `smoothness-probe.mjs` | Canvas smoothness with a Files panel: measures pan/zoom long tasks and frame cost | Built app |

## Conventions

- Every probe launches the app with an ISOLATED user-data dir and a unique CDP port — never the
  installed app, never the real user data.
- Probes that simulate agents use throwaway harness binaries or plain shells with a reported
  verdict; nothing real is ever touched.
- Results are printed as structured lines (`{ name, pass, observed, expected, error? }`).
