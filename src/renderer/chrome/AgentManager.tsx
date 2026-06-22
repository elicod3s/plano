import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTerminalStore } from '@/stores/useTerminalStore'
import { useAgentStore } from '@/stores/useAgentStore'
import { usePanelStore } from '@/stores/usePanelStore'
import { useSpacesStore } from '@/stores/useSpacesStore'
import { switchSpace } from '@/app/workspaceActions'
import { focusPanel } from '@/app/actions'
import { AGENTS, type AgentKind, type AgentVerdict } from '@shared/domain/agent'
import { AgentLogo } from '@/panels/terminal/AgentLogo'
import { Icon } from '@/design-system/Icon'
import { cn } from '@/lib/cn'

const DROPDOWN_W = 340

/** `color` mixed with transparency — scoped agent-accent tints (matches the agent panel precedent). */
function tint(color: string, pct: number): string {
  return `color-mix(in srgb, ${color} ${pct}%, transparent)`
}

/** A running agent resolved to the panel/space it lives in (its PTY may be in a backgrounded space). */
interface RunningAgent {
  panelId: string
  /** The specific terminal (tab) inside the panel that hosts this agent. */
  termId: string
  ptyId: string
  verdict: AgentVerdict
  prompt: string
  /** Panel title (the terminal's name on the canvas). */
  title: string
  spaceId: string | null
  spaceName: string | null
  inActiveSpace: boolean
}

/**
 * Agent manager — the TopBar running-agents control. The static count pill becomes a button that
 * opens a floating roster of every terminal currently hosting a detected AI CLI. Each row reads its
 * agent (kind + live Working/Idle phase + first prompt); clicking jumps straight to that terminal on
 * the canvas — switching workspace first when the agent lives in a backgrounded space (PTYs keep
 * running there), in which case the row also names that workspace. Portaled to <body>, right-aligned.
 */
export function AgentManager() {
  const sessions = useTerminalStore((s) => s.byPanel)
  const verdicts = useAgentStore((s) => s.byPty)
  const prompts = useAgentStore((s) => s.promptByPty)
  const panels = usePanelStore((s) => s.panels)
  const spaces = useSpacesStore((s) => s.spaces)
  const activeId = useSpacesStore((s) => s.activeId)

  const triggerRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  // Join the three runtime stores: a terminal session whose PTY carries an active verdict is a
  // running agent. Resolve its panel/space — live canvas if in the active space, else its snapshot.
  const agents = useMemo<RunningAgent[]>(() => {
    const out: RunningAgent[] = []
    // sessions is keyed by terminal id; a terminal's owning panel is rt.panelId (a panel can host
    // several tabs, each potentially running its own agent — every one gets a roster row).
    for (const [termId, rt] of Object.entries(sessions)) {
      const verdict = verdicts[rt.ptyId]
      if (!verdict?.active) continue

      const panelId = rt.panelId
      let title = 'Terminal'
      let spaceId: string | null = null
      let spaceName: string | null = null
      let inActiveSpace = false

      const live = panels[panelId]
      if (live) {
        title = live.title || 'Terminal'
        spaceId = activeId
        spaceName = spaces.find((s) => s.id === activeId)?.name ?? null
        inActiveSpace = true
      } else {
        for (const sp of spaces) {
          const p = sp.panels.find((pp) => pp.id === panelId)
          if (p) {
            title = p.title || 'Terminal'
            spaceId = sp.id
            spaceName = sp.name
            break
          }
        }
      }

      out.push({
        panelId,
        termId,
        ptyId: rt.ptyId,
        verdict,
        prompt: prompts[rt.ptyId] ?? '',
        title,
        spaceId,
        spaceName,
        inActiveSpace,
      })
    }
    // Active-space agents first, then alphabetical by title so the roster reads stably.
    return out.sort((a, b) => {
      if (a.inActiveSpace !== b.inActiveSpace) return a.inActiveSpace ? -1 : 1
      return a.title.localeCompare(b.title)
    })
  }, [sessions, verdicts, prompts, panels, spaces, activeId])

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
        left: Math.max(8, Math.min(r.right - DROPDOWN_W, window.innerWidth - DROPDOWN_W - 8)),
        top: r.bottom + 8,
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
          'app-no-drag flex items-center gap-1.5 rounded-pill border py-1 pl-2 pr-2.5 transition-colors',
          open ? 'border-strong bg-accent-soft' : 'border-subtle bg-surface-2 hover:border-default hover:bg-accent-soft',
        )}
      >
        <span
          className="h-1.5 w-1.5 shrink-0 rounded-pill animate-status-pulse"
          style={{ background: 'var(--status-active)' }}
        />
        <span className="font-mono text-[11px] tabular-nums text-text-secondary">{count}</span>
        <span className="label-caps text-text-tertiary">{count > 1 ? 'Agents' : 'Agent'}</span>
        <Icon
          name="ChevronDown"
          size={12}
          className={cn('text-text-quaternary transition-transform duration-200', open && 'rotate-180')}
        />
      </button>

      {open &&
        pos &&
        createPortal(
          <div className="fixed inset-0 z-[55]" onPointerDown={() => setOpen(false)}>
            <div
              className="animate-palette-in absolute flex flex-col overflow-hidden rounded-2xl border border-strong shadow-overlay"
              style={{
                left: pos.left,
                top: pos.top,
                width: DROPDOWN_W,
                background: 'color-mix(in srgb, var(--bg-base) 94%, transparent)',
                backdropFilter: 'blur(20px)',
              }}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between px-4 pb-1.5 pt-3">
                <span className="label-caps">Running agents</span>
                <span className="font-mono text-[10px] text-text-quaternary">
                  {String(count).padStart(2, '0')}
                </span>
              </div>

              <div className="max-h-[52vh] overflow-y-auto px-1.5 pb-1.5">
                {agents.map((a) => (
                  <AgentRow key={a.panelId} agent={a} onGoTo={() => goTo(a)} />
                ))}
              </div>

              <div className="flex items-center gap-3.5 border-t border-subtle bg-surface-2 px-4 py-2 font-mono text-[10px] text-text-quaternary">
                <span>↵ Jump to terminal</span>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}

function AgentRow({ agent, onGoTo }: { agent: RunningAgent; onGoTo: () => void }) {
  const kind: AgentKind = agent.verdict.kind ?? 'generic-agent'
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
          <span className="truncate font-mono text-[10px] text-text-tertiary">{agent.title}</span>
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
