import type { IconType } from 'react-icons'
import { SiClaude, SiOpenai, SiGooglegemini } from 'react-icons/si'
import type { AgentKind } from '@shared/domain/agent'
import { AGENTS } from '@shared/domain/agent'
import { Icon } from '@/design-system/Icon'
import { KiroLogo } from './KiroLogo'
import { GrokLogo } from './GrokLogo'
import { OmpLogo } from './OmpLogo'
import { PiLogo } from './PiLogo'

/**
 * The OFFICIAL brand mark for a detected agent (Claude, OpenAI, Gemini via simple-icons),
 * matching the Agents quick-launcher. Falls back to the agent's lucide glyph for CLIs with
 * no official mark (opencode, aider) — so we never show a generic "AI sparkle" for a brand
 * that has a real logo.
 */
const BRAND: Partial<Record<AgentKind, IconType>> = {
  'claude-code': SiClaude,
  codex: SiOpenai,
  'gemini-cli': SiGooglegemini,
  'kiro-cli': KiroLogo,
  grok: GrokLogo,
  omp: OmpLogo,
  pi: PiLogo,
}

export function AgentLogo({
  kind,
  size = 14,
  color,
  className,
}: {
  kind: AgentKind | null
  size?: number
  color?: string
  className?: string
}) {
  const Brand = kind ? BRAND[kind] : undefined
  if (Brand) return <Brand size={size} color={color} className={className} />
  // Look the entry up DEFENSIVELY. The old `kind ? AGENTS[kind].icon : …` only guarded against a
  // null kind, not against a kind that isn't in the table — and the mesh roster carries
  // `AgentKind | 'unknown'`, so a toast for an undetected agent read `AGENTS['unknown'].icon`,
  // threw, and took the whole renderer down ("PLANO crashed on render"). A logo is decoration:
  // it must never be able to crash the app, whatever string reaches it.
  const entry = (kind ? AGENTS[kind] : undefined) ?? AGENTS['generic-agent']
  return <Icon name={entry.icon} size={size} color={color} className={className} />
}
