import { useEffect, useRef } from 'react'
import type { Panel, TerminalProps, TerminalTab } from '@shared/domain/panel'
import { AGENTS } from '@shared/domain/agent'
import { usePanelStore } from '@/stores/usePanelStore'
import { useTerminalStore } from '@/stores/useTerminalStore'
import { useAgentStore } from '@/stores/useAgentStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { promptTerminalClose } from '@/stores/useTerminalClosePrompt'
import { killTerminalTab } from '@/app/terminalSessions'
import { newId } from '@/lib/id'
import { getTerminalTheme } from './terminalThemes'
import { TerminalTabBar } from './TerminalTabBar'
import { TerminalView } from './TerminalView'
import { useTerminalFocus } from './useTerminalFocus'

/**
 * A terminal panel hosts one or more terminals (tabs), each with its own PTY/xterm. A slim tab
 * strip at the top switches between them and the "+" spawns another in the same panel — usable even
 * while an agent runs in the active tab. Only the active tab mounts a <TerminalView>; switching tabs
 * just DETACHES the old terminal's DOM (its xterm instance + PTY stay alive in `terminalEngine`) and
 * re-attaches the selected tab's existing instance — a pure DOM re-parent, no buffered replay. A
 * visited tab keeps its live xterm/WebGL context in the registry until the tab is closed.
 */
export function TerminalPanel({ panel }: { panel: Panel }) {
  const props = panel.props as TerminalProps
  const updateProps = usePanelStore((s) => s.updateProps)
  const addTerminalTab = usePanelStore((s) => s.addTerminalTab)
  const closeTerminalTab = usePanelStore((s) => s.closeTerminalTab)
  const setActiveTerminalTab = usePanelStore((s) => s.setActiveTerminalTab)

  // Migration / fresh-panel bootstrap: synthesize the first tab from the legacy single-terminal
  // fields with a STABLE id (kept in a ref) so the provisional tab we render this frame and the one
  // the effect persists are the same terminal — no remount, no double-spawn. The effect then clears
  // the legacy fields so they can't act as a second source of cwd/agentSession.
  const firstIdRef = useRef('')
  const hasTabs = !!props.tabs && props.tabs.length > 0
  if (!hasTabs && !firstIdRef.current) firstIdRef.current = newId()

  const synthTab = (): TerminalTab => ({
    id: firstIdRef.current,
    cwd: props.cwd,
    shell: props.shell,
    fontSize: props.fontSize,
    bootCommand: props.bootCommand,
    agentSession: props.agentSession,
  })

  useEffect(() => {
    if (props.tabs && props.tabs.length > 0) {
      // Already on the tabs model. Scrub any leftover legacy single-terminal fields an older save may
      // still carry ALONGSIDE the tabs: a lingering panel-level agentSession is a phantom source that
      // a brand-new "+" tab would resume (the real one now lives on tab[0]). One-time cleanup.
      if (props.cwd || props.shell || props.fontSize !== undefined || props.agentSession || props.bootCommand) {
        updateProps<'terminal'>(panel.id, {
          cwd: undefined,
          shell: undefined,
          fontSize: undefined,
          bootCommand: undefined,
          agentSession: undefined,
        })
      }
      return
    }
    if (!firstIdRef.current) return
    updateProps<'terminal'>(panel.id, {
      tabs: [synthTab()],
      activeTabId: firstIdRef.current,
      cwd: undefined,
      shell: undefined,
      fontSize: undefined,
      bootCommand: undefined,
      agentSession: undefined,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel.id, hasTabs])

  // Assign a stable, human-facing terminal number (smallest free integer) on first mount, so each
  // terminal has a visible identifier the user — and Odla — can refer to ("focus terminal 2").
  useEffect(() => {
    if (typeof props.terminalNumber === 'number') return
    const used = new Set<number>()
    for (const p of Object.values(usePanelStore.getState().panels)) {
      if (p.type === 'terminal' && p.id !== panel.id) {
        const n = (p.props as TerminalProps).terminalNumber
        if (typeof n === 'number') used.add(n)
      }
    }
    let n = 1
    while (used.has(n)) n++
    updateProps<'terminal'>(panel.id, { terminalNumber: n })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel.id])

  const tabs = hasTabs ? props.tabs! : [synthTab()]
  // Resolve the active terminal, tolerating a stale/absent activeTabId.
  const activeTermId =
    (props.activeTabId && tabs.some((t) => t.id === props.activeTabId) ? props.activeTabId : undefined) ??
    tabs[0].id

  // Focus: narrow store subscription that runs the engine's safe xterm focus when this
  // panel becomes the focused canvas member, when the epoch bumps while focused (refocus after an
  // overlay stole DOM focus), or when the active tab changes while focused. No React state involved,
  // so focusing this terminal never re-renders other terminal bodies.
  useTerminalFocus(panel.id, activeTermId)

  // Match the panel body (incl. its padding gutter) to the xterm theme's background so a colored
  // terminal theme has no color seam / "bars" around the content.
  const themeDefault = useSettingsStore((s) => s.settings.terminal.theme)
  const bg = getTerminalTheme(props.theme ?? themeDefault).background ?? 'var(--surface-inset)'

  const handleAdd = (): void => {
    addTerminalTab(panel.id)
  }

  // Closing a tab kills its PTY for real (unlike a space switch). Guard a tab that has a detected
  // agent running with the same confirm used for closing the whole panel (skippable in Settings).
  const handleClose = (tabId: string): void => {
    const rt = useTerminalStore.getState().byPanel[tabId]
    const ptyId = rt?.ptyId ?? null
    const verdict = ptyId ? useAgentStore.getState().byPty[ptyId] : undefined
    const doClose = (): void => {
      killTerminalTab(tabId)
      closeTerminalTab(panel.id, tabId)
    }
    const confirmOn = useSettingsStore.getState().settings.general.confirmClosePanelWithProcess
    if (confirmOn && verdict?.active) {
      void promptTerminalClose({
        agentName: verdict.kind ? AGENTS[verdict.kind].displayName : 'An agent',
        agentIcon: verdict.kind ? AGENTS[verdict.kind].icon : 'Bot',
        ptyId,
        cwd: rt?.cwd,
      }).then((ok) => {
        if (ok) doClose()
      })
      return
    }
    doClose()
  }

  return (
    <div className="relative flex h-full flex-col">
      <TerminalTabBar
        tabs={tabs}
        activeTabId={activeTermId}
        onSelect={(id) => setActiveTerminalTab(panel.id, id)}
        onClose={handleClose}
        onAdd={handleAdd}
      />
      {/* Only the active tab is mounted. key={activeTermId} unmounts the old TerminalView — which
          DETACHES its terminal's DOM (the engine keeps the xterm instance + PTY alive) — and mounts
          the selected tab's view, re-attaching its existing instance (pure DOM re-parent, no replay). */}
      <TerminalView
        key={activeTermId}
        termId={activeTermId}
        panelId={panel.id}
        bg={bg}
      />
    </div>
  )
}
