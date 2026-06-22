import { useState } from 'react'
import { Icon } from '@/design-system/Icon'
import { Toggle } from '@/design-system/Toggle'

/**
 * The Auto-approve guardrail control, shown inline in a detected terminal's HEADER (no more
 * separate bar). It stays visible the whole time an agent is active — the one place red
 * signals an *enabled* (guardrail-lowered) state, never hidden in a menu. Stays calm/neutral
 * by default; the explicit "Armed" word + red only appear once it's actually switched on.
 */
export function AgentControls() {
  const [autoApprove, setAutoApprove] = useState(false)
  const tone = autoApprove ? 'var(--destructive-hover)' : 'var(--text-tertiary)'

  return (
    <div
      className="app-no-drag flex shrink-0 items-center gap-1.5"
      title={
        autoApprove
          ? 'Auto-approve armed — the agent acts without asking'
          : 'Auto-approve — let the agent act without asking'
      }
    >
      <Icon name="ShieldCheck" size={13} style={{ color: tone }} />
      <span className="label-caps" style={{ color: tone }}>
        {autoApprove ? 'Armed' : 'Auto-approve'}
      </span>
      <Toggle checked={autoApprove} onChange={setAutoApprove} tone="arm" label="Auto-approve" />
    </div>
  )
}
