/**
 * PLANO — "Frost Glass" design tokens (Tailwind layer).
 *
 * Canonical source of truth for raw values is src/renderer/styles/theme.css (CSS variables).
 * These utilities reference those variables directly (`var(--…)`) rather than mirroring the
 * hex, so a runtime theme swap (Settings → Appearance) re-tints every utility class for free.
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
        glass: {
          DEFAULT: 'var(--glass)',
          strong: 'var(--glass-strong)',
          hover: 'var(--glass-hover)',
          active: 'var(--glass-active)',
          sheen: 'var(--glass-sheen)',
          panel: 'var(--glass-panel)',
          bar: 'var(--glass-bar)',
        },
        inset: {
          DEFAULT: 'var(--inset-soft)',
          deep: 'var(--inset-deep)',
        },
        text: {
          primary: 'var(--text-primary)',
          secondary: 'var(--text-secondary)',
          tertiary: 'var(--text-tertiary)',
          quaternary: 'var(--text-quaternary)',
          muted: 'var(--text-muted)',
          onsolid: 'var(--text-on-solid)',
          'on-accent': 'var(--text-on-accent)',
          1: 'var(--text-1)',
          2: 'var(--text-2)',
          3: 'var(--text-3)',
          4: 'var(--text-4)',
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
        brand: {
          claude: 'var(--claude)',
          codex: 'var(--codex)',
          success: 'var(--success)',
          amber: 'var(--amber)',
          info: 'var(--info)',
        },
      },
      borderColor: {
        subtle: 'var(--border-subtle)',
        DEFAULT: 'var(--border-default)',
        strong: 'var(--border-strong)',
        glass: 'var(--border-glass)',
        'glass-strong': 'var(--border-glass-strong)',
        'glass-hover': 'var(--border-glass-hover)',
      },
      fontFamily: {
        display: ['"Instrument Sans Variable"', '"Instrument Sans"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        sans: ['"Instrument Sans Variable"', '"Instrument Sans"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        // `font-mono` in the CHROME means data: counts, paths, percentages, durations.
        mono: ['"Geist Mono Variable"', '"Geist Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
        // The terminal/editor stack stays JetBrains Mono — picked for glyph coverage, not taste.
        term: ['"JetBrains Mono"', '"PLANO Term Symbols"', '"PLANO Term Dingbats"', '"Cascadia Mono"', 'ui-monospace', 'monospace'],
      },
      borderRadius: {
        xs: '6px',
        sm: '8px',
        md: '12px',
        lg: '16px',
        xl: '20px',
        '2xl': '24px',
        '3xl': '26px',
        '4xl': '28px',
        pill: '9999px',
      },
      boxShadow: {
        panel:
          '0 1px 0 0 rgba(255,255,255,0.05) inset, 0 4px 14px -4px rgba(0,0,0,0.45), 0 10px 16px -8px rgba(0,0,0,0.33), 0 24px 56px -24px rgba(0,0,0,0.73)',
        'panel-focus':
          '0 1px 0 0 rgba(255,255,255,0.07) inset, 0 6px 20px -6px rgba(0,0,0,0.5), 0 14px 24px -10px rgba(0,0,0,0.4), 0 32px 72px -28px rgba(0,0,0,0.8)',
        overlay: '0 10px 16px -8px rgba(0,0,0,0.33), 0 28px 64px rgba(0,0,0,0.6)',
        popover: '0 10px 16px -8px rgba(0,0,0,0.33), 0 24px 48px -8px rgba(0,0,0,0.5)',
        dock: '0 1px 0 0 rgba(255,255,255,0.05) inset, 0 8px 14px -6px rgba(0,0,0,0.33), 0 10px 28px rgba(0,0,0,0.35)',
        'agent-ring': '0 0 0 1px rgba(255,255,255,0.16), 0 0 28px -4px rgba(255,255,255,0.10)',
      },
      letterSpacing: { tightui: '-0.01em', label: '0.08em' },
      transitionTimingFunction: {
        settle: 'cubic-bezier(0.32,0.72,0,1)',
        exit: 'cubic-bezier(0.4,0,1,1)',
      },
      keyframes: {
        'agent-scan': {
          '0%': { top: '0%', opacity: '0' },
          '12%': { opacity: '1' },
          '100%': { top: '100%', opacity: '0' },
        },
        'agent-breathe': {
          '0%,100%': { opacity: '0.35' },
          '50%': { opacity: '0.9' },
        },
        'status-pulse': { '0%,100%': { opacity: '1' }, '50%': { opacity: '0.4' } },
        // The Music-style activity meter: three bars breathing out of phase. Apple's own answer
        // to "something is running here" — motion carries the meaning, so no badge is needed.
        'eq-bar': {
          '0%,100%': { transform: 'scaleY(0.35)' },
          '50%': { transform: 'scaleY(1)' },
        },
        'progress-slide': {
          '0%': { transform: 'translateX(-100%)' },
          '100%': { transform: 'translateX(400%)' },
        },
        // panel-in / panel-out: the WHOLE visual shell (material + content together) enters
        // and exits with a soft fade + gentle scale — no squash, no per-child motion, no
        // blur. Sits on the shell so border, shadow and content share the animation.
        // Deliberately the pre-glass values (scale(0.985) entry, NO overshoot): any scale > 1
        // on a shell containing CodeMirror re-rasterizes the editor text during the entry.
        'panel-in': {
          '0%': { transform: 'scale(0.985)', opacity: '0' },
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
        'panel-out': {
          '0%': { transform: 'scale(1) translateY(0)', opacity: '1' },
          '100%': { transform: 'scale(0.985) translateY(2px)', opacity: '0' },
        },
        'region-out': {
          '0%': { opacity: '1' },
          '100%': { opacity: '0' },
        },
      },
      animation: {
        'eq-bar': 'eq-bar 900ms ease-in-out infinite',
        'agent-scan': 'agent-scan 700ms cubic-bezier(0.32,0.72,0,1) 1 forwards',
        // Finite, NOT infinite: an unending opacity loop on a full-panel inset-0 layer forces
        // constant recomposition under the cursor, and Windows downgrades the mouse cursor to
        // software rendering while the page keeps repainting — a blurry cursor in motion. A
        // short pulse at detection keeps the effect; afterwards the ring rests static (the
        // shell border already carries the agent accent).
        'agent-breathe': 'agent-breathe 3.2s ease-in-out 3',
        'status-pulse': 'status-pulse 1.6s ease-in-out infinite',
        'progress-slide': 'progress-slide 1.1s cubic-bezier(0.4,0,0.6,1) infinite',
        // Pre-glass durations/curves: the entry that the user verified as instant and crisp.
        'panel-in': 'panel-in 200ms cubic-bezier(0.32,0.72,0,1) 1',
        'palette-in': 'palette-in 220ms cubic-bezier(0.32,0.72,0,1) 1',
        'menu-in': 'menu-in 140ms cubic-bezier(0.32,0.72,0,1) 1',
        'snap-flash': 'snap-flash 320ms ease-out 1',
        'panel-out': 'panel-out 260ms cubic-bezier(0.4,0,1,1) forwards',
        'region-out': 'region-out 220ms ease-out forwards',
      },
    },
  },
  plugins: [],
}
