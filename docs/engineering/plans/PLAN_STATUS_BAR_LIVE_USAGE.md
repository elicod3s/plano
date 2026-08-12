# PLAN — Live Status Bar (subscription usage · ports · resources)

Status: ready to execute · Date: 2026-08-12 · Owner: dispatched agent (see "Ownership")

## Why

PLANO can open a fleet of agents but tells the user nothing about the budget they burn. The
question a user actually has mid-session is "how much Claude do I have left, and until when?" —
today the only way to know is to leave PLANO and ask each CLI. A canvas that hosts agents should
surface the cost of running them.

Reference (studied, NOT copied): Orca's status bar (`stablyai/orca`) reads live quota per
provider and renders one chip each. We take its **data sourcing** — which is the hard, factual
part — and reject its visual language: Orca's bar is a dense ASCII-ish strip of raw percentages.
PLANO's must read as one calm instrument: a single hairline row of pill chips, monochrome by
default, where **color appears only when a budget is actually at risk**.

## What ships

A persistent bar docked to the bottom edge of the app shell (`chrome/`), above nothing, never
overlapping canvas content, ~28 px tall, hidden in zen/focus mode:

| chip | content | source |
| --- | --- | --- |
| per provider | `◔ Claude 4% · 2h47m` — ring + name + used% + time to reset | live quota (below) |
| ports | `⇄ 3` — listening ports owned by this workspace's terminals | port scan |
| resources | `▤ 5.34 GB` — RSS of the app + every agent process | ProcessTreeService |
| agents | `⌁ 5` — live terminals / detected agents | useTerminalStore + useAgentStore |

Only providers with real credentials on this machine appear. A provider that cannot be read is
**absent, not zero** — never invent a number.

## Design (locked by `docs/design/DESIGN_SYSTEM.md`)

- One row, `h-7`, `border-t border-default`, surface `--surface-2`, full app width, `z` below
  overlays/menus. Chips are `rounded-pill`, `px-2 py-0.5`, `text-[11px]`, JetBrains Mono for
  every numeral, Space Grotesk for labels.
- **Monochrome until it matters.** Ring + text use `--text-secondary`. The ring fills with
  `--text-primary`. At ≥80% used the chip switches to the provider's own accent
  (`AGENTS[kind].accent`); at ≥95% it uses `#EF4444` (the reserved destructive red) — that is the
  ONLY red in the bar. No gradients, no glow, no rainbow row.
- The usage ring is a 12 px inline SVG donut (`stroke-dasharray`), not a progress bar: it reads
  as an instrument, scales crisply, and costs one element.
- Reset time is relative and compact (`2h47m`, `5d18h`), recomputed by a single 30 s ticker for
  the whole bar — never one timer per chip.
- Hover → popover (existing `chrome` popover style) with the exact windows: `5h 4% · resets
  19:40`, `7d 53% · resets Thu`, plus the source (`statusline` / `oauth` / `cli`) so a stale
  number is explainable. Click → opens the provider's section in Settings.
- Reduced motion: the ring never animates on tick; it cross-fades value changes only when
  `reduceMotion` is off.
- No filler copy anywhere (CLAUDE.md rule): chips are label + number, nothing else.

## Architecture

**The feed lives in the daemon, not the app.** The Agent Host already owns every PTY, survives
app closes and serves PLANO Mobile — so usage collected there is available to the phone and
survives restarts, and the Claude hook can post to a port that is always up. This is the
PLANO-native difference from Orca (whose collection sits in the desktop main process).

```
harness CLI ──hook/scan──▶ daemon UsageService ──host event──▶ main ──IPC──▶ useUsageStore ──▶ StatusBar
                                    └──────────────▶ web/ (mobile) same snapshot
```

### 1. Shared contract — `src/shared/domain/usage.ts` (new)

```ts
export type UsageProviderId = 'claude' | 'codex' | 'gemini' | 'opencode-go' | 'grok' | 'omp'
export interface UsageWindow {
  usedPercent: number          // 0-100
  windowMinutes: number        // 300 = 5h, 10080 = 7d, 43200 = 30d
  resetsAt: number | null      // unix ms
}
export interface ProviderUsage {
  provider: UsageProviderId
  status: 'ok' | 'stale' | 'unavailable'
  session: UsageWindow | null   // 5h
  weekly: UsageWindow | null    // 7d
  monthly: UsageWindow | null   // 30d (opencode-go, grok)
  source: 'statusline' | 'session-file' | 'api' | 'cli'
  updatedAt: number
  detail?: string               // why unavailable — shown in the popover, never as a number
}
export interface UsageSnapshot { providers: ProviderUsage[]; at: number }
```

Percentages are clamped 0-100 and **rounded once, at render**. Never store pre-formatted strings.

### 2. Provider adapters — `src/main/daemon/usage/<provider>.ts` (new)

Each adapter exports `read(): Promise<ProviderUsage | null>` and MUST return `null` (→ chip
absent) when the credential/file is missing. Never throw into the collector.

**claude** — primary source is Claude Code's own `statusLine` hook: Claude Code (≥2.1.80) pipes
a JSON payload on stdin to the configured status-line command on every turn, and for
Claude.ai-subscriber sessions that payload carries
`rate_limits: { five_hour: { used_percentage, resets_at }, seven_day: { … } }`. This is free
(it rides existing API responses) whereas the OAuth usage endpoint 429s under polling.

Implement as: `installUsageHook()` writes `<userData>/bin/plano-statusline.cmd` (+ a POSIX twin)
and merges `statusLine` into `~/.claude/settings.json` **only if the user has no statusLine of
their own** (if they do: leave it, mark the provider `unavailable` with
`detail: 'a custom statusLine is installed'` — never clobber a user's config). The script must:
1. read stdin into a per-pane temp file (no stdout — the user's status line must not change),
2. `findstr /c:"rate_limits"` guard before anything else (the hook fires ~3×/s while streaming),
3. throttle to one POST per 15 s per pane via a stamp file,
4. `curl -sS -X POST http://127.0.0.1:56780/usage/claude` with the payload + `CLAUDE_CONFIG_DIR`.

Add `POST /usage/claude` to `src/main/daemon/webServer.ts` (loopback-only, same guard style as
the mesh endpoint). Parse defensively: accept `used_percentage` OR `utilization`, accept
`resets_at` as epoch seconds OR an ISO string, drop the window when neither parses.

**codex** — read the newest rollout files under `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`
(honour `CODEX_HOME`). VERIFY THE SHAPE ON THIS MACHINE FIRST: tail a real rollout and find the
event that carries rate-limit state (expected `token_count` with `rate_limits.primary/secondary`
each having a used-percent, a window size and a reset offset). Map primary→session,
secondary→weekly. If the field names differ from this doc, TRUST THE FILE and note it in the
plan's "Findings" section at the bottom. Only files modified in the last 24 h are read, tail-first,
capped at 256 KiB per file.

**opencode-go** — quota lives behind the opencode.ai web session, not on disk. Add a Settings
field where the user pastes their `auth` cookie (accept a bare `Fe26.2**…` token and wrap it as
`auth=<token>`; accept a full cookie header unchanged). Store it in `settings.json` under
`usage.opencodeCookie` — never log it, never send it anywhere but `https://opencode.ai`. Fetch
the workspace list, then its subscription/usage, and map the 30-day allowance to `monthly`.
Timeout 15 s, one refresh per 10 min, `unavailable` + `detail` on any failure. Without a cookie
the chip simply does not exist.

**gemini / grok / omp** — same contract, credential-gated (`~/.gemini`, the Grok CLI's config,
`~/.omp`). Ship them behind the same interface but it is acceptable to land them as `null`
adapters in this pass; the bar must not regress when they are added later.

### 3. Collector — `src/main/daemon/usage/service.ts` (new)

- One `UsageService` owned by the daemon, started at boot after `installCli`.
- Refresh policy: push-driven for claude (the hook POSTs), 60 s poll for file-backed providers,
  10 min for network-backed ones, plus an immediate refresh on `usage:refresh`.
- Backoff: on `error`, double the interval up to 15 min; honour `Retry-After` when present.
- Caches the last good snapshot to `<userData>/usage.json` so the bar is populated instantly on
  launch (rendered `stale` until the first live read lands).
- Broadcasts `usage` frames on the existing daemon→app channel; `AgentHostClient` re-emits them,
  `registerIpc` exposes `usage:get` + the `usage:changed` event, `preload` wraps it, and
  `src/renderer/types/global.d.ts` gets the same members (BOTH files — the renderer tsconfig does
  not read `preload/index.d.ts`).

### 4. Ports chip — `src/main/daemon/usage/ports.ts` (new)

Reuse what exists: `ProcessTreeService` already snapshots `Win32_Process`, and `DevUrlService`
already recognises dev-server URLs in terminal output. Add a listening-socket scan
(`Get-NetTCPConnection -State Listen` on Windows, `lsof -iTCP -sTCP:LISTEN` elsewhere), keep only
ports whose owning PID is a descendant of a PLANO PTY, and join them to the panel that owns them.
The popover lists `:5173  vite  Terminal 2` with actions: open in a browser panel (reuse
`actions.ts`), copy URL, and kill (confirm first — killing a user's server is destructive).

### 5. Renderer — `src/renderer/chrome/statusbar/` (new folder)

`StatusBar.tsx` (row + layout), `UsageChip.tsx` (ring + label + popover), `PortsChip.tsx`,
`ResourceChip.tsx`, `usageFormat.ts` (pure: percent → ring path, ms → `2h47m`; unit-testable and
where every rounding decision lives). State: `src/renderer/stores/useUsageStore.ts`, hydrated
from `usage:get`, updated by the event. Mount once in `App.tsx` below the canvas; the canvas
container must lose the bar's height so panels never sit underneath.

### 6. Settings

New Appearance/General rows (follow the existing recipe in `shared/domain/settings.ts` +
`renderer/chrome/settings/sections.tsx` + `SETTINGS_INDEX`): show/hide the bar, per-chip
visibility, and the OpenCode Go cookie field (masked). Defaults: bar ON, all detected providers
shown.

## Ownership — do not touch these files

Another agent is concurrently reworking canvas input (marquee selection + cursor). **Do not edit**
`src/renderer/canvas/**`, `src/renderer/panels/_base/PanelFrame.tsx`, `usePanZoom.ts`, or
`useSelectionStore`. If the bar needs canvas height, change it in `App.tsx` only and say so.
Re-read any file before editing it — several agents work this repo at once.

## Acceptance criteria

1. `npm run typecheck` clean (node + web). No test runner exists — pure logic goes in
   `usageFormat.ts` and is exercised by a probe script.
2. `.plano-tests/usage-probe.mjs` (new): boots the daemon the way the app does (`--userData
   <temp>`, no `PLANO_USER_DATA_DIR`; copy the pattern from `mesh-path-provision.mjs`), asserts
   (a) the Claude hook script + settings merge are installed and idempotent, (b) a synthetic
   `POST /usage/claude` with a real-shaped payload lands as a `claude` provider with both windows,
   (c) a synthetic codex rollout file is parsed into `session`/`weekly`, (d) a provider with no
   credentials is ABSENT from the snapshot rather than 0%. Prints `RESULT: {ok:true,…}`.
3. Real-machine check: with Claude Code running in a PLANO terminal, the claude chip shows a
   number that matches `/usage` inside Claude Code, and the ports chip lists a real dev server.
4. The bar renders correctly in the Light theme and at 200% zoom, and disappears with reduced
   motion still respected (no animation).
5. Nothing regresses: `node .plano-tests/mesh-cli-e2e.mjs` still returns `ok:true`.

## Findings (fill this in while executing)

Record here anything the code contradicted — especially the exact codex rollout field names, and
whether Claude Code on this machine emits `rate_limits` (check with a throwaway statusLine that
dumps stdin to a file). A wrong assumption written down is worth more than a silent workaround.

### Claude Code (2.1.226) — payload implemented, live arrival NOT confirmed on this machine

- The installed binary contains the payload strings: `grep -ac` on
  `~/AppData/Roaming/npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe` → `rate_limits` 10,
  `five_hour` 18, `seven_day` 23, `used_percentage` 8, `resets_at` 8, `statusLine` 30.
- Official statusLine docs (code.claude.com/docs/en/statusline) confirm the schema:
  `rate_limits.five_hour.{used_percentage,resets_at}` / `rate_limits.seven_day.{…}`, present only
  for Claude.ai Pro/Max subscribers after the first API response; each window may be independently
  absent. The plan's `five_hour`/`seven_day` shape is correct.
- **Windows statusLine runner quirk (empirical):** with throwaway `CLAUDE_CONFIG_DIR`s on this
  machine (Git Bash present), a statusLine command whose SCRIPT writes files errors with claude's
  own `error: failed to redirect to <path-inside-the-script>: The system cannot find the file
  specified. (os error 2)` — the script either doesn't run or gets empty stdin. Pure-stdout
  statusLines run fine (the user's own display-only `~/.claude/statusline.js` works). The plan's
  findstr→temp-file→curl hook script is exactly the file-writing shape that fails here. Mitigation
  shipped: the hook scripts use `%TEMP%`-only paths (no literal file paths in the script body).
  Consequence for the live path: on machines where the hook IS merged, it may not fire; the chip
  then stays absent — which the design already allows. The receiving end is proven by the probe
  with a synthetic payload (acceptance 2b), not by a live turn.
- This machine has a custom statusLine (`node C:/Users/Administrator/.claude/statusline.js`,
  display-only) → per plan the merge is SKIPPED and the claude chip renders `unavailable` with
  detail `a custom statusLine is installed` (credentials are present). Live confirmation
  (acceptance 3) is therefore not observable here by design.

### Codex — rollout field names VERIFIED from a real file

Read `~/.codex/sessions/2026/08/12/rollout-2026-08-12T01-20-44-019ff4a1-…jsonl` (codex-cli
0.147.0). The rate-limit state rides `event_msg` lines:

```json
{ "type": "event_msg", "payload": { "type": "token_count", "info": {…},
  "rate_limits": { "limit_id": "codex", "limit_name": null,
    "primary":   { "used_percent": 28, "window_minutes": 10080, "resets_at": 1787016846 },
    "secondary": null,
    "credits":   { "has_credits": false, "unlimited": false, "balance": "0" },
    "plan_type": "plus", … } } }
```

- Field names match the plan (`used_percent`, `window_minutes`, `resets_at`); `resets_at` is
  epoch SECONDS.
- **The plan's "primary→session, secondary→weekly" mapping is wrong on this machine:** on the
  Plus plan `primary` carries `window_minutes: 10080` (7d) and `secondary` is `null`. The adapter
  classifies windows by `window_minutes` (300→session, 10080→weekly, 43200→monthly), position
  ignored — so the real chip here shows the weekly window (28%) with no 5h session window.
- `CODEX_HOME` on this machine is set by Orca
  (`C:\Users\Administrator\AppData\Roaming\orca\codex-runtime-home\home`); auth.json is present
  both there and at `~/.codex/auth.json` → the codex chip will appear (weekly 28%, source
  `session-file`).

### Other deltas from the doc

- **No `preload/index.d.ts` exists** in this repo — the renderer's `window.plano` typing is
  `src/renderer/types/global.d.ts` alone (it imports `PlanoApi` from `@shared/ipc/contracts`), so
  the new `usage`/`statusbar` members flow automatically; no second d.ts was needed.
- **No zen/focus mode exists** in the current shell (searched the renderer) — the bar's
  visibility is gated by Settings → Appearance → Show status bar (default ON), which is the only
  meaningful gate available.
- **opencode-go endpoint unverified** (no cookie on this machine to test against): implemented
  against `https://opencode.ai/api/usage` with a tolerant parse (`used_percent` | `usedPercent` |
  `used_percentage` | `utilization` | `percent`; 0..1 → ×100), 15 s timeout, one refresh per
  10 min, `unavailable` + `detail` on any failure; absent without a cookie. `Retry-After` from the
  response is honoured by the collector's backoff.
- Status-line hook throttle uses a `%TEMP%` stamp file (15 s per pane key) so the ~3×/s hook
  cadence during streaming collapses to one POST per 15 s; `X-Claude-Pane` identifies the pane.
- `usageFormat.ts` (ring dash, `2h47m` reset labels, weekday/time reset, GB formatting) is pure
  and typed; the probe covers the daemon-side parsing, which is where the field-name risk lived.
