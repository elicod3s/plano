# PLANO — "Monolith Draft" Design System

A dark, **strictly monochrome** language (white + warm-neutral grays) with **one** functional hue (red, for destructive/armed states only). Personality is a **draftsman / CAD blueprint**: precise, rounded, instrument-like. Because color is removed as a tool, **type, texture, motion and weight** carry the identity.

Canonical token values live in [`src/renderer/styles/theme.css`](../../src/renderer/styles/theme.css); Tailwind mirrors them in `tailwind.config.js`.

## Non-negotiable rules

1. **Dark only.** It is the identity, not a mode.
2. **Monochrome + one red.** No green/lime/blue brand accent. White (`#FFFFFF`) is the only "accent".
3. **Warm-neutral ramp** (Red ≥ Blue on every surface). This deliberately avoids the cool/zinc "blue-tinted dark SaaS" look and the reference's blue identity.
4. **Rounded everywhere.** Panels 16px; overlays 20px; regions 24px; pills for toggles/search.
5. **100% English UI.**

## Anchor colors (from the user's "Monolith" reference)

| Role | Value |
|---|---|
| Primary / foreground | `#FFFFFF` |
| Secondary / muted | `#A1A1AA` |
| Base / neutral background | `~#141414` (the reference's `#141416` with its faint blue removed so it reads neutral, not cool) |
| Destructive (only hue) | `#EF4444` |

Full surface ramp, text levels, borders, status, focus and selection tokens are defined in `theme.css`.

## Distinctiveness signatures (what makes it *not* generic)

- **Blueprint substrate.** The canvas is a near-black field carrying a faint draftsman grid (minor dots @24px, major hairlines @96px). The grid is the one thing that scales with zoom — panels feel pinned to plan-paper, not floating in a void. Optional 1.5% monochrome film grain on the canvas only.
- **Datum handle.** Every panel header carries a signature 2×3 micro-dot grip (a surveyor's-benchmark motif) as the drag affordance.
- **Caliper focus ring.** A double-stroke "measurement bracket": implemented with `outline` + `outline-offset` so the gap shows the *real* surface on every background (fix for the hardcoded-gap bug). Destructive controls swap the stroke to red.
- **Agent-mode morph (no hue).** On AI-CLI detection: a 1px hairline sweeps the **full** panel height once, the left status rail thickens 1px→2px, a mono `AGENT` label types in, and a slow breathing ring pulses. Red appears **only** on the armed Auto-approve pill.
- **Measurement language.** Marquee shows a live W×H dimension label; align guides are dashed with end-caps; snap points flash a crosshair — CAD feedback throughout.

## Typography

- **Display / UI:** Space Grotesk (geometric grotesque — characterful, not Inter/Roboto). Uppercase micro-labels at `0.08em`, 11px.
- **Mono:** JetBrains Mono for terminals, code, and every numeric/technical readout (zoom %, dimensions, kbd chips, the `AGENT` label) — reinforces the blueprint/CAD voice.
- Bundled offline via Fontsource (`@fontsource-variable/space-grotesk`, `@fontsource/jetbrains-mono`).

> Both fonts are swappable; the identity is carried mainly by the monochrome + draftsman texture, so a more exotic display face can be dropped in later without reworking the system.

## Motion

Precision-instrument: fast, damped, never bouncy (springs reserved for canvas drag only). Durations: micro 120ms, standard 180ms, deliberate ~280ms. Settle curve `cubic-bezier(0.32,0.72,0,1)`. `prefers-reduced-motion` disables sweeps/pulses. Keyframes defined in `tailwind.config.js`.

## Critique fixes applied (from the adversarial review)

1. **Undertone:** re-based the ramp from cool zinc → warm-neutral (R ≥ B) to escape the blue/competitor look.
2. **Caliper ring:** uses `outline-offset` so the gap is the true surface on every background.
3. **Agent-scan:** animates `top: 0%→100%` (full panel height) instead of a fixed `2400%` of a 1px line.
4. **Contrast + consistency:** tertiary text bumped toward AA; grid pinned to 1px; primary foreground pinned to `#FFFFFF` (single source of truth, no `#FAFAFA` drift).
