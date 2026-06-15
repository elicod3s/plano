import { useState } from 'react'
import { AGENTS, type AgentVerdict } from '@shared/domain/agent'
import { Icon } from '@/design-system/Icon'
import { Toggle } from '@/design-system/Toggle'

/**
 * Agent-mode bar shown at the top of a terminal once an AI CLI is detected. The
 * Auto-approve toggle is ALWAYS visible while in agent mode — it is the one place red
 * signals an *enabled* (guardrail-lowered) state, never hidden in a menu.
 */
export function AgentBar({ verdict }: { verdict: AgentVerdict }) {
  const [autoApprove, setAutoApprove] = useState(false)
  const info = verdict.kind ? AGENTS[verdict.kind] : AGENTS['generic-agent']

  return (
    <div className="flex h-8 items-center gap-2 border-b border-subtle bg-surface-2 px-3">
      <Icon name={info.icon} size={14} className="text-text-primary" />
      <span className="label-caps">Agent</span>
      <span className="font-mono text-[12px] text-text-primary">{info.displayName}</span>

      <div className="ml-auto flex items-center gap-2">
        <span
          className="font-mono text-[11px]"
          style={{ color: autoApprove ? 'var(--destructive-hover)' : 'var(--text-tertiary)' }}
        >
          {autoApprove ? 'Armed — acts without asking' : 'Auto-approve'}
        </span>
        <Toggle checked={autoApprove} onChange={setAutoApprove} tone="arm" label="Auto-approve" />
      </div>
    </div>
  )
}
