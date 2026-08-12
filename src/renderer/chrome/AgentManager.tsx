import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAgentStore } from '@/stores/useAgentStore'
import { usePanelStore } from '@/stores/usePanelStore'
import { useUiStore } from '@/stores/useUiStore'
import { useMeshLinks, useMeshMembers, useMeshTimeline } from '@/stores/useMeshLinks'
import { switchSpace } from '@/app/workspaceActions'
import { focusPanel } from '@/app/actions'
import { buildAgentRoster, type RunningAgent } from '@/app/agentRoster'
import { AGENTS, type AgentKind } from '@shared/domain/agent'
import { AgentLogo } from '@/panels/terminal/AgentLogo'
import { Icon } from '@/design-system/Icon'
import { cn } from '@/lib/cn'

const DROPDOWN_W = 340

/** `color` mixed with transparency — scoped agent-accent tints (matches the agent panel precedent). */
function tint(color: string, pct: number): string {
  return `color-mix(in srgb, ${color} ${pct}%, transparent)`
}

/**
 * Agent manager — the TopBar running-agents control. The static count pill becomes a button that
 * opens a floating roster of every terminal currently hosting a detected AI CLI (reusing the ONE
 * cross-workspace join from app/agentRoster). Each row reads its agent (kind + live Working/Idle
 * phase + first prompt); clicking jumps straight to that terminal on the canvas — switching
 * workspace first when the agent lives in a backgrounded space (PTYs keep running there), in which
 * case the row also names that workspace. Portaled to <body>, right-aligned.
 */
export function AgentManager() {
  const verdicts = useAgentStore((s) => s.byPty)
  const toggleMesh = useUiStore((s) => s.toggleAgentControl)

  const triggerRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  // v4 A5: Agents | Mesh tab inside the manager dropdown.
  const [tab, setTab] = useState<'agents' | 'mesh'>('agents')

  // Recompute only when the underlying stores change (the roster reads them directly).
  const agents = useMemo<RunningAgent[]>(() => {
    // Force recompute on verdict changes by reading the raw map in the dep array.
    void verdicts
    return buildAgentRoster()
  }, [verdicts])

  const count = agents.length

  // Close if the last agent vanishes while the menu is open.
  useEffect(() => {
    if (open && count === 0) setOpen(false)
  }, [open, count])

  useLayoutEffect(() => {
    if (!open) return
    const r = triggerRef.current?.getBoundingClientRect()
    if (r) {
      setPos({
        left: Math.max(12, Math.min(r.right - DROPDOWN_W, window.innerWidth - DROPDOWN_W - 12)),
        top: r.bottom + 12,
      })
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onResize = (): void => setOpen(false)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [open])

  if (count === 0) return null

  const goTo = (a: RunningAgent): void => {
    setOpen(false)
    // switchSpace is synchronous (it hydrates the live canvas inline), so the panel is on the
    // canvas by the time focusPanel reads it.
    if (!a.inActiveSpace && a.spaceId) switchSpace(a.spaceId)
    // Show the specific tab hosting this agent (no-op if the panel has a single terminal).
    usePanelStore.getState().setActiveTerminalTab(a.panelId, a.termId)
    focusPanel(a.panelId)
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={`${count} agent${count > 1 ? 's' : ''} running — manage`}
        title={`${count} agent${count > 1 ? 's' : ''} running`}
        className={cn(
          'app-no-drag flex items-center gap-1.5 rounded-pill border border-glass py-1 pl-2.5 pr-2.5 transition-colors',
          open ? 'border-glass-hover bg-glass-hover' : 'hover:border-glass-hover hover:bg-glass',
        )}
      >
        <span
          className="h-1.5 w-1.5 shrink-0 rounded-pill animate-status-pulse"
          style={{ background: 'var(--status-active)' }}
        />
        <span className="font-mono text-[11px] tabular-nums text-text-2">{count}</span>
        <span className="text-[11.5px] text-text-2">{count > 1 ? 'Agents' : 'Agent'}</span>
        <Icon
          name="ChevronDown"
          size={12}
          className={cn('text-text-quaternary transition-transform duration-200', open && 'rotate-180')}
        />
      </button>

      {open &&
        pos &&
        createPortal(
          <div className="fixed inset-0 z-[var(--z-popover)]" onPointerDown={() => setOpen(false)}>
            <div
              data-surface-layer="popover"
              className="animate-palette-in surface-layer surface-layer--popover absolute flex flex-col overflow-hidden rounded-[20px]"
              style={{ left: pos.left, top: pos.top, width: DROPDOWN_W }}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between px-4 pb-1.5 pt-3">
                <span className="label-caps">Running agents</span>
                <span className="font-mono text-[10px] text-text-quaternary">
                  {String(count).padStart(2, '0')}
                </span>
              </div>

              {/* v4 A5: Agents | Mesh */}
              <div className="flex gap-1 px-4 pb-2">
                {(['agents', 'mesh'] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setTab(t)}
                    className={cn(
                      'rounded-pill px-2.5 py-1 text-[11px] font-medium capitalize transition-colors',
                      tab === t ? 'bg-accent text-text-onsolid' : 'text-text-2 hover:bg-glass-hover',
                    )}
                  >
                    {t === 'agents' ? 'Agents' : 'Mesh'}
                  </button>
                ))}
              </div>

              {tab === 'agents' ? (
                <>
                  <div className="max-h-[52vh] overflow-y-auto px-1.5 pb-1.5">
                    {agents.map((a) => (
                      <AgentRow key={a.panelId} agent={a} onGoTo={() => goTo(a)} />
                    ))}
                  </div>

                  <div className="flex items-center gap-3.5 border-t border-glass bg-glass px-4 py-2 font-mono text-[10px] text-text-4">
                    <span>↵ Jump to terminal</span>
                  </div>

                  <button
                    type="button"
                    onClick={() => {
                      setOpen(false)
                      toggleMesh()
                    }}
                    className="flex w-full items-center justify-center gap-2 border-t border-glass bg-glass px-4 py-2 text-[12px] font-medium text-text-2 transition-colors hover:bg-glass-hover hover:text-text-1"
                  >
                    <Icon name="Waypoints" size={14} />
                    Open agent mesh
                  </button>
                </>
              ) : (
                <MeshView />
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}

interface ChainRow {
  id: string
  from: string
  to: string
  when: string
  payloadSource: string
  status: string
  failReason?: string | null
}

/** v4 A5: compact mesh graph (nodes + relations), the audit timeline, and cancelable chains. */
function MeshView() {
  const links = useMeshLinks()
  const members = useMeshMembers()
  const timeline = useMeshTimeline()
  const [chains, setChains] = useState<ChainRow[]>([])
  const [refreshing, setRefreshing] = useState(false)

  const refresh = (): void => {
    setRefreshing(true)
    void window.plano.agentMesh
      .getChains()
      .then((r) => {
        if (Array.isArray(r.chains)) setChains(r.chains as ChainRow[])
      })
      .finally(() => setRefreshing(false))
  }
  useEffect(refresh, [])

  const jump = (panelId: string): void => {
    if (!panelId) return
    focusPanel(panelId)
  }

  return (
    <div className="max-h-[52vh] overflow-y-auto px-3 pb-3">
      {/* graph */}
      <div className="label-caps mb-1.5 mt-1">Relationships</div>
      {members.length === 0 ? (
        <div className="py-3 text-center text-[11.5px] text-text-4">No mesh members yet</div>
      ) : (
        <svg viewBox="0 0 320 130" className="w-full" aria-hidden>
          {links.map((link) => {
            const a = members.find((m) => m.panelId === link.fromPanel)
            const b = members.find((m) => m.panelId === link.toPanel)
            if (!a || !b) return null
            const ia = members.indexOf(a)
            const ib = members.indexOf(b)
            const x1 = 30 + (ia % 2) * 260 + (ia % 2 === 0 ? 40 : -40)
            const y1 = 18 + Math.floor(ia / 2) * 52
            const x2 = 30 + (ib % 2) * 260 + (ib % 2 === 0 ? 40 : -40)
            const y2 = 18 + Math.floor(ib / 2) * 52
            const dash = link.chained ? '4 3' : undefined
            const opacity = link.state === 'idle' ? 0.15 : link.state === 'active' ? 0.5 : link.state === 'waiting' ? 0.6 : 0.3
            return <path key={link.id} d={`M ${x1} ${y1} L ${x2} ${y2}`} stroke={link.color} strokeWidth={1.2} strokeDasharray={dash} opacity={opacity} fill="none" />
          })}
          {members.map((m, i) => {
            const kind = m.kind as AgentKind
            const accent = AGENTS[kind]?.accent ?? '#8b9bff'
            const x = 30 + (i % 2) * 260 + (i % 2 === 0 ? 40 : -40)
            const y = 18 + Math.floor(i / 2) * 52
            return (
              <g key={m.ptyId} onClick={() => jump(m.panelId)} className="cursor-pointer">
                <circle cx={x} cy={y} r={9} fill={accent} opacity={0.22} />
                <circle cx={x} cy={y} r={5} fill={accent} />
                <text x={x} y={y + 20} textAnchor="middle" fontSize={9} fill="var(--text-2)" style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {AGENTS[kind]?.displayName ?? 'terminal'}
                </text>
              </g>
            )
          })}
        </svg>
      )}

      {/* chains */}
      <div className="mb-1.5 mt-2 flex items-center justify-between">
        <span className="label-caps">Chained tasks</span>
        <button type="button" onClick={refresh} className="text-[10.5px] text-text-3 transition-colors hover:text-text-1">
          Refresh
        </button>
      </div>
      {chains.length === 0 ? (
        <div className="py-2 text-center text-[11.5px] text-text-4">{refreshing ? 'Loading…' : 'No chained tasks'}</div>
      ) : (
        <div className="flex flex-col gap-1">
          {chains.map((c) => (
            <div key={c.id} className="flex items-center gap-2 rounded-lg border border-glass px-2 py-1.5">
              <span
                className={cn('h-1.5 w-1.5 shrink-0 rounded-pill', c.status === 'armed' && 'animate-status-pulse')}
                style={{ background: c.status === 'armed' ? 'var(--status-active)' : c.status === 'fired' ? 'var(--diff-added, #34d399)' : 'var(--text-quaternary)' }}
              />
              <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-text-2">
                {c.when} · {c.payloadSource} · {c.status}
                {c.failReason ? ` · ${c.failReason}` : ''}
              </span>
              {c.status === 'armed' && (
                <button
                  type="button"
                  onClick={() => {
                    void window.plano.agentMesh.cancelChain(c.id).then(() => refresh())
                  }}
                  className="shrink-0 rounded-pill border border-glass px-2 py-0.5 text-[10px] text-text-3 transition-colors hover:border-[var(--destructive-border)] hover:text-[var(--destructive)]"
                >
                  Cancel
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* timeline */}
      <div className="label-caps mb-1.5 mt-2">Timeline</div>
      <div className="flex flex-col gap-0.5 font-mono text-[10px] leading-4">
        {timeline.slice(0, 12).map((e, i) => (
          <div key={`${e.at}-${i}`} className="flex items-baseline gap-1.5 text-text-3">
            <span className="shrink-0 text-text-quaternary">{new Date(e.at).toLocaleTimeString([], { hour12: false })}</span>
            <span className="shrink-0 text-text-2">{e.kind}</span>
            <span className="min-w-0 truncate">
              {e.from.slice(0, 8)}
              {e.to ? ` \u2192 ${e.to.slice(0, 8)}` : ''}
              {e.detail ? ` · ${e.detail}` : ''}
            </span>
          </div>
        ))}
        {timeline.length === 0 && <div className="py-1 text-center text-text-4">No events yet</div>}
      </div>
    </div>
  )
}

function AgentRow({ agent, onGoTo }: { agent: RunningAgent; onGoTo: () => void }) {  const kind: AgentKind = agent.verdict.kind ?? 'generic-agent'
  const info = AGENTS[kind]
  const name = agent.verdict.displayName ?? info.displayName
  const working = agent.verdict.phase === 'working'

  return (
    <button
      type="button"
      onClick={onGoTo}
      className="group flex w-full items-center gap-2.5 rounded-xl border border-transparent px-2 py-2 text-left transition-colors hover:bg-accent-soft"
    >
      {/* official brand mark on an accent-tinted tile (the scoped color exception, sourced from
          AGENTS[kind].accent). AgentLogo renders the real Claude/OpenAI/Gemini logo, inheriting
          the tile's currentColor; CLIs with no official mark fall back to a clean glyph. */}
      <span
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border"
        style={{ background: tint(info.accent, 14), borderColor: tint(info.accent, 38), color: info.accent }}
      >
        <AgentLogo kind={agent.verdict.kind} size={15} />
      </span>

      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-[12.5px] font-medium text-text-primary">{name}</span>
          <span className="flex shrink-0 items-center gap-1">
            <span
              className={cn('h-1.5 w-1.5 rounded-pill', working && 'animate-status-pulse')}
              style={{ background: working ? 'var(--status-active)' : 'var(--text-quaternary)' }}
            />
            <span className="font-mono text-[9.5px] uppercase tracking-wider text-text-tertiary">
              {working ? 'Working' : 'Idle'}
            </span>
          </span>
        </span>

        <span className="mt-0.5 flex items-center gap-1.5">
          <Icon name="SquareTerminal" size={11} className="shrink-0 text-text-quaternary" />
          <span className="truncate font-mono text-[10px] text-text-tertiary">
            {typeof agent.terminalNumber === 'number' ? `Terminal ${agent.terminalNumber}` : agent.title}
          </span>
          {/* Only when the agent lives in another workspace: name it so you know the row will switch. */}
          {!agent.inActiveSpace && agent.spaceName && (
            <span className="flex shrink-0 items-center gap-1 rounded-pill bg-surface-3 px-1.5 py-px font-mono text-[9px] text-text-quaternary">
              <Icon name="LayoutGrid" size={9} />
              {agent.spaceName}
            </span>
          )}
        </span>

        {agent.prompt && (
          <span className="mt-1 block truncate text-[11px] text-text-secondary">{agent.prompt}</span>
        )}
      </span>

      <Icon
        name="LocateFixed"
        size={15}
        className="shrink-0 text-text-quaternary transition-colors group-hover:text-text-primary"
      />
    </button>
  )
}
