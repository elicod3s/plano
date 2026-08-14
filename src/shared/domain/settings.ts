/**
 * App-global user settings. Persisted (atomically) to <userData>/settings.json by the
 * main process and exposed to the renderer over IPC. This module is environment-agnostic
 * (no DOM / node / electron) — it only declares the shape, the defaults, and a tolerant
 * merge used when hydrating a possibly-older or partial on-disk document.
 *
 * Grouped by the Settings UI sections so a section maps to exactly one key here.
 */

import type { UsageProviderId } from './usage'

export const SETTINGS_VERSION = 12

// ── enums (kept as string unions so they round-trip through JSON untouched) ──
export type ThemeId =
  | 'monolith' //   default — the original PLANO charcoal (dark, neutral, no warm cast)
  | 'indigo' //     deep indigo glass, periwinkle accent
  | 'orange' //     warm ember glass, soft-orange accent
  | 'tokyo' //      night-neon glass, pink accent
  | 'sakura' //     plum glass, soft pink accent
  | 'pearl' //      warm light glass, ink accent
  | 'mist' //       cool light glass, slate ink
  | 'paper' //      pure-white glass, neutral ink

export type AccentId = string // hex, e.g. "#FFFFFF" (white = default — defers to the theme accent)

export type GridStyle = 'dots' | 'lines' | 'none'

/** Grid cell spacing preset — scales the minor/major drafting grid. */
export type GridSize = 'fine' | 'standard' | 'coarse'

/** What the canvas substrate paints behind everything. */
export type CanvasBackgroundKind = 'theme' | 'solid' | 'linear' | 'radial'
export interface CanvasBackground {
  kind: CanvasBackgroundKind
  /** solid → colors[0]; gradients → colors[0] → colors[1]. Ignored for 'theme'. */
  colors: [string, string]
  /** linear-gradient angle in degrees (0–360). Ignored unless kind === 'linear'. */
  angle: number
}

export type SearchEngineId = 'google' | 'bing' | 'duckduckgo' | 'brave'

/** How PLANO reacts when a URL appears in terminal output (forward-looking). */
export type TerminalUrlAction = 'ask' | 'plano' | 'external' | 'ignore'

/** Preferred shell for new terminals. 'auto' lets main pick the platform default. */
export type ShellChoice = 'auto' | 'powershell' | 'pwsh' | 'cmd' | 'bash' | 'zsh' | 'fish'

export type CursorStyle = 'bar' | 'block' | 'underline'

export type TerminalThemeId = 'monolith' | 'midnight' | 'amber' | 'matrix' | 'paper' | 'campbell'

// ── per-section shapes ──
export interface GeneralSettings {
  /** Reopen the most-recent workspace on launch. */
  restoreLastWorkspace: boolean
  /** Reopen agent conversations (Claude Code, Codex, Cursor, …) in restored terminals when a
   *  workspace reopens. */
  restoreAgentSessions: boolean
  /** Drop a Files panel onto the canvas when a workspace opens with none. */
  showFilesOnLaunch: boolean
  /** Confirm before the in-app close button quits PLANO. */
  warnBeforeQuit: boolean
  /** Confirm before closing a terminal panel whose process is still alive. */
  confirmClosePanelWithProcess: boolean
  /** Play a soft chime when a detected agent (any model) finishes its turn. */
  agentDoneSound: boolean
  /** v4 awareness: in-app toast when a backgrounded agent finishes or is awaiting input. */
  agentDoneNotify: boolean
}

export interface AppearanceSettings {
  theme: ThemeId
  /** Accent hex. "#FFFFFF" = default (auto-flips to the theme accent / ink on light). */
  accent: AccentId
  gridStyle: GridStyle
  /** Canvas grid strength, 0..1. */
  gridOpacity: number
  /** Force reduced motion regardless of the OS setting. */
  reduceMotion: boolean
  /** The canvas substrate: theme color, a solid, or a gradient. */
  canvasBackground: CanvasBackground
  /** Ambient accent halo over the canvas, 0–40 (% alpha of --accent-primary). */
  canvasGlow: number
  /** Canvas drafting-grid spacing. */
  gridSize: GridSize
}

export interface EditorSettings {
  fontSize: number
  tabSize: number
  wordWrap: boolean
  lineNumbers: boolean
}

export interface TerminalSettings {
  shell: ShellChoice
  /** Explicit shell executable path; overrides `shell` when set. */
  shellPath: string
  /** Empty string → use the bundled JetBrains Mono stack. */
  fontFamily: string
  /** 0 → use the default (13). */
  fontSize: number
  lineHeight: number
  cursorStyle: CursorStyle
  cursorBlink: boolean
  scrollback: number
  /** Default terminal color theme for new terminals (per-terminal override wins). */
  theme: TerminalThemeId
  /** Copy the selection to the clipboard the moment it is made. */
  copyOnSelect: boolean
  /**
   * Warp-style predictive history: as you type, the best-matching past command is
   * ghosted inline; Tab (or →) accepts it. Backed by the shell's own history engine
   * (PowerShell/PSReadLine ≥ 2.1), so it never interferes with running agents/TUIs and
   * persists to disk natively. No effect on shells without an inline-prediction engine.
   */
  predictiveHistory: boolean
  /** Detect links / device codes / paths in output and offer one-click actions (planned). */
  smartActions: boolean
  /** Pause silent, offscreen terminals to reclaim memory (planned). */
  autoSuspendIdle: boolean
  /**
   * Keep every terminal (and the agents running inside it) alive in the background Agent Host when
   * PLANO closes, so reopening lands exactly where you left it. Turning this off restores the old
   * behavior: quitting kills all sessions.
   */
  keepAgentsOnQuit: boolean
}

export interface CanvasSettings {
  snapToGrid: boolean
  showMinimap: boolean
  /** Wheel-zoom speed multiplier (1 = default). */
  zoomSensitivity: number
  /** Debounced autosave of the workspace on change. */
  autosave: boolean
}

export interface BrowserSettings {
  homepage: string
  searchEngine: SearchEngineId
  terminalUrlAction: TerminalUrlAction
}

export interface PrivacySettings {
  /** PLANO ships no telemetry; the switch is here so the stance is explicit and auditable. */
  telemetry: boolean
  /** Persist terminal scrollback across reopen (planned). */
  saveTerminalHistory: boolean
}

export interface AdvancedSettings {
  /** GPU compositing for webviews/canvas (applied on next launch). */
  hardwareAcceleration: boolean
}

/** Agent Mesh — cross-workspace agent context + control (main-owned). */
export interface AgentMeshSettings {
  /**
   * Persist redacted agent context (tails + prompts) to <workspace>/.plano/context/ so a
   * restart can re-search it. Opt-in by design; redaction runs before anything touches disk.
   */
  contextPersistence: boolean
  /** Cap for the persisted context index (rotation keeps the newest slice). */
  maxPersistBytes: number
  /**
   * Let agents message and spawn each other without asking first. ON by default: the mesh is
   * loopback-only, every write is attributed to a token-identified agent and lands visibly in a
   * terminal the user can see, so a prompt before each new workspace was friction without a
   * decision behind it. Turn it OFF to get the per-workspace confirmation back.
   */
  allowAgentWrites: boolean
}

/** Optional language hint for the (multilingual) voice model. 'auto' lets it detect es/en/… itself. */
export type VoiceLanguage = 'auto' | 'es' | 'en'

/** Status bar (plan PLAN_STATUS_BAR_LIVE_USAGE): show/hide + per-chip visibility + the
 *  OpenCode Go cookie. The cookie is stored here (masked in the UI, never logged) and read by
 *  the Agent Host's opencode-go adapter; it is only ever sent to https://opencode.ai. */
export interface UsageSettings {
  /** Master switch for the bottom status bar. */
  showStatusBar: boolean
  /** Per-chip visibility. Providers additionally self-gate: no credentials → no chip. */
  chips: {
    ports: boolean
    resources: boolean
    agents: boolean
    providers: Record<UsageProviderId, boolean>
  }
  /** The user's opencode.ai `auth` cookie (bare `Fe26.2**…` token or full cookie header). */
  opencodeCookie: string
}

export interface VoiceSettings {
  /** Master switch for the global voice orchestrator "Odla" (overlay aura + push-to-talk key). */
  enabled: boolean
  /** Hold-to-talk combo, parsed by the keymap (e.g. "Ctrl+Shift+Space"). Held = listening. */
  pushToTalkKey: string
  /**
   * Auto-send: run the command the moment you STOP talking (end-of-speech detection), without needing
   * to release the key — feels instant + hands-free. Releasing the key still fires immediately. When
   * off, it waits for release / a second tap.
   */
  autoSend: boolean
  /**
   * Which microphone to capture from. '' = auto (prefer a real physical mic, avoiding virtual/router
   * devices like SteelSeries Sonar / VoiceMeeter / Stereo Mix, whose AI noise-gates can silence
   * speech). Otherwise a specific mediaDevices deviceId chosen in Settings → Odla.
   */
  inputDeviceId: string
  /** Spoken-command language hint; the bundled Parakeet model is multilingual (es + en + …). */
  language: VoiceLanguage
  /** Speak short confirmations back via the OS speech synthesizer. */
  speakResponses: boolean
  /**
   * Gemini is the primary intent "engine" — it turns free speech into actions, so Odla can open and
   * move anything you describe. When it's off / unreachable / slow, the built-in local fuzzy grammar
   * takes over (so voice never breaks). The key lives here and the call is made from the main process.
   */
  gemini: {
    enabled: boolean
    apiKey: string
    /** Cheapest + fastest current model; flash-lite is plenty for command parsing. */
    model: string
  }
  /**
   * OPTIONAL extra free-form fallback (an OpenAI-compatible endpoint, e.g. a local Ollama). Off by
   * default; the fuzzy grammar is the real fallback when Gemini is unavailable.
   */
  llmFallback: {
    enabled: boolean
    /** OpenAI-compatible base URL; defaults to a local Ollama so nothing leaves the machine. */
    baseUrl: string
    model: string
  }
}

export interface PlanoSettings {
  version: number
  general: GeneralSettings
  appearance: AppearanceSettings
  editor: EditorSettings
  terminal: TerminalSettings
  canvas: CanvasSettings
  browser: BrowserSettings
  privacy: PrivacySettings
  advanced: AdvancedSettings
  agentMesh: AgentMeshSettings
  voice: VoiceSettings
  usage: UsageSettings
}

export const DEFAULT_SETTINGS: PlanoSettings = {
  version: SETTINGS_VERSION,
  general: {
    restoreLastWorkspace: true,
    restoreAgentSessions: true,
    showFilesOnLaunch: false,
    warnBeforeQuit: false,
    confirmClosePanelWithProcess: true,
    agentDoneSound: true,
    agentDoneNotify: true,
  },
  appearance: {
    theme: 'monolith',
    accent: '#FFFFFF',
    // A clean theme-colored field by default. The optional drafting grid remains available in
    // Appearance, but new workspaces no longer show rectangles/lines around terminal panels.
    gridStyle: 'none',
    gridOpacity: 1,
    reduceMotion: false,
    // Theme-colored substrate by default; colors only matter once the user picks solid/gradient.
    canvasBackground: { kind: 'theme', colors: ['#141414', '#1d1d2b'], angle: 135 },
    canvasGlow: 0,
    gridSize: 'standard',
  },
  editor: {
    fontSize: 13,
    tabSize: 2,
    wordWrap: true,
    lineNumbers: true,
  },
  terminal: {
    shell: 'auto',
    shellPath: '',
    fontFamily: '',
    fontSize: 0,
    // 1.4 = the shipped pre-glass default — the row rhythm the user
    // verified as pixel-perfect. The v9 experiment at 1.0 packed rows so tight that CLI output
    // looked clipped/joined and the terminal read as "cut off" on the right; 1.4 restores the
    // comfortable row rhythm of the original. The Settings slider still caps manual values at 1.2
    // for users who prefer tighter rows.
    lineHeight: 1.4,
    cursorStyle: 'bar',
    cursorBlink: true,
    scrollback: 5000,
    // Default terminal palette = the classic Windows Terminal "Campbell" scheme, so CLI output
    // (git, npm, PSReadLine, …) renders with the same colors the user sees in their OS terminal.
    theme: 'campbell',
    copyOnSelect: false,
    predictiveHistory: true,
    smartActions: true,
    // Hibernate the renderer-side terminals of a workspace you switch away from (freeing their
    // WebGL contexts + continuous IPC/parsing) while the PTYs keep running in main; returning
    // re-attaches and replays main's bounded buffer. The fix for many-open-workspaces memory
    // pressure. A safety valve — turn off to restore the original "every visited terminal stays
    // live forever" behaviour if a workspace ever feels wrong on return.
    autoSuspendIdle: true,
    // Terminals live in a detached Agent Host, so closing PLANO never
    // closes the agents you left open. Off = quitting kills everything (old behaviour).
    keepAgentsOnQuit: true,
  },
  canvas: {
    snapToGrid: true,
    // Hidden by default — revealed on demand from the bottom-right ViewControls map toggle.
    showMinimap: false,
    zoomSensitivity: 1,
    autosave: true,
  },
  browser: {
    homepage: 'about:blank',
    searchEngine: 'google',
    // Local dev URLs (localhost:PORT) printed by a server open inside PLANO automatically.
    terminalUrlAction: 'plano',
  },
  privacy: {
    telemetry: false,
    saveTerminalHistory: true,
  },
  advanced: {
    hardwareAcceleration: true,
  },
  agentMesh: {
    // Context never leaves the app by default. Turning this on writes REDACTED context to the
    // workspace's .plano folder (see AgentMeshSettings.contextPersistence) for restart-safe search.
    contextPersistence: false,
    maxPersistBytes: 512 * 1024,
    allowAgentWrites: true,
  },
  voice: {
    enabled: true,
    pushToTalkKey: 'Ctrl+Shift+Space',
    autoSend: true,
    inputDeviceId: '',
    language: 'auto',
    speakResponses: false,
    gemini: {
      enabled: true,
      // Never hardcode a key here — it would ship inside the installer's asar. The key lives only in
      // the user's local settings.json (userData) / the Settings → Odla field. Empty = Gemini stays
      // dormant and the local fuzzy engine handles everything (still fully functional).
      apiKey: '',
      model: 'gemini-3.1-flash-lite',
    },
    llmFallback: {
      enabled: false,
      baseUrl: 'http://localhost:11434/v1',
      model: 'llama3.1',
    },
  },
  usage: {
    showStatusBar: true,
    chips: {
      ports: true,
      resources: true,
      agents: true,
      providers: {
        claude: true,
        codex: true,
        gemini: true,
        'opencode-go': true,
        grok: true,
        omp: true,
      },
    },
    opencodeCookie: '',
  },
}

/**
 * Coerce an unknown on-disk value into a complete PlanoSettings. Each group is merged
 * over its defaults (one level deep), so a document missing a field — or a whole group
 * added in a later version — is filled in rather than rejected. Unknown extra keys are
 * dropped by the explicit per-group spread.
 */
export function mergeSettings(stored: unknown): PlanoSettings {
  const s = (stored ?? {}) as Partial<PlanoSettings>
  const storedVersion = typeof s.version === 'number' ? s.version : 0
  const group = <K extends keyof PlanoSettings>(key: K): PlanoSettings[K] => ({
    ...(DEFAULT_SETTINGS[key] as object),
    ...((s[key] as object | undefined) ?? {}),
  }) as PlanoSettings[K]
  const merged: PlanoSettings = {
    version: SETTINGS_VERSION,
    general: group('general'),
    appearance: group('appearance'),
    editor: group('editor'),
    terminal: group('terminal'),
    canvas: group('canvas'),
    browser: group('browser'),
    privacy: group('privacy'),
    advanced: group('advanced'),
    agentMesh: group('agentMesh'),
    voice: group('voice'),
    usage: group('usage'),
  }
  // v12: the status-bar group is nested (chips.providers is a per-provider record) — a half-written
  // stored value must not leak partial fields. Rebuild `chips` over the defaults, one level deep.
  const usageDefaults = DEFAULT_SETTINGS.usage
  const storedUsage = (s.usage ?? {}) as Partial<UsageSettings>
  merged.usage = {
    ...usageDefaults,
    ...storedUsage,
    chips: {
      ...usageDefaults.chips,
      ...(storedUsage.chips ?? {}),
      providers: {
        ...usageDefaults.chips.providers,
        ...((storedUsage.chips?.providers as Partial<Record<UsageProviderId, boolean>> | undefined) ?? {}),
      },
    },
  }
  if (typeof merged.usage.showStatusBar !== 'boolean') merged.usage.showStatusBar = true
  if (typeof merged.usage.opencodeCookie !== 'string') merged.usage.opencodeCookie = ''
  // v9 once migrated lineHeight 1.4 → 1.0, but the pre-glass default was 1.4 and users reported
  // the 1.0 packing made CLI output look clipped ("cut off" on the right). The shipped default is
  // 1.4 again; a value the user deliberately set is always left untouched. (Old installs already
  // migrated to 1.0 keep it only if they explicitly want the tighter look.)
  // Keep terminal lineHeight in a sane band (1.0 = connected glyphs; the Settings slider caps at 1.2
  // because higher values reopen the sub-cell gap that tears CLI block-art). Clamp bad stored/edited
  // values on load.
  merged.terminal.lineHeight = Math.min(2.0, Math.max(1.0, merged.terminal.lineHeight || 1.0))
  // Browser media-device aliases are not real microphones. They can point at virtual routers like
  // SteelSeries Sonar and break Auto by pinning capture to a silent default. Empty string is Auto.
  if (merged.voice.inputDeviceId === 'default' || merged.voice.inputDeviceId === 'communications') {
    merged.voice.inputDeviceId = ''
  }
  // v10: the terminal palette default moves from the custom "Monolith" ramp to the classic Windows
  // Terminal "Campbell" scheme — the colors the user's OS terminal actually shows. Move anyone still
  // on the old DEFAULT (monolith) over; a palette the user deliberately chose is left untouched.
  if (storedVersion < 10 && merged.terminal.theme === 'monolith') {
    merged.terminal.theme = DEFAULT_SETTINGS.terminal.theme
  }
  // v11: canvas background is a nested object — a half-written stored value must not leak partial
  // fields. Rebuild it over the defaults (one level deep), then validate the shape.
  merged.appearance.canvasBackground = {
    ...DEFAULT_SETTINGS.appearance.canvasBackground,
    ...(merged.appearance.canvasBackground as Partial<CanvasBackground> | undefined),
  }
  const bg = merged.appearance.canvasBackground
  if (!['theme', 'solid', 'linear', 'radial'].includes(bg.kind)) bg.kind = 'theme'
  if (!Array.isArray(bg.colors) || bg.colors.length !== 2 || typeof bg.colors[0] !== 'string' || typeof bg.colors[1] !== 'string') {
    bg.colors = [...DEFAULT_SETTINGS.appearance.canvasBackground.colors]
  }
  if (typeof bg.angle !== 'number' || !Number.isFinite(bg.angle)) bg.angle = 135
  if (typeof merged.appearance.canvasGlow !== 'number' || !Number.isFinite(merged.appearance.canvasGlow)) merged.appearance.canvasGlow = 0
  merged.appearance.canvasGlow = Math.min(40, Math.max(0, merged.appearance.canvasGlow))
  if (!['fine', 'standard', 'coarse'].includes(merged.appearance.gridSize)) merged.appearance.gridSize = 'standard'
  return merged
}

/** Search-engine query templates (renderer uses these to build a search URL). */
export const SEARCH_ENGINES: Record<SearchEngineId, { label: string; query: string }> = {
  google: { label: 'Google', query: 'https://www.google.com/search?q=' },
  bing: { label: 'Bing', query: 'https://www.bing.com/search?q=' },
  duckduckgo: { label: 'DuckDuckGo', query: 'https://duckduckgo.com/?q=' },
  brave: { label: 'Brave', query: 'https://search.brave.com/search?q=' },
}
