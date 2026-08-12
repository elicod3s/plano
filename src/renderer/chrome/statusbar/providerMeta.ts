import { AGENTS, type AgentKind } from '@shared/domain/agent'
import type { ProviderUsage, UsageWindow } from '@shared/domain/usage'
import { formatWindowLabel } from './usageFormat'

/**
 * Provider chip identity shared by the island chips and the usage panel: the REAL brand mark
 * (AgentLogo's simple-icons/custom SVGs), the label, and the accent that only appears once a
 * budget is at risk. Every provider must resolve to a REAL mark — none may fall back to the
 * generic bot glyph.
 */
export const PROVIDER_META: Record<string, { label: string; accent: string; kind: AgentKind }> = {
  claude: { label: 'Claude', accent: AGENTS['claude-code'].accent, kind: 'claude-code' },
  codex: { label: 'Codex', accent: AGENTS.codex.accent, kind: 'codex' },
  gemini: { label: 'Gemini', accent: AGENTS['gemini-cli'].accent, kind: 'gemini-cli' },
  'opencode-go': { label: 'opencode', accent: AGENTS.opencode.accent, kind: 'opencode' },
  // Grok's brand mark is monochrome black/white; the accent is the brand-neutral gray that
  // stays visible on both themes (the GrokLogo itself tints via currentColor).
  grok: { label: 'Grok', accent: AGENTS.grok.accent, kind: 'grok' },
  omp: { label: 'Oh My Pi', accent: AGENTS.omp.accent, kind: 'omp' },
}

export function providerMeta(provider: string): { label: string; accent: string; kind: AgentKind } {
  return PROVIDER_META[provider] ?? { label: provider, accent: '#ffffff', kind: 'generic-agent' }
}

/** Every window this provider reports, in the order a user reads them (short → long → premium). */
export function windowsOf(p: ProviderUsage): { key: string; label: string; w: UsageWindow }[] {
  const out: { key: string; label: string; w: UsageWindow }[] = []
  if (p.session) out.push({ key: 'session', label: formatWindowLabel(p.session.windowMinutes), w: p.session })
  if (p.weekly) out.push({ key: 'weekly', label: formatWindowLabel(p.weekly.windowMinutes), w: p.weekly })
  if (p.premiumWeekly) out.push({ key: 'premium', label: p.premiumLabel ?? 'premium', w: p.premiumWeekly })
  if (p.monthly) out.push({ key: 'monthly', label: formatWindowLabel(p.monthly.windowMinutes), w: p.monthly })
  return out
}

/** The window closest to running out — the one that will actually stop the user. */
export function headlineWindow(p: ProviderUsage): UsageWindow | null {
  const all = windowsOf(p)
  if (all.length === 0) return null
  return all.reduce((worst, cur) => (cur.w.usedPercent > worst.w.usedPercent ? cur : worst)).w
}
