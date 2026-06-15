import { useRef } from 'react'
import type { Panel } from '@shared/domain/panel'
import { useTerminalStore } from '@/stores/useTerminalStore'
import { useAgentStore, selectVerdict } from '@/stores/useAgentStore'
import { useXterm } from './useXterm'
import { AgentBar } from './AgentBar'

export function TerminalPanel({ panel }: { panel: Panel }) {
  const containerRef = useRef<HTMLDivElement>(null)
  useXterm(panel.id, containerRef)

  const ptyId = useTerminalStore((s) => s.byPanel[panel.id]?.ptyId ?? null)
  const verdict = useAgentStore(selectVerdict(ptyId))

  return (
    <div className="flex h-full flex-col">
      {verdict.active && <AgentBar verdict={verdict} />}
      <div
        ref={containerRef}
        className="min-h-0 flex-1 overflow-hidden"
        style={{ background: 'var(--surface-inset)', padding: '8px 6px 4px 10px' }}
      />
    </div>
  )
}
