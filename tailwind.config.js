/**
 * PLANO — "Monolith Draft" design tokens (Tailwind layer).
 *
 * Canonical source of truth for raw values is src/renderer/styles/theme.css (CSS variables).
 * These utilities reference those variables directly (`var(--…)`) rather than mirroring the
 * hex, so a runtime theme swap (Settings → Appearance) re-tints every utility class for free.
 *
 * The DEFAULT palette is the locked MONOCHROME warm-neutral ramp + one functional red.
 * User-selected themes (incl. opt-in colored ones) override the :root variables at runtime;
 * see src/renderer/theme/themes.ts and CLAUDE.md → Hard design rules.
 *
 * NOTE: because these are `var()` colors, the `/opacity` modifier (e.g. `bg-accent/40`)
 * cannot inject an alpha channel — use a `color-mix(...)` inline style for translucency.
 *
 * @type {import('tailwindcss').Config}
 */
module.exports = {
  content: ['./src/renderer/index.html', './src/renderer/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        canvas: 'var(--bg-canvas)',
        base: 'var(--bg-base)',
        surface: {
          1: 'var(--surface-1)',
          2: 'var(--surface-2)',
          3: 'var(--surface-3)',
          4: 'var(--surface-4)',
          inset: 'var(--surface-inset)',
        },
        text: {
          primary: 'var(--text-primary)',
          secondary: 'var(--text-secondary)',
          tertiary: 'var(--text-tertiary)',
          quaternary: 'var(--text-quaternary)',
          onsolid: 'var(--text-on-solid)',
        },
        accent: {
          DEFAULT: 'var(--accent-primary)',
          hover: 'var(--accent-primary-hover)',
          soft: 'var(--accent-soft)',
          'soft-strong': 'var(--accent-soft-strong)',
        },
        destructive: {
          DEFAULT: 'var(--destructive)',
          hover: 'var(--destructive-hover)',
          soft: 'var(--destructive-soft)',
          border: 'var(--destructive-border)',
        },
        status: {
          ready: 'var(--status-ready)',
          active: 'var(--status-active)',
          error: 'var(--status-error)',
        },
      },
      borderColor: {
        subtle: 'var(--border-subtle)',
        DEFAULT: 'var(--border-default)',
        strong: 'var(--border-strong)',
      },
      fontFamily: {
        display: ['"Space Grotesk Variable"', '"Space Grotesk"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        sans: ['"Space Grotesk Variable"', '"Space Grotesk"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      borderRadius: {
        xs: '6px',
        sm: '8px',
        md: '12px',
        lg: '16px',
        xl: '20px',
        '2xl': '24px',
        pill: '9999px',
      },
      boxShadow: {
        panel:
          '0 1px 0 0 rgba(255,255,255,0.04) inset, 0 8px 24px -8px rgba(0,0,0,0.55), 0 2px 6px -2px rgba(0,0,0,0.45)',
        'panel-focus':
          '0 1px 0 0 rgba(255,255,255,0.06) inset, 0 16px 48px -12px rgba(0,0,0,0.65), 0 4px 12px -4px rgba(0,0,0,0.5)',
        overlay: '0 24px 64px -16px rgba(0,0,0,0.72), 0 8px 24px -8px rgba(0,0,0,0.55)',
        popover: '0 12px 32px -8px rgba(0,0,0,0.6), 0 2px 8px -2px rgba(0,0,0,0.5)',
        dock: '0 1px 0 0 rgba(255,255,255,0.05) inset, 0 16px 40px -12px rgba(0,0,0,0.7)',
        'agent-ring': '0 0 0 1px rgba(255,255,255,0.16), 0 0 28px -4px rgba(255,255,255,0.10)',
      },
      letterSpacing: { tightui: '-0.01em', label: '0.08em' },
      transitionTimingFunction: {
        settle: 'cubic-bezier(0.32,0.72,0,1)',
        exit: 'cubic-bezier(0.4,0,1,1)',
      },
      keyframes: {
        // agent-scan: a hairline absolutely positioned in the panel; we animate `top`
        // 0% -> 100% so it sweeps the FULL panel height (critique fix — no fixed % of 1px).
        'agent-scan': {
          '0%': { top: '0%', opacity: '0' },
          '12%': { opacity: '1' },
          '100%': { top: '100%', opacity: '0' },
        },
        // Inset (inside the panel) so the agent glow is clipped by overflow-hidden and can
        // never paint outside the panel — kills the white ghost line left when dragging.
        // Keeps the panel's drop shadow for depth.
        // Inset glow tinted with the detected agent's brand color (--agent-accent,
        // falls back to white). color-mix applies the alpha so any accent works.
        'agent-breathe': {
          '0%,100%': {
            boxShadow:
              'var(--shadow-panel-focus), inset 0 0 0 1px color-mix(in srgb, var(--agent-accent, #fff) 40%, transparent)',
          },
          '50%': {
            boxShadow:
              'var(--shadow-panel-focus), inset 0 0 0 1.5px color-mix(in srgb, var(--agent-accent, #fff) 75%, transparent)',
          },
        },
        'status-pulse': { '0%,100%': { opacity: '1' }, '50%': { opacity: '0.4' } },
        // Indeterminate progress sweep for the browser panel's loading hairline — a short
        // segment slides across the full toolbar width while a page loads.
        'progress-slide': {
          '0%': { transform: 'translateX(-100%)' },
          '100%': { transform: 'translateX(400%)' },
        },
        'panel-in': {
          '0%': { transform: 'scale(0.96)', opacity: '0' },
          '100%': { transform: 'scale(1)', opacity: '1' },
        },
        'palette-in': {
          '0%': { transform: 'translateY(8px) scale(0.98)', opacity: '0' },
          '100%': { transform: 'translateY(0) scale(1)', opacity: '1' },
        },
        'menu-in': {
          '0%': { transform: 'scale(0.96)', opacity: '0' },
          '100%': { transform: 'scale(1)', opacity: '1' },
        },
        'snap-flash': {
          '0%': { transform: 'scale(0.6)', opacity: '0' },
          '40%': { opacity: '1' },
          '100%': { transform: 'scale(1)', opacity: '0' },
        },
        // Canvas panels only. Driven from PanelFrame's inner (visual) wrapper, never the
        // outer positioning box — so these transforms compose around the panel's own center
        // instead of fighting the world-space translate3d. Chrome overlays never use these.
        //
        // panel-wiggle: a subtle "alive" oscillation while the panel is being dragged. Tiny
        // amplitude on purpose (~0.5deg) so stopping mid-tilt reads as imperceptible.
        'panel-wiggle': {
          '0%': { transform: 'rotate(-0.55deg)' },
          '50%': { transform: 'rotate(0.55deg)' },
          '100%': { transform: 'rotate(-0.55deg)' },
        },
        // panel-out: our own take on the genie/magic-lamp collapse — the panel squashes
        // toward a thin line, sinks a touch, blurs and fades as it is "sucked" away.
        'panel-out': {
          '0%': { transform: 'scale(1) translateY(0)', opacity: '1', filter: 'blur(0px)' },
          '45%': { transform: 'scale(0.94, 0.9) translateY(-1%)', opacity: '0.8', filter: 'blur(0px)' },
          '100%': { transform: 'scale(0.46, 0.04) translateY(28%)', opacity: '0', filter: 'blur(3px)' },
        },
        // region-out: regions are big "ground" zones, so they leave with a plain fade+blur
        // (no collapse). Only opacity/filter animate, never transform, so the region's
        // world-space positioning translate3d is left untouched.
        'region-out': {
          '0%': { opacity: '1', filter: 'blur(0px)' },
          '100%': { opacity: '0', filter: 'blur(2px)' },
        },
      },
      animation: {
        'agent-scan': 'agent-scan 700ms cubic-bezier(0.32,0.72,0,1) 1',
        'agent-breathe': 'agent-breathe 3.2s ease-in-out infinite',
        'status-pulse': 'status-pulse 1.6s ease-in-out infinite',
        'progress-slide': 'progress-slide 1.1s cubic-bezier(0.4,0,0.6,1) infinite',
        'panel-in': 'panel-in 200ms cubic-bezier(0.32,0.72,0,1) 1',
        'palette-in': 'palette-in 220ms cubic-bezier(0.32,0.72,0,1) 1',
        'menu-in': 'menu-in 140ms cubic-bezier(0.32,0.72,0,1) 1',
        'snap-flash': 'snap-flash 320ms ease-out 1',
        'panel-wiggle': 'panel-wiggle 340ms ease-in-out infinite',
        'panel-out': 'panel-out 260ms cubic-bezier(0.4,0,1,1) forwards',
        'region-out': 'region-out 220ms ease-out forwards',
      },
    },
  },
  plugins: [],
}
