import { type CSSProperties } from 'react'
import { AGENTS, type AgentVerdict } from '@shared/domain/agent'
import { Icon } from '@/design-system/Icon'
import { AgentLogo } from './AgentLogo'

/**
 * The terminal panel HEADER once an AI CLI is detected — a Warp-style identity strip that
 * replaces the plain "Terminal" title: brand logo + CLI name, then the activity glyph
 * ATTACHED to the first prompt (three pulsing dots while working, a check once the turn
 * finishes). Shown ONLY while an agent is active; a plain shell keeps the normal header. The
 * accent (the detected agent's brand color) is the one deliberate splash of color here.
 */
export function AgentTitle({
  verdict,
  prompt,
  accent,
}: {
  verdict: AgentVerdict
  prompt: string
  accent: string | null
}) {
  const info = verdict.kind ? AGENTS[verdict.kind] : AGENTS['generic-agent']
  const tint = accent ?? info.accent
  // Default to "working" unless the detector explicitly reports the stream went quiet.
  const done = verdict.phase === 'idle'

  // Sits right next to the prompt text (Warp-style): a check when done, three pulsing dots
  // (staggered) while the agent is still working.
  const status = done ? (
    <Icon
      name="Check"
      size={13}
      className="shrink-0"
      style={{ color: 'var(--status-ready)' } as CSSProperties}
    />
  ) : (
    <span className="flex shrink-0 items-center gap-[3px]" aria-label="Working">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-1 w-1 rounded-pill animate-status-pulse"
          style={{ background: tint, animationDelay: `${i * 180}ms` }}
        />
      ))}
    </span>
  )

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <AgentLogo kind={verdict.kind} size={14} className="shrink-0" color={tint} />
      <span className="shrink-0 text-[13px] font-semibold text-text-primary">{info.displayName}</span>

      {prompt ? (
        <>
          <span className="shrink-0 text-text-quaternary">·</span>
          <span className="flex min-w-0 flex-1 items-center gap-1.5">
            {status}
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-text-tertiary" title={prompt}>
              {prompt}
            </span>
          </span>
        </>
      ) : (
        status
      )}
    </div>
  )
}
