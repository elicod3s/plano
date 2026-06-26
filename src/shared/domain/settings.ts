/**
 * App-global user settings. Persisted (atomically) to <userData>/settings.json by the
 * main process and exposed to the renderer over IPC. This module is environment-agnostic
 * (no DOM / node / electron) — it only declares the shape, the defaults, and a tolerant
 * merge used when hydrating a possibly-older or partial on-disk document.
 *
 * Grouped by the Settings UI sections so a section maps to exactly one key here.
 */

export const SETTINGS_VERSION = 7

// ── enums (kept as string unions so they round-trip through JSON untouched) ──
export type ThemeId =
  | 'monolith' // default — warm-neutral monochrome (the locked Monolith palette)
  | 'slate' //   cool-neutral monochrome
  | 'carbon' //  true black / OLED
  | 'dark-warm' // richer warm browns
  | 'indigo' //  colored — deep violet (dracula-leaning)
  | 'cyber' //   colored — teal/cyan neon dark
  | 'light' //   light surfaces, dark ink

export type AccentId = string // hex, e.g. "#FFFFFF" (white = monochrome default)

export type GridStyle = 'dots' | 'lines' | 'none'

export type SearchEngineId = 'google' | 'bing' | 'duckduckgo' | 'brave'

/** How PLANO reacts when a URL appears in terminal output (forward-looking). */
export type TerminalUrlAction = 'ask' | 'plano' | 'external' | 'ignore'

/** Preferred shell for new terminals. 'auto' lets main pick the platform default. */
export type ShellChoice = 'auto' | 'powershell' | 'pwsh' | 'cmd' | 'bash' | 'zsh' | 'fish'

export type CursorStyle = 'bar' | 'block' | 'underline'

export type TerminalThemeId = 'monolith' | 'midnight' | 'amber' | 'matrix' | 'paper'

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
}

export interface AppearanceSettings {
  theme: ThemeId
  /** Accent hex. "#FFFFFF" = the monochrome default (auto-flips to ink on light themes). */
  accent: AccentId
  gridStyle: GridStyle
  /** Canvas grid strength, 0..1. */
  gridOpacity: number
  /** Monochrome film grain over the canvas substrate. */
  grain: boolean
  /** Force reduced motion regardless of the OS setting. */
  reduceMotion: boolean
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

/** Optional language hint for the (multilingual) voice model. 'auto' lets it detect es/en/… itself. */
export type VoiceLanguage = 'auto' | 'es' | 'en'

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
  voice: VoiceSettings
}

export const DEFAULT_SETTINGS: PlanoSettings = {
  version: SETTINGS_VERSION,
  general: {
    restoreLastWorkspace: true,
    restoreAgentSessions: true,
    showFilesOnLaunch: false,
    warnBeforeQuit: false,
    confirmClosePanelWithProcess: true,
  },
  appearance: {
    theme: 'monolith',
    accent: '#FFFFFF',
    gridStyle: 'dots',
    gridOpacity: 1,
    grain: true,
    reduceMotion: false,
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
    // 1.4 = Deska's airier terminal rhythm (the reference look). Paired with customGlyphs:false in the
    // terminal engine so box-drawing / CLI block-art (Claude Code's mascot) is drawn FROM THE FONT —
    // which carries its own metrics — instead of cell-clipped vectors, so the extra leading only adds
    // air and never tears the art (that tearing was the reason this used to sit at 1.0).
    lineHeight: 1.4,
    cursorStyle: 'bar',
    cursorBlink: true,
    scrollback: 5000,
    theme: 'monolith',
    copyOnSelect: false,
    predictiveHistory: true,
    smartActions: true,
    autoSuspendIdle: false,
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
    voice: group('voice'),
  }
  // v2→v3: PLANO now ships Deska's airier terminal rhythm (lineHeight 1.4), made safe by turning
  // customGlyphs OFF in the engine so box-drawing/block-art tiles from the font instead of tearing.
  // Move anyone still on the previous tight default (1.0) up to the new default; a value the user
  // deliberately set to something else is left untouched (only the exact old default is migrated).
  if (storedVersion < 3 && merged.terminal.lineHeight === 1.0) {
    merged.terminal.lineHeight = DEFAULT_SETTINGS.terminal.lineHeight
  }
  // Keep terminal lineHeight in a sane band. With customGlyphs off the glyphs carry their own metrics,
  // so values up to ~2 only add leading without tearing; clamp out-of-range stored/edited values on load.
  merged.terminal.lineHeight = Math.min(2.0, Math.max(1.0, merged.terminal.lineHeight || 1.4))
  // Browser media-device aliases are not real microphones. They can point at virtual routers like
  // SteelSeries Sonar and break Auto by pinning capture to a silent default. Empty string is Auto.
  if (merged.voice.inputDeviceId === 'default' || merged.voice.inputDeviceId === 'communications') {
    merged.voice.inputDeviceId = ''
  }

  return merged
}

/** Search-engine query templates (renderer uses these to build a search URL). */
export const SEARCH_ENGINES: Record<SearchEngineId, { label: string; query: string }> = {
  google: { label: 'Google', query: 'https://www.google.com/search?q=' },
  bing: { label: 'Bing', query: 'https://www.bing.com/search?q=' },
  duckduckgo: { label: 'DuckDuckGo', query: 'https://duckduckgo.com/?q=' },
  brave: { label: 'Brave', query: 'https://search.brave.com/search?q=' },
}
