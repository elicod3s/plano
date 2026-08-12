# PLAN — Usage popover (the hover panel behind the island)

Status: ready to execute · Date: 2026-08-12 · Depends on: `PLAN_STATUS_BAR_LIVE_USAGE.md`

## Why

The island answers "how much is left" at a glance. The moment a user actually cares — a budget is
running out, or they want to know which window is the one biting — they need the breakdown: every
window per provider, when each resets, and where the number came from. Today's popover is a
placeholder: one column of rows, monochrome logos, no meters, and it opens per chip so comparing
two providers means moving the pointer and losing the first one.

Reference studied: Orca's usage panel (grouped rows, per-window meters, footer actions). We take
its **information architecture** — one row per provider, the windows as small meters, reset time
on the row — and drop what is theirs: the boxed segmented control, the dense ASCII bars, the
"Manage Accounts…" ellipsis row. PLANO's version is one calm panel with real brand marks and
meters that stay quiet until a budget is at risk.

## What ships

ONE panel for the whole island (not one popover per chip), opened by hovering the island or
clicking it, anchored bottom-left above the island, ~300 px wide:

```
┌────────────────────────────────────────────┐
│ USAGE                              ⟳       │   header: label + refresh
├────────────────────────────────────────────┤
│ ✳ Claude            resets in 1h 45m       │   brand mark in ITS OWN colour
│   5h ▬▬▬▭▭▭▭▭▭  6%                         │   meters, one per window
│   wk ▬▬▬▬▬▭▭▭▭ 54%                         │
│   Fable ▬▬▬▬▬▬▬▭▭ 74%                      │
├────────────────────────────────────────────┤
│ ◎ Codex             resets in 5d 17h       │
│   wk ▬▬▭▭▭▭▭▭▭ 28%                         │
├────────────────────────────────────────────┤
│ ⇄ 3 ports · ▤ 207 MB · ⌁ 5 agents          │   machine row, single line
├────────────────────────────────────────────┤
│ Usage settings                          ›  │   the ONLY navigation
└────────────────────────────────────────────┘
```

Providers that cannot be read keep their row, with the reason in place of the meters (`no
credentials`, `waiting for the first statusLine event`) — never a 0 % meter.

## Design rules

- Panel: `surface-layer surface-layer--popover`, `rounded-[20px]`, `p-0`, hairline dividers
  (`border-glass`) between provider blocks. Enter with the existing `animate-menu-in`; no custom
  keyframes.
- **Brand marks in their real colour** (`AGENTS[kind].accent` via `AgentLogo`), 15 px, always —
  this is the established colour-accent precedent (agent panel tint, launcher chips), not new
  colour. The MEters stay monochrome until a budget is at risk; the logo is the only always-on
  colour in the panel, which is exactly what makes each row identifiable at a glance.
- Meter: 4 px track, `rounded-full`, `--surface-4` background, fill `--text-secondary`; at ≥80 %
  the fill switches to the provider accent, at ≥95 % to `#EF4444`. Width ~92 px so three meters
  align in a column and can be compared vertically.
- Window label (`5h`, `wk`, `Fable`) in JetBrains Mono 10 px `--text-quaternary`; the percentage
  in JetBrains Mono 11 px tabular, right-aligned so the digits line up across rows.
- Reset time on the provider row (`resets in 1h 45m`), 11 px `--text-tertiary` — one per row, not
  one per meter; the per-window reset lives in the row's title attribute.
- Machine row: ports · memory · agents on one line, 11 px, icons at 11 px `--text-quaternary`.
- Footer: exactly one row, `Usage settings`, opening Settings → Usage. Nothing else navigates —
  a status panel that teleports the user on a stray click is what we already removed once.
- No headings that restate the obvious, no helper copy (CLAUDE.md).

## Interaction

- Open on island hover with a 120 ms intent delay; close 180 ms after the pointer leaves both the
  island and the panel (the existing grace-timer pattern in `UsageChip`).
- Clicking the island pins the panel open (click again, `Esc`, or a click outside closes it) so a
  user can read it without holding the pointer still.
- `⟳` refreshes every provider through `usage:refresh`; it spins only while a refresh is in
  flight and is disabled for 3 s afterwards (no refresh-storm on the OAuth-ish providers).
- Keyboard: the island is focusable, `Enter`/`Space` pins the panel, `Esc` closes, `Tab` walks the
  rows. Reduced motion disables the entry animation and the spinner.

## Data

Everything is already in `ProviderUsage` (`session` / `weekly` / `premiumWeekly` + `premiumLabel`
/ `monthly`, `status`, `source`, `detail`, `updatedAt`) and `useUsageStore`'s aux (ports, memory,
agents). No new IPC. `usageFormat.ts` gains `meterFill(pct)` (pure) so the meter and the island
ring cannot disagree about what "at risk" means.

## Files

- new: `src/renderer/chrome/statusbar/UsagePanel.tsx` (the panel), `UsageMeter.tsx` (track + fill)
- changed: `StatusBar.tsx` (owns the open state, renders ONE panel), `UsageChip.tsx` (drops its
  own popover; keeps the gauge + numbers and a `title`), `usageFormat.ts` (`meterFill`)
- unchanged: every adapter, the store, the IPC surface

## Every provider on this machine must appear

Two are silently missing today and both have real credentials on disk. "Absent" must mean *not
installed*, never *we did not implement it*:

- **Grok** — `src/main/daemon/usage/grok.ts` is a stub that returns `null`. Credentials live in
  `~/.grok/auth.json`, keyed `"https://auth.x.ai::<uuid>"` with an OAuth JWT under `key`. The CLI
  itself has a `/usage` command (it appears in `~/.grok/slash-mru.json`), so the endpoint is in
  its bundle: grep `~/.grok/bin` and `~/.grok/bundled` for `usage`, `rate_limit`, `quota`,
  `x.ai/api` — the same "read the shipped binary instead of guessing" move that settled the
  Claude schema. Map what it returns onto the existing windows (`session`/`weekly`/`monthly`).
- **OpenCode Go** — the adapter currently demands a pasted cookie and POSTs to a GUESSED URL
  (`https://opencode.ai/api/usage`). There IS an auth file: `~/.local/share/opencode/auth.json`
  (plus `opencode.db`). Prefer it over the cookie; keep the cookie only as a fallback for
  web-only sessions. Verify the real endpoint before writing code — Orca reaches opencode.ai
  through its SST/TanStack **server-fn** protocol (`https://opencode.ai/_server`, a workspaces
  call first, then usage), not a REST path, so `/api/usage` is very likely wrong.

Rule for the row: credentials present but quota unreadable → the row EXISTS with the reason in
place of its meters. Credentials absent → no row at all. Never a 0 % meter for either case.

## Logo rendering

- The brand mark must be **optically centred** inside its ring: mark and ring share one box
  (`relative` wrapper, ring `absolute inset-0`, mark centred by flex), and the mark is sized to
  ~48 % of the ring diameter so different glyph aspect ratios (OpenAI's circle vs Claude's
  starburst vs the Grok slash) all read as the same weight.
- Every provider resolves to a REAL mark. `grok` currently maps to `generic-agent` (a bot glyph):
  add a proper `GrokLogo.tsx` next to `KiroLogo`/`OmpLogo` (its own SVG, `currentColor`, tintable)
  and register it in `AgentLogo`'s `BRAND` map, so no provider in the panel shows a placeholder.
- Marks render in their own brand colour (the accent), greying out only when the provider has
  nothing to report. Verify in BOTH themes — a white-ish mark (Grok) needs a visible colour on
  the Light theme.

## Acceptance criteria

1. `npm run typecheck` clean.
2. One panel for the whole island; hovering two different chips never opens two panels.
3. Claude renders three meters (5h / wk / Fable) with the same numbers the island shows, and the
   Fable meter turns accent at ≥80 % — verified against a synthetic payload through the installed
   hook (the `usage-probe.mjs` path), not by eyeballing live data.
4. Brand marks render in their own colours in both themes, optically centred in their rings, and
   no provider falls back to the generic bot glyph.
5. Grok and OpenCode Go BOTH appear on this machine (their credentials exist) — either with real
   numbers or with a row stating why they cannot be read. Print the resulting snapshot in the
   probe output so the reviewer sees which providers made it.
5. Clicking anywhere in the panel except `Usage settings` does not navigate.
6. With `reduceMotion` on, nothing animates.
