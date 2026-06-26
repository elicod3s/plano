/**
 * Execute an Intent by driving the SAME actions the keyboard/menus use — the voice layer is just
 * another frontend to the command registry + stores, never a parallel implementation. Keeps a tiny
 * conversation memory (last panel + type) so "close it" / "ciérralo" resolves to what we just did.
 */
import type { Panel, PanelType, TerminalProps } from '@shared/domain/panel'
import type { Rect } from '@shared/domain/geometry'
import { AGENTS } from '@shared/domain/agent'
import { addPanelAtCenter, focusPanel, zoomToFitAll } from '@/app/actions'
import { arrangeFloating } from '@/app/layout'
import { usePanelStore } from '@/stores/usePanelStore'
import { useViewportStore } from '@/stores/useViewportStore'
import { useUiStore } from '@/stores/useUiStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useAgentStore } from '@/stores/useAgentStore'
import { useTerminalStore } from '@/stores/useTerminalStore'
import { openFolder, saveCurrent, createNewSpace, switchSpace, deleteSpace } from '@/app/workspaceActions'
import { useSpacesStore } from '@/stores/useSpacesStore'
import { killTerminalSession } from '@/app/terminalSessions'
import { PANEL_NOUN } from './synonyms'
import type { ActionResult, Intent, Target } from './types'

/** Last panel the assistant created/focused — the referent for "it" / "lo" / "eso". */
let lastPanelId: string | null = null
let lastType: PanelType | null = null

const vp = (): { width: number; height: number } => ({ width: window.innerWidth, height: window.innerHeight })

function pluralize(noun: string, n: number): string {
  if (n <= 1) return noun
  if (/s$/i.test(noun)) return noun
  return `${noun}s`
}

function panelsOfType(type: PanelType): Panel[] {
  return Object.values(usePanelStore.getState().panels)
    .filter((p) => p.type === type && !p.dockedIn)
    .sort((a, b) => b.z - a.z)
}

function frontPanel(): Panel | null {
  const list = Object.values(usePanelStore.getState().panels).filter((p) => !p.dockedIn && p.type !== 'group')
  return list.sort((a, b) => b.z - a.z)[0] ?? null
}

/** The terminal panel showing a given badge number. */
function terminalByNumber(n: number): Panel | null {
  return (
    Object.values(usePanelStore.getState().panels).find(
      (p) => p.type === 'terminal' && !p.dockedIn && (p.props as TerminalProps).terminalNumber === n,
    ) ?? null
  )
}

/** The terminal panel currently running an agent of `kind` (joins agent verdicts → terminal runtime). */
function terminalByAgent(kind: string): Panel | null {
  const panels = usePanelStore.getState().panels
  const rts = useTerminalStore.getState().byPanel
  for (const [ptyId, v] of Object.entries(useAgentStore.getState().byPty)) {
    if (!v.active || v.kind !== kind) continue
    const rt = Object.values(rts).find((r) => r.ptyId === ptyId)
    const panel = rt ? panels[rt.panelId] : undefined
    if (panel) return panel
  }
  return null
}

/** Every real floating window (skips ground annotations + docked members). */
function allFloating(): Panel[] {
  return Object.values(usePanelStore.getState().panels).filter(
    (p) => !p.dockedIn && p.type !== 'region' && p.type !== 'label' && p.type !== 'group',
  )
}

function resolveTargets(target: Target): Panel[] {
  const store = usePanelStore.getState()
  if (target.sel === 'all') return allFloating()
  if (target.sel === 'last') {
    // "it / this / eso / esto / ciérralo": the panel we just touched — but if we haven't touched
    // anything yet (fresh session), fall back to the front-most panel so "cierra esto" still works.
    const p = (lastPanelId ? store.panels[lastPanelId] : undefined) ?? frontPanel() ?? undefined
    return p ? [p] : []
  }
  if (target.sel === 'front') {
    const p = frontPanel()
    return p ? [p] : []
  }
  if (target.sel === 'number') {
    const p = terminalByNumber(target.n)
    return p ? [p] : []
  }
  if (target.sel === 'agent') {
    const p = terminalByAgent(target.kind)
    return p ? [p] : []
  }
  const list = panelsOfType(target.type)
  return target.scope === 'all' ? list : list.slice(0, 1)
}

function closePanel(p: Panel): void {
  killTerminalSession(p.id)
  usePanelStore.getState().removePanel(p.id)
  if (lastPanelId === p.id) lastPanelId = null
}

// ── Undo: each undoable command records how to revert it; "deshaz eso" pops + runs the latest. ──
interface UndoEntry {
  label: string
  run: () => void
}
const undoStack: UndoEntry[] = []
function pushUndo(label: string, run: () => void): void {
  undoStack.push({ label, run })
  if (undoStack.length > 25) undoStack.shift()
}
/** Snapshot floating-panel rects (pos + size) so an arrange — which also normalizes sizes — can be
 *  fully reverted. */
function snapshotPositions(): Array<{ id: string; rect: Rect }> {
  return allFloating().map((p) => ({ id: p.id, rect: { ...p.rect } }))
}
function restorePositions(snap: Array<{ id: string; rect: Rect }>): void {
  const store = usePanelStore.getState()
  const ui = useUiStore.getState()
  ui.setArranging(true)
  for (const s of snap) if (store.panels[s.id]) store.resizePanel(s.id, s.rect)
  window.setTimeout(() => ui.setArranging(false), 380)
}

export function executeIntent(intent: Intent): ActionResult {
  switch (intent.kind) {
    case 'none':
      return { ok: false, summary: '' }

    case 'create': {
      const { type, count, text, bootCommand, url, noun } = intent
      const store = usePanelStore.getState()
      // Snapshot existing panels' rects BEFORE we create + organize, so undo can fully revert (close
      // the new panels AND restore the others to where/what size they were).
      const before = snapshotPositions()
      const created: string[] = []
      for (let i = 0; i < count; i++) {
        const id = addPanelAtCenter(type)
        created.push(id)
        if (type === 'terminal' && bootCommand) store.updateProps<'terminal'>(id, { bootCommand })
        if (type === 'browser' && url) store.updateProps<'browser'>(id, { url })
        if (text) applyText(id, type, text)
      }
      lastPanelId = created[created.length - 1] ?? null
      lastType = type
      // Tidy the canvas so the new panels land organized (snapped, non-overlapping) and framed.
      arrangeFloating({ fit: true })
      const label = pluralize(noun ?? PANEL_NOUN[type] ?? type, count)
      // Undo = close exactly the panels we just opened, then restore the others' prior rects.
      pushUndo(`opened ${label}`, () => {
        const s = usePanelStore.getState()
        for (const id of created) {
          const p = s.panels[id]
          if (p) closePanel(p)
        }
        restorePositions(before)
      })
      return { ok: true, summary: count > 1 ? `Opened ${count} ${label}` : `Opened ${label}` }
    }

    case 'arrange': {
      const before = snapshotPositions()
      arrangeFloating({ fit: true })
      pushUndo('organize', () => restorePositions(before))
      return { ok: true, summary: 'Organized the canvas' }
    }

    case 'launchAll': {
      const terms = Object.values(usePanelStore.getState().panels).filter((p) => p.type === 'terminal' && !p.dockedIn)
      // None open → just open one running the agent.
      if (terms.length === 0) {
        const id = addPanelAtCenter('terminal')
        usePanelStore.getState().updateProps<'terminal'>(id, { bootCommand: intent.command })
        lastPanelId = id
        lastType = 'terminal'
        arrangeFloating({ fit: true })
        return { ok: true, summary: `Opened ${intent.noun}` }
      }
      let n = 0
      for (const t of terms) {
        const props = t.props as TerminalProps
        const tabId = props.activeTabId ?? props.tabs?.[0]?.id
        const ptyId = tabId ? useTerminalStore.getState().byPanel[tabId]?.ptyId : undefined
        if (!ptyId) continue
        // Skip a terminal that already has an agent running (don't type into its prompt).
        if (useAgentStore.getState().byPty[ptyId]?.active) continue
        window.plano.terminal.write(ptyId, `${intent.command}\r`)
        n++
      }
      return n > 0
        ? { ok: true, summary: `Launched ${intent.noun} in ${n} terminal${n > 1 ? 's' : ''}` }
        : { ok: false, summary: `${intent.noun} already running in every terminal` }
    }

    case 'space': {
      const { spaces, activeId } = useSpacesStore.getState()
      const cur = Math.max(0, spaces.findIndex((s) => s.id === activeId))
      const nameOf = (i: number): string => spaces[i]?.name || 'workspace'
      const go = (idx: number): ActionResult => {
        if (spaces[idx]?.id === activeId) return { ok: true, summary: `Already on ${nameOf(idx)}` }
        const prev = activeId
        switchSpace(spaces[idx].id)
        if (prev) pushUndo('switch workspace', () => switchSpace(prev))
        return { ok: true, summary: `Switched to ${nameOf(idx)}` }
      }
      switch (intent.op) {
        case 'new': {
          const id = createNewSpace()
          pushUndo('new workspace', () => void deleteSpace(id, { skipConfirm: true }))
          return { ok: true, summary: 'New workspace' }
        }
        case 'close': {
          if (!activeId) return { ok: false, summary: 'No workspace open' }
          const name = nameOf(cur)
          // Closing a workspace ends its terminals and can't be undone — so ASK first (an app
          // confirm). This prevents a misheard command from deleting a workspace you wanted to keep.
          void deleteSpace(activeId, { skipConfirm: false })
          return { ok: true, summary: `Close ${name}? Confirm in the dialog` }
        }
        case 'next':
          if (spaces.length < 2) return { ok: false, summary: 'Only one workspace' }
          return go((cur + 1) % spaces.length)
        case 'prev':
          if (spaces.length < 2) return { ok: false, summary: 'Only one workspace' }
          return go((cur - 1 + spaces.length) % spaces.length)
        case 'goto': {
          const idx = (intent.index ?? 0) - 1
          if (idx < 0 || idx >= spaces.length) return { ok: false, summary: `There's no workspace ${intent.index}` }
          return go(idx)
        }
      }
      return { ok: false, summary: '' }
    }

    case 'undo': {
      const entry = undoStack.pop()
      if (!entry) return { ok: false, summary: 'Nothing to undo' }
      try {
        entry.run()
      } catch {
        return { ok: false, summary: 'Couldn’t undo that' }
      }
      return { ok: true, summary: `Undid ${entry.label}` }
    }

    case 'close': {
      const targets = resolveTargets(intent.target)
      if (targets.length === 0) return { ok: false, summary: "Couldn't find that to close" }
      const noun = labelForTargets(intent.target, targets)
      targets.forEach(closePanel)
      // Don't re-organize on close (it would resize the remaining panels) — just remove them.
      return { ok: true, summary: `Closed ${noun}` }
    }

    case 'focus': {
      const targets = resolveTargets(intent.target)
      const p = targets[0]
      if (!p) return { ok: false, summary: "Couldn't find that" }
      focusPanel(p.id)
      lastPanelId = p.id
      lastType = p.type
      return { ok: true, summary: `Focused ${labelForTargets(intent.target, [p])}` }
    }

    case 'prompt': {
      const p = resolveTargets(intent.target)[0]
      if (!p || p.type !== 'terminal') return { ok: false, summary: "Couldn't find that terminal" }
      const props = p.props as TerminalProps
      const tabId = props.activeTabId ?? props.tabs?.[0]?.id
      const ptyId = tabId ? useTerminalStore.getState().byPanel[tabId]?.ptyId : undefined
      if (!ptyId) return { ok: false, summary: 'That terminal isn’t ready yet' }
      // Type the prompt at the live prompt and submit it (the agent running there picks it up).
      window.plano.terminal.write(ptyId, `${intent.text}\r`)
      focusPanel(p.id)
      lastPanelId = p.id
      lastType = 'terminal'
      return { ok: true, summary: `Sent to ${labelForTargets(intent.target, [p])}` }
    }

    case 'view': {
      const view = useViewportStore.getState()
      const center = { x: window.innerWidth / 2, y: window.innerHeight / 2 }
      switch (intent.action) {
        case 'fit':
          zoomToFitAll()
          return { ok: true, summary: 'Zoomed to fit' }
        case 'reset':
          view.zoomTo(1, vp())
          return { ok: true, summary: 'Zoom reset' }
        case 'zoomIn':
          view.zoomAt(center, 1.25)
          return { ok: true, summary: 'Zoomed in' }
        case 'zoomOut':
          view.zoomAt(center, 0.8)
          return { ok: true, summary: 'Zoomed out' }
      }
      return { ok: false, summary: '' }
    }

    case 'workspace':
      switch (intent.action) {
        case 'new':
          createNewSpace()
          return { ok: true, summary: 'New workspace' }
        case 'open':
          void openFolder()
          return { ok: true, summary: 'Opening folder…' }
        case 'save':
          void saveCurrent()
          return { ok: true, summary: 'Workspace saved' }
        case 'close': {
          const { activeId, spaces } = useSpacesStore.getState()
          if (!activeId) return { ok: false, summary: 'No workspace open' }
          const name = spaces.find((s) => s.id === activeId)?.name || 'workspace'
          void deleteSpace(activeId, { skipConfirm: false }) // ask first — closing can't be undone
          return { ok: true, summary: `Close ${name}? Confirm in the dialog` }
        }
      }
      return { ok: false, summary: '' }

    case 'toggle':
      switch (intent.what) {
        case 'minimap':
          useUiStore.getState().toggleMinimap()
          return { ok: true, summary: 'Toggled minimap' }
        case 'snapping':
          useUiStore.getState().toggleSnapping()
          return { ok: true, summary: 'Toggled snapping' }
        case 'palette':
          useUiStore.getState().toggleCommandPalette()
          return { ok: true, summary: 'Command palette' }
        case 'settings':
          useSettingsStore.getState().setOpen(true)
          return { ok: true, summary: 'Opened settings' }
      }
      return { ok: false, summary: '' }

    case 'query':
      return intent.what === 'agents' ? queryAgents() : queryPanels()

    case 'command':
      return { ok: false, summary: '' }

    case 'unknown':
      return { ok: false, summary: "Didn't catch a command" }
  }
}

function applyText(id: string, type: PanelType, text: string): void {
  const store = usePanelStore.getState()
  if (type === 'sticky') store.updateProps<'sticky'>(id, { text })
  else if (type === 'label') store.updateProps<'label'>(id, { text })
  else if (type === 'region') store.updateProps<'region'>(id, { label: text })
  else if (type === 'markdown') store.updateProps<'markdown'>(id, { content: text })
}

function labelForTargets(target: Target, targets: Panel[]): string {
  if (target.sel === 'all') return targets.length === 1 ? '1 panel' : `${targets.length} panels`
  if (target.sel === 'number') return `Terminal ${target.n}`
  if (target.sel === 'agent') return AGENTS[target.kind as keyof typeof AGENTS]?.displayName ?? 'agent'
  if (target.sel === 'type') {
    const noun = PANEL_NOUN[target.type] ?? target.type
    return target.scope === 'all' ? `${targets.length} ${pluralize(noun, targets.length)}` : noun
  }
  const t = targets[0]
  return PANEL_NOUN[t.type] ?? t.type
}

function queryAgents(): ActionResult {
  const verdicts = Object.values(useAgentStore.getState().byPty).filter((v) => v.active && v.kind)
  if (verdicts.length === 0) return { ok: true, summary: 'No agents running' }
  const names = [...new Set(verdicts.map((v) => AGENTS[v.kind!].displayName))]
  const summary = `${verdicts.length} agent${verdicts.length > 1 ? 's' : ''}: ${names.join(', ')}`
  return { ok: true, summary, spoken: summary }
}

function queryPanels(): ActionResult {
  const panels = Object.values(usePanelStore.getState().panels).filter((p) => !p.dockedIn && p.type !== 'group')
  const counts = new Map<PanelType, number>()
  for (const p of panels) counts.set(p.type, (counts.get(p.type) ?? 0) + 1)
  if (counts.size === 0) return { ok: true, summary: 'Canvas is empty' }
  const parts = [...counts.entries()].map(([t, n]) => `${n} ${pluralize(PANEL_NOUN[t] ?? t, n)}`)
  const summary = parts.join(', ')
  return { ok: true, summary, spoken: summary }
}

/** Reset conversation memory (e.g. on workspace switch). */
export function resetVoiceContext(): void {
  lastPanelId = null
  lastType = null
}

export { lastType }
