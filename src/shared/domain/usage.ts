/**
 * Live subscription-usage contract for the status bar (plan PLAN_STATUS_BAR_LIVE_USAGE).
 *
 * Environment-agnostic (no node/electron/dom imports): this is the shared shape both the
 * Agent Host (daemon) and the renderer program against. The daemon collects provider quotas
 * and broadcasts a `UsageSnapshot`; the renderer renders chips from it. Percentages travel
 * unrounded 0-100 and are rounded ONCE at render time — never store pre-formatted strings.
 */

export type UsageProviderId = 'claude' | 'codex' | 'gemini' | 'opencode-go' | 'grok' | 'omp'

/** One quota window (5h / 7d / 30d). */
export interface UsageWindow {
  /** 0-100, unrounded. */
  usedPercent: number
  /** 300 = 5h, 10080 = 7d, 43200 = 30d. */
  windowMinutes: number
  /** Unix ms when the window resets; null when unknown. */
  resetsAt: number | null
}

export interface ProviderUsage {
  provider: UsageProviderId
  status: 'ok' | 'stale' | 'unavailable'
  /** 5h */
  session: UsageWindow | null
  /** 7d */
  weekly: UsageWindow | null
  /**
   * The premium-model 7d window, billed separately from the general weekly one. Claude Code
   * reports it as `seven_day_opus` — the allowance a subscriber actually runs out of first, so
   * it is its own reading rather than being folded into `weekly`.
   */
  premiumWeekly?: UsageWindow | null
  /** 30d (opencode-go, grok) */
  monthly: UsageWindow | null
  /** Label for `premiumWeekly` when present (e.g. "Fable"), so the UI never invents a name. */
  premiumLabel?: string
  /** Where the numbers came from — shown in the popover so a stale number is explainable. */
  source: 'statusline' | 'session-file' | 'api' | 'cli'
  /** Unix ms of the last live read. */
  updatedAt: number
  /** Why unavailable — shown in the popover, never as a number. */
  detail?: string
}

export interface UsageSnapshot {
  providers: ProviderUsage[]
  at: number
}

/** One listening port owned by a PLANO PTY (for the ports chip popover). */
export interface PortInfo {
  port: number
  pid: number
  /** Process name of the listener, e.g. "node.exe" → "node". */
  name: string
  panelId: string
  terminalId: string
  /** Panel title, e.g. "Terminal 2" (daemon-side join to the owning panel). */
  title: string
}

/** RSS of the app + every agent process (resource chip). `appRssBytes` is filled by MAIN. */
export interface StatusbarResources {
  agentRssBytes: number
  appRssBytes?: number
  at: number
}

/** Everything the bar's non-provider chips need (ports + resources), one daemon snapshot. */
export interface StatusbarAux {
  ports: PortInfo[]
  resources: StatusbarResources
}
