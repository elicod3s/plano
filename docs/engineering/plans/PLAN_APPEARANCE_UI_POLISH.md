# PLANO Appearance UI Polish

## Status and purpose

User review of the current Appearance settings (8 themes, expanded accents, canvas background) found the section visually noisy and two controls non-functional:

1. **Film grain** — the toggle does nothing visible on the user's machine; the effect is imperceptible over the glass canvas.
2. **Interface density** — same: the pill changes nothing perceivable in the running app.

Additionally the **background preview tiles** use hardcoded blue-ish swatches (`#33406e`, `#101426`, …) that make the gradient previews read as "blue" regardless of the active theme — wrong signal next to a Monolith (charcoal) or Paper (white) theme.

## Decisions

- **Remove `grain` and `density`** from the persisted schema, their UI rows, and all runtime hooks:
  - `src/shared/domain/settings.ts` — drop `AppearanceSettings.grain` + `.density`, drop from `DEFAULT_SETTINGS.appearance`, keep `SETTINGS_VERSION` (deleting fields needs no migration; `mergeSettings` tolerates extra stored keys).
  - `src/renderer/theme/themes.ts` — `applyAppearance`: drop `dataset.density` and the three `--density-*` writes. PanelFrame already falls back to `var(--density-head, 34px)`.
  - `src/renderer/canvas/CanvasRoot.tsx` — drop the `grain` selector and the `plano-grain` class.
  - `src/renderer/styles/theme.css` — delete the `.plano-grain` rule.
  - Settings UI (`sections.tsx`) — delete the two rows and the `DensityPill` component + search-index entries.
- **Background previews derive from the ACTIVE theme**, never hardcoded blues:
  - Theme tile → `getTheme(active).swatch.bg`.
  - Solid tile → the user's chosen solid color when kind === 'solid', else the theme bg mixed with the theme accent (~12%).
  - Linear tile → 135° gradient of (theme bg + accent 35%) → theme bg.
  - Radial tile → radial-gradient of (theme bg + accent 30%) → theme bg.
- **Reorganize the Appearance section** into three labelled blocks with a clear order:
  1. **Theme** — 8 cards (existing ThemeGallery, slightly refined).
  2. **Accent** — swatches with better spacing + name/hex readout.
  3. **Canvas** — Background (picker + color/angle controls), Ambient glow (slider), Grid style, Grid size, Grid strength, Show minimap (moved here for coherence).
  4. **Reduce motion** — last row.

## Implementation split

- **Schema/backing (orchestrator):** `settings.ts`, `themes.ts`, `CanvasRoot.tsx`, `theme.css`.
- **UI (subagent, deepseek high):** `galleries.tsx` (derived previews + accent swatch refinement), `sections.tsx` (new hierarchy, remove rows, search index).

## Verification

- `npm run typecheck` + `npm run build` clean.
- Probe (isolated user-data): Settings → Appearance shows no Film grain / Interface density rows; 8 theme cards; 13 accent dots; Background picker previews match the active theme's swatch bg (not blue on Monolith); background kind switch still live-updates the canvas; search finds no film-grain entry.
- Keep the installed app untouched; test only via dev checkout.
