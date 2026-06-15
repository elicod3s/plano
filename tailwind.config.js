/**
 * PLANO — "Monolith Draft" design tokens (Tailwind layer).
 *
 * Canonical source of truth for raw values is src/renderer/styles/theme.css (CSS variables).
 * This config mirrors them so utilities like `bg-surface-2` / `text-secondary` exist.
 *
 * Palette is strictly MONOCHROME + one functional red. The neutral ramp is WARM-neutral
 * (Red >= Blue on every surface) on purpose: it keeps PLANO away from the cool/zinc
 * "blue-tinted dark SaaS" cohort and from the reference's blue identity.
 *
 * @type {import('tailwindcss').Config}
 */
module.exports = {
  content: ['./src/renderer/index.html', './src/renderer/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        canvas: '#0E0E0D',
        base: '#141414',
        surface: {
          1: '#1A1A19',
          2: '#201F1E',
          3: '#272625',
          4: '#2E2D2B',
          inset: '#0B0B0A',
        },
        text: {
          primary: '#FFFFFF',
          secondary: '#A1A1AA',
          tertiary: '#8C8B86',
          quaternary: '#6B6A65',
          onsolid: '#0E0E0D',
        },
        accent: {
          DEFAULT: '#FFFFFF',
          hover: '#EDEDEC',
          soft: 'rgba(255,255,255,0.08)',
          'soft-strong': 'rgba(255,255,255,0.14)',
        },
        destructive: {
          DEFAULT: '#EF4444',
          hover: '#F87171',
          soft: 'rgba(239,68,68,0.12)',
          border: 'rgba(248,113,113,0.40)',
        },
        status: { ready: '#A1A1AA', active: '#FFFFFF', error: '#EF4444' },
      },
      borderColor: {
        subtle: 'rgba(255,255,255,0.06)',
        DEFAULT: 'rgba(255,255,255,0.10)',
        strong: 'rgba(255,255,255,0.16)',
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
        'agent-breathe': {
          '0%,100%': { boxShadow: '0 0 0 1px rgba(255,255,255,0.12), 0 0 20px -6px rgba(255,255,255,0.04)' },
          '50%': { boxShadow: '0 0 0 1px rgba(255,255,255,0.22), 0 0 30px -4px rgba(255,255,255,0.10)' },
        },
        'status-pulse': { '0%,100%': { opacity: '1' }, '50%': { opacity: '0.4' } },
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
      },
      animation: {
        'agent-scan': 'agent-scan 700ms cubic-bezier(0.32,0.72,0,1) 1',
        'agent-breathe': 'agent-breathe 3.2s ease-in-out infinite',
        'status-pulse': 'status-pulse 1.6s ease-in-out infinite',
        'panel-in': 'panel-in 200ms cubic-bezier(0.32,0.72,0,1) 1',
        'palette-in': 'palette-in 220ms cubic-bezier(0.32,0.72,0,1) 1',
        'menu-in': 'menu-in 140ms cubic-bezier(0.32,0.72,0,1) 1',
        'snap-flash': 'snap-flash 320ms ease-out 1',
      },
    },
  },
  plugins: [],
}
