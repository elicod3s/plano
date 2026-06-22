import type { IconType } from 'react-icons'
import { SiClaude, SiOpenai, SiGooglegemini } from 'react-icons/si'
import type { AgentKind } from '@shared/domain/agent'
import { AGENTS } from '@shared/domain/agent'
import { Icon } from '@/design-system/Icon'
import { KiroLogo } from './KiroLogo'

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
  const lucideName = kind ? AGENTS[kind].icon : AGENTS['generic-agent'].icon
  return <Icon name={lucideName} size={size} color={color} className={className} />
}
