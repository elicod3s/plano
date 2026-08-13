import { useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '@/design-system/Icon'
import { AgentLogo } from '@/panels/terminal/AgentLogo'
import { AGENTS } from '@shared/domain/agent'
import { cn } from '@/lib/cn'
import type { TerminalProps } from '@shared/domain/panel'

type Origin = NonNullable<TerminalProps['origin']>

/**
 * "An agent opened this."
 *
 * A canvas fills up with terminals nobody remembers opening — a worker spawned by another agent
 * looks exactly like one the user started, so the only way to learn where it came from was to ask
 * the agent that made it. This states it: a quiet mark in the header, and on hover the whole
 * provenance — who asked, which command they used, and what harness was booted.
 *
 * Deliberately NOT a badge: provenance is history, not state. It must never compete with the live
 * status dot next to it, so it rests at the weight of a punctuation mark and only resolves into a
 * card when you go looking. The card is portaled to <body> so the panel's `contain: paint` can't
 * clip it, and positioned from the mark's own rect.
 */
export function PanelOrigin({ origin, dim }: { origin: Origin; dim?: boolean }) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const kind = origin.harness && origin.harness in AGENTS ? (origin.harness as keyof typeof AGENTS) : null

  return (
    <>
      <span
        className={cn(
          'app-no-drag flex h-4 w-4 shrink-0 cursor-default items-center justify-center rounded-full transition-colors duration-150',
          dim ? 'text-text-quaternary' : 'text-text-tertiary',
          'hover:bg-glass hover:text-text-secondary',
        )}
        aria-label={`Created by ${origin.by} via ${origin.via}`}
        onMouseEnter={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          setPos({ x: r.left, y: r.bottom + 8 })
        }}
        onMouseLeave={() => setPos(null)}
      >
        <Icon name="Sparkles" size={11} />
      </span>
      {pos &&
        createPortal(
          <div
            data-surface-layer="popover"
            className="surface-layer surface-layer--popover animate-menu-in pointer-events-none fixed z-[var(--z-popover)] w-[260px] rounded-[14px] p-3"
            style={{ left: pos.x, top: pos.y }}
          >
            <div className="mb-1.5 flex items-center gap-1.5">
              <Icon name="Sparkles" size={11} className="text-text-tertiary" />
              <span className="text-[10px] font-medium uppercase tracking-label text-text-3">Opened by an agent</span>
            </div>
            <div className="text-[13px] leading-snug text-text-1">
              Created by <span className="font-medium">{origin.by}</span> via{' '}
              <span className="font-mono text-[12px]">{origin.via}</span>
            </div>
            {origin.harness && (
              <div className="mt-2 flex items-center gap-1.5 text-[12px] text-text-3">
                {kind ? <AgentLogo kind={kind} size={12} color={AGENTS[kind].accent} /> : null}
                Started with {kind ? AGENTS[kind].displayName : origin.harness}
              </div>
            )}
          </div>,
          document.body,
        )}
    </>
  )
}
