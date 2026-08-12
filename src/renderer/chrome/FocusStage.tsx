import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { usePanelStore } from '@/stores/usePanelStore'
import { useUiStore } from '@/stores/useUiStore'
import { useAgentStore } from '@/stores/useAgentStore'
import { useTerminalStore } from '@/stores/useTerminalStore'
import { AgentLogo } from '@/panels/terminal/AgentLogo'
import { Icon } from '@/design-system/Icon'
import { cn } from '@/lib/cn'
import type { TerminalProps } from '@shared/domain/panel'

/**
 * Focus mode — one panel fills the canvas so a single thing can have the whole screen.
 *
 * Modelled on macOS full screen, including what it deliberately does NOT take: the top bar stays,
 * so the workspace switcher and the usage island remain reachable and the user never feels
 * trapped. Everything else recedes behind a dimmed, blurred backdrop.
 *
 * The panel itself is NOT re-created here: PanelFrame portals its existing shell into this stage,
 * so the terminal's xterm instance, scrollback and PTY attachment survive entering and leaving —
 * a remount would have detached the session and replayed the buffer for nothing.
 *
 * Leaving: the header button (which becomes "collapse"), Escape, or clicking the backdrop.
 */

/** The stage's DOM host, created once and reused — PanelFrame portals into it. */
export const FOCUS_ROOT_ID = 'plano-focus-root'

export function FocusStage() {
  const focusedPanelId = useUiStore((s) => s.focusedPanelId)
  const setFocusedPanel = useUiStore((s) => s.setFocusedPanel)
  const panels = usePanelStore((s) => s.panels)

  // Escape leaves focus mode from anywhere — the one shortcut every full-screen surface honours.
  useEffect(() => {
    if (!focusedPanelId) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setFocusedPanel(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [focusedPanelId, setFocusedPanel])

  // A focused panel that disappears (closed from elsewhere) must not leave an empty stage.
  useEffect(() => {
    if (focusedPanelId && !panels[focusedPanelId]) setFocusedPanel(null)
  }, [focusedPanelId, panels, setFocusedPanel])

  const active = !!focusedPanelId

  return (
    <>
      {/* Backdrop: everything else recedes. Clicking it leaves, like tapping outside a sheet. */}
      {active && (
        <div
          className="fixed inset-0 z-[var(--z-popover)] bg-[rgba(0,0,0,0.55)] backdrop-blur-[2px] motion-safe:animate-menu-in"
          onPointerDown={() => setFocusedPanel(null)}
        />
      )}
      {/*
       * The stage host is mounted ALWAYS, even with nothing focused. PanelFrame resolves it with
       * getElementById during its own render, and React renders the canvas before this component:
       * a host created only on demand would not exist on the frame focus is switched on, the
       * portal would silently fall back to the canvas, and nothing would re-render to fix it.
       * Empty, it is inert — no size, no pointer events.
       *
       * Top offset clears the TopBar (top-4 + h-11); the generous margin keeps the panel reading
       * as a focused object rather than a browser in kiosk mode.
       */}
      <div
        id={FOCUS_ROOT_ID}
        className={cn(
          'fixed bottom-14 left-6 right-6 top-[68px] z-[var(--z-popover)]',
          active ? 'motion-safe:animate-panel-in' : 'pointer-events-none opacity-0',
        )}
        aria-hidden={!active}
      />
      {active && focusedPanelId && <FocusSwitcher focusedPanelId={focusedPanelId} />}
    </>
  )
}

/**
 * The switcher: every open terminal as a chip, so focus can move without leaving focus. It is the
 * full-screen tab strip — you went into one thing, you can still step to the next without first
 * going back out. Sits below the stage, where a dock would be.
 */
function FocusSwitcher({ focusedPanelId }: { focusedPanelId: string }) {
  const panels = usePanelStore((s) => s.panels)
  const setFocusedPanel = useUiStore((s) => s.setFocusedPanel)
  const verdicts = useAgentStore((s) => s.byPty)
  const runtime = useTerminalStore((s) => s.byPanel)

  const terminals = Object.values(panels)
    .filter((p) => p.type === 'terminal' && !p.dockedIn)
    .sort((a, b) => {
      const na = (a.props as TerminalProps).terminalNumber ?? 0
      const nb = (b.props as TerminalProps).terminalNumber ?? 0
      return na - nb
    })
  if (terminals.length <= 1) return null

  return createPortal(
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[var(--z-popover)] flex justify-center">
      <div className="app-no-drag surface-layer surface-layer--chrome pointer-events-auto flex max-w-[min(760px,92vw)] items-center gap-1.5 overflow-x-auto rounded-pill px-2.5 py-1.5">
        {terminals.map((p) => {
          const props = p.props as TerminalProps
          const active = p.id === focusedPanelId
          // The runtime map is keyed by terminal id, so find whichever tab of this panel is live.
          const ptyId = Object.values(runtime).find((rt) => rt.panelId === p.id)?.ptyId
          const verdict = ptyId ? verdicts[ptyId] : undefined
          const label = p.title || (props.terminalNumber ? `Terminal ${props.terminalNumber}` : 'Terminal')
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => setFocusedPanel(p.id)}
              title={label}
              className={cn(
                'flex h-8 shrink-0 items-center gap-2 rounded-pill px-3.5 text-[12px] transition-colors',
                active ? 'bg-glass-active text-text-1' : 'text-text-3 hover:bg-glass hover:text-text-1',
              )}
            >
              {verdict?.active ? (
                <AgentLogo kind={verdict.kind ?? 'generic-agent'} size={13} />
              ) : (
                <Icon name="SquareTerminal" size={13} />
              )}
              <span className="max-w-[140px] truncate">{label}</span>
            </button>
          )
        })}
      </div>
    </div>,
    document.body,
  )
}
