import { useEffect, useMemo, type CSSProperties } from 'react'
import type { TerminalProps } from '@shared/domain/panel'
import type { AgentKind } from '@shared/domain/agent'
import { AGENTS } from '@shared/domain/agent'
import { useUiStore } from '@/stores/useUiStore'
import { usePanelStore } from '@/stores/usePanelStore'
import { useTerminalStore } from '@/stores/useTerminalStore'
import { useAgentStore } from '@/stores/useAgentStore'
import { useViewportStore } from '@/stores/useViewportStore'
import { Icon } from '@/design-system/Icon'
import { AgentLogo } from '@/panels/terminal/AgentLogo'

interface Row {
  /** terminal (tab) id — one PTY per tab, so this keys each agent uniquely. */
  termId: string
  panelId: string
  number?: number
  /** shown only when the panel has more than one tab, to disambiguate which one. */
  tabTitle?: string
  kind: AgentKind | null
  displayName: string
  accent: string
  prompt: string
}

/**
 * The "Last agent prompts" overview — opened by the `agents:last-prompts` command (no per-panel
 * button). It lists EVERY terminal on the canvas that has an agent running, each with the LAST
 * prompt the user sent to it, so a wall of agent output never hides what was last asked. A terminal
 * whose agent hasn't been prompted yet contributes no row (nothing to recall). Clicking a row flies
 * to that terminal. Styled to match the command palette (scrim + blur, rounded overlay).
 */
export function LastPromptsOverlay() {
  const open = useUiStore((s) => s.lastPromptsOpen)
  const setOpen = useUiStore((s) => s.setLastPrompts)
  const panels = usePanelStore((s) => s.panels)
  const runtimes = useTerminalStore((s) => s.byPanel)
  const verdicts = useAgentStore((s) => s.byPty)
  const lastPrompts = useAgentStore((s) => s.lastPromptByPty)

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    for (const panel of Object.values(panels)) {
      if (panel.type !== 'terminal') continue
      const props = panel.props as TerminalProps
      const tabs = props.tabs ?? []
      // Each tab is its own terminal/PTY; mirror PanelFrame's active-tab fallback for legacy panels.
      const termIds = tabs.length ? tabs.map((t) => t.id) : props.activeTabId ? [props.activeTabId] : []
      for (const termId of termIds) {
        const rt = runtimes[termId]
        if (!rt) continue
        const verdict = verdicts[rt.ptyId]
        if (!verdict?.active) continue
        const prompt = lastPrompts[rt.ptyId]
        if (!prompt) continue
        const info = verdict.kind ? AGENTS[verdict.kind] : AGENTS['generic-agent']
        out.push({
          termId,
          panelId: panel.id,
          number: props.terminalNumber,
          tabTitle: tabs.length > 1 ? tabs.find((t) => t.id === termId)?.title : undefined,
          kind: verdict.kind,
          displayName: verdict.displayName || info.displayName,
          accent: info.accent,
          prompt,
        })
      }
    }
    return out.sort((a, b) => (a.number ?? 1e9) - (b.number ?? 1e9))
  }, [panels, runtimes, verdicts, lastPrompts])

  // Esc closes (F2 toggles it back off via the command).
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, setOpen])

  if (!open) return null

  const focus = (panelId: string): void => {
    const panel = usePanelStore.getState().panels[panelId]
    setOpen(false)
    if (!panel) return
    usePanelStore.getState().bringToFront(panelId)
    const { zoom } = useViewportStore.getState()
    const cx = panel.rect.x + panel.rect.width / 2
    const cy = panel.rect.y + panel.rect.height / 2
    useViewportStore.getState().setTransform({
      x: window.innerWidth / 2 - cx * zoom,
      y: window.innerHeight / 2 - cy * zoom,
    })
  }

  return (
    <div
      className="fixed inset-0 z-[var(--z-modal)] flex items-start justify-center pt-[14vh]"
      style={{ background: 'var(--scrim)' }}
      onPointerDown={() => setOpen(false)}
    >
      <div
        data-surface-layer="modal"
        className="animate-palette-in surface-layer surface-layer--modal w-[560px] max-w-[92vw] overflow-hidden rounded-[24px]"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="flex h-[52px] items-center gap-3 border-b border-glass px-4">
          <Icon name="MessageSquareText" size={18} className="text-text-tertiary" />
          <span className="flex-1 text-[15px] font-semibold text-text-primary">Last agent prompts</span>
          {rows.length > 0 && (
            <span className="font-mono text-[11px] text-text-tertiary">
              {rows.length} {rows.length === 1 ? 'agent' : 'agents'}
            </span>
          )}
          <span className="font-mono text-[11px] text-text-tertiary">esc</span>
        </div>

        <div className="max-h-[58vh] overflow-y-auto p-2">
          {rows.length === 0 ? (
            <div className="px-3 py-12 text-center text-[13px] text-text-tertiary">
              No agent has been prompted yet.
            </div>
          ) : (
            rows.map((r) => (
              <button
                key={r.termId}
                type="button"
                onClick={() => focus(r.panelId)}
                className="group/row mb-1.5 flex w-full flex-col gap-1.5 rounded-md border border-subtle bg-surface-2 p-3 text-left transition-colors last:mb-0 hover:border-strong hover:bg-surface-3"
              >
                <div className="flex items-center gap-2">
                  <span
                    className="flex h-5 w-5 shrink-0 items-center justify-center rounded-sm"
                    style={{ background: `color-mix(in srgb, ${r.accent} 18%, transparent)` } as CSSProperties}
                  >
                    <AgentLogo kind={r.kind} size={13} color={r.accent} />
                  </span>
                  <span className="text-[13px] font-semibold text-text-primary">{r.displayName}</span>
                  {typeof r.number === 'number' && (
                    <span className="font-mono text-[11px] text-text-tertiary">
                      Terminal {r.number}
                      {r.tabTitle ? ` · ${r.tabTitle}` : ''}
                    </span>
                  )}
                  <span className="ml-auto opacity-0 transition-opacity group-hover/row:opacity-100">
                    <Icon name="ArrowRight" size={14} className="text-text-tertiary" />
                  </span>
                </div>
                <p className="whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-text-secondary">
                  {r.prompt}
                </p>
              </button>
            ))
          )}
        </div>

        <div className="flex h-9 items-center gap-4 border-t border-subtle bg-surface-2 px-4 font-mono text-[11px] text-text-tertiary">
          <span>↵ Focus terminal</span>
          <span>esc Close</span>
        </div>
      </div>
    </div>
  )
}
