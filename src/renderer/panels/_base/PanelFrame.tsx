import { memo, useEffect, useRef, useState, type CSSProperties } from 'react'
import type { Panel, TerminalProps } from '@shared/domain/panel'
import { PANEL_META } from '@shared/domain/panel'
import { AGENTS } from '@shared/domain/agent'
import { screenToWorld, type Rect } from '@shared/domain/geometry'
import type { DockSide } from '@shared/domain/dock'
import {
  computeMoveSnap,
  computeResizeSnap,
  computeSnapZone,
  zoneToWorldRect,
} from '@shared/domain/snapping'
import { usePanelStore } from '@/stores/usePanelStore'
import { useUiStore } from '@/stores/useUiStore'
import { useViewportStore } from '@/stores/useViewportStore'
import { useSnapStore } from '@/stores/useSnapStore'
import { computeDockTarget, dockPanel } from '@/app/dockActions'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useTerminalStore } from '@/stores/useTerminalStore'
import { useAgentStore, selectVerdict, selectPrompt } from '@/stores/useAgentStore'
import { promptTerminalClose } from '@/stores/useTerminalClosePrompt'
import { killTerminalSession } from '@/app/terminalSessions'
import { Icon } from '@/design-system/Icon'
import { IconButton } from '@/design-system/IconButton'
import { cn } from '@/lib/cn'
import { saveSize } from '@/lib/panelSizes'
import { getTerminalThemeAccent } from '@/panels/terminal/terminalThemes'
import { AgentTitle } from '@/panels/terminal/AgentTitle'
import { AgentControls } from '@/panels/terminal/AgentControls'
import { TerminalGitChip } from '@/panels/terminal/TerminalGitChip'
import { getPanelComponent } from './PanelRegistry'

const GRID = 8
const MIN_W = 200
const MIN_H = 120
/** Magnet radius in SCREEN px (divided by zoom for world space, so it feels constant at any zoom). */
const SNAP_THRESHOLD_PX = 9
/** Max perpendicular gap in SCREEN px for two panels to count as adjacent — gates out far panels.
 *  Divided by zoom at the call sites so it tracks the magnet (a constant on-screen gap) at any zoom. */
const ADJ_MARGIN_PX = 24
/** Min perpendicular overlap in SCREEN px before a container is ringed / a co-edge guide is drawn.
 *  Abutments (flush touching edges) never draw a line — the touch is the feedback, like Windows. */
const MIN_GUIDE_OVERLAP_PX = 10
/** Windows-style zone arming: cursor within EDGE px of the viewport border; CORNER px = quadrant. */
const ZONE_EDGE = 26
const ZONE_CORNER = 110

type ResizeDir = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

/** Rects of every OTHER snap-eligible panel (real floating panels — not regions/labels/self). */
function otherRects(selfId: string): Rect[] {
  const panels = usePanelStore.getState().panels
  const out: Rect[] = []
  for (const id in panels) {
    if (id === selfId) continue
    const p = panels[id]
    if (p.type === 'region' || p.type === 'label' || p.dockedIn) continue
    out.push(p.rect)
  }
  return out
}

function PanelFrameInner({ panel, zIndex }: { panel: Panel; zIndex?: number }) {
  const move = usePanelStore((s) => s.movePanel)
  const resize = usePanelStore((s) => s.resizePanel)
  const bringToFront = usePanelStore((s) => s.bringToFront)
  const remove = usePanelStore((s) => s.removePanel)
  const setTitle = usePanelStore((s) => s.setTitle)
  const toggleLock = usePanelStore((s) => s.toggleLock)
  const isFront = usePanelStore((s) => s.zCounter === panel.z)
  const snapping = useUiStore((s) => s.snapping)
  const locked = !!panel.locked

  // A terminal panel hosts one or more terminals (tabs); the chrome (agent morph, title, controls)
  // reflects the ACTIVE tab. Resolve its terminal id from the panel props, then read the store.
  const activeTermId =
    panel.type === 'terminal'
      ? (panel.props as TerminalProps).activeTabId ?? (panel.props as TerminalProps).tabs?.[0]?.id ?? null
      : null
  const ptyId = useTerminalStore((s) => (activeTermId ? s.byPanel[activeTermId]?.ptyId ?? null : null))
  const termStatus = useTerminalStore((s) => (activeTermId ? s.byPanel[activeTermId]?.status : undefined))
  const terminalThemeDefault = useSettingsStore((s) => s.settings.terminal.theme)
  const verdict = useAgentStore(selectVerdict(ptyId))
  const agentPrompt = useAgentStore(selectPrompt(ptyId))
  const agentActive = verdict.active
  // The detected agent's brand color, applied to this panel's chrome only.
  const agentAccent = agentActive && verdict.kind ? AGENTS[verdict.kind].accent : null
  // A themed terminal tints its OWN panel chrome subtly — harmonious like the agent tint
  // and the workspace colors (the agent tint wins while an agent is active).
  const terminalAccent =
    panel.type === 'terminal' && !agentActive
      ? getTerminalThemeAccent((panel.props as TerminalProps).theme ?? terminalThemeDefault)
      : null

  const [editingTitle, setEditingTitle] = useState(false)
  // Canvas-panel life animations (chrome overlays deliberately get none of this):
  //  - mountAnim: subtle scale+fade-in on open
  //  - moving:    the wiggle while a move gesture is in progress
  //  - closing:   plays the genie/collapse, then actually removes the panel
  const [mountAnim, setMountAnim] = useState(true)
  const [moving, setMoving] = useState(false)
  const [closing, setClosing] = useState(false)
  // One-shot eased transition while a panel settles into a snap zone (Windows-style tile drop).
  const [settling, setSettling] = useState(false)
  const closeTimer = useRef<number | null>(null)
  const settleTimer = useRef<number | null>(null)

  const meta = PANEL_META[panel.type]
  const Body = getPanelComponent(panel.type)
  const gesture = useRef<{
    kind: 'move' | ResizeDir
    sx: number
    sy: number
    start: Rect
    canvasRect: DOMRect | null
    /** Set during a move when the cursor is over a dock target → committed on drop. */
    dock?: { targetId: string; side: DockSide }
  } | null>(null)

  // Let the open animation play once, then stop reserving the transform for it.
  useEffect(() => {
    const t = window.setTimeout(() => setMountAnim(false), 220)
    return () => window.clearTimeout(t)
  }, [])

  // Safety net so a closing panel is always removed even if animationend never fires
  // (e.g. prefers-reduced-motion disables the animation entirely).
  useEffect(() => () => {
    if (closeTimer.current) window.clearTimeout(closeTimer.current)
    if (settleTimer.current) window.clearTimeout(settleTimer.current)
  }, [])

  // Actually destroy the panel: end its terminal session (kills the PTY — a real close, unlike a
  // space switch which keeps it alive) THEN remove it from the store. No-op kill for non-terminals.
  const commitClose = (): void => {
    killTerminalSession(panel.id)
    remove(panel.id)
  }

  // Play the collapse animation; the panel is removed from the store when it finishes (or
  // via the reduced-motion fallback timer).
  const startClose = (): void => {
    setClosing(true)
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    closeTimer.current = window.setTimeout(commitClose, reduce ? 0 : 320)
  }

  // Guard closing a terminal that has a detected AI agent running, with an app-styled
  // confirm (skippable via Settings → General). A plain shell closes directly — only an
  // active agent (Claude Code, Codex, …) is worth a prompt, so normal terminals never nag.
  const handleClose = (): void => {
    if (closing) return
    const confirmOn = useSettingsStore.getState().settings.general.confirmClosePanelWithProcess
    if (confirmOn && panel.type === 'terminal' && agentActive) {
      const agentName = verdict.kind ? AGENTS[verdict.kind].displayName : 'An agent'
      void promptTerminalClose({
        agentName,
        agentIcon: verdict.kind ? AGENTS[verdict.kind].icon : 'Bot',
        ptyId,
        cwd: activeTermId ? useTerminalStore.getState().byPanel[activeTermId]?.cwd : undefined,
      }).then((ok) => {
        if (ok) startClose()
      })
      return
    }
    startClose()
  }

  const onInnerAnimationEnd = (e: React.AnimationEvent): void => {
    if (closing && e.animationName === 'panel-out') {
      if (closeTimer.current) window.clearTimeout(closeTimer.current)
      commitClose()
    }
  }

  // Abort an in-flight tile-drop settle so a fresh grab tracks the cursor 1:1 (no eased lag).
  const cancelSettle = (): void => {
    if (settleTimer.current) {
      window.clearTimeout(settleTimer.current)
      settleTimer.current = null
    }
    setSettling(false)
  }

  const beginMove = (e: React.PointerEvent): void => {
    if (locked) return
    if ((e.target as HTMLElement).closest('.app-no-drag, input, textarea, button')) return
    e.preventDefault()
    bringToFront(panel.id)
    cancelSettle()
    const canvasEl = (e.currentTarget as HTMLElement).closest('[data-canvas-background]') as HTMLElement | null
    gesture.current = {
      kind: 'move',
      sx: e.clientX,
      sy: e.clientY,
      start: { ...panel.rect },
      canvasRect: canvasEl?.getBoundingClientRect() ?? null,
    }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }

  const beginResize = (dir: ResizeDir) => (e: React.PointerEvent): void => {
    if (locked) return
    e.preventDefault()
    e.stopPropagation()
    bringToFront(panel.id)
    cancelSettle()
    gesture.current = { kind: dir, sx: e.clientX, sy: e.clientY, start: { ...panel.rect }, canvasRect: null }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e: React.PointerEvent): void => {
    const g = gesture.current
    if (!g) return
    // Read zoom lazily (only during an active drag) rather than as a render prop — passing the
    // live zoom in would change every panel's props on every wheel tick and defeat React.memo,
    // re-rendering the whole canvas during a pure zoom. A drag and a zoom never co-occur.
    const zoom = useViewportStore.getState().zoom
    const dx = (e.clientX - g.sx) / zoom
    const dy = (e.clientY - g.sy) / zoom

    if (g.kind === 'move') {
      // Start the wiggle only once the panel actually travels, so a plain click on the
      // header (press + release without dragging) doesn't flash it. setMoving(true) is a
      // no-op once already true, so this stays cheap during the drag.
      if (!moving) setMoving(true)
      const px = g.start.x + dx
      const py = g.start.y + dy

      if (!snapping) {
        move(panel.id, Math.round(px), Math.round(py))
        return
      }

      const cr = g.canvasRect

      // Dock (merge) wins when the cursor is OVER another panel/group: preview the "Drop to place"
      // region, keep following the cursor, and merge on drop.
      if (cr) {
        const vp = useViewportStore.getState()
        const world = screenToWorld({ x: e.clientX - cr.left, y: e.clientY - cr.top }, { x: vp.x, y: vp.y, zoom: vp.zoom })
        const target = computeDockTarget(panel.id, world)
        if (target) {
          g.dock = { targetId: target.targetId, side: target.side }
          const pr = target.previewWorld
          useSnapStore.getState().show({
            dock: {
              rect: { x: pr.x * vp.zoom + vp.x, y: pr.y * vp.zoom + vp.y, width: pr.width * vp.zoom, height: pr.height * vp.zoom },
              side: target.side,
            },
          })
          move(panel.id, Math.round(px), Math.round(py))
          return
        }
        g.dock = undefined
      }

      // Windows-style zone wins when the cursor reaches the viewport border: preview the tile,
      // keep the panel under the cursor, and commit the zone on drop.
      const zone = cr
        ? computeSnapZone(
            { x: e.clientX - cr.left, y: e.clientY - cr.top },
            { width: cr.width, height: cr.height },
            { edge: ZONE_EDGE, corner: ZONE_CORNER },
          )
        : null
      if (zone) {
        useSnapStore.getState().show({ zone })
        move(panel.id, Math.round(px), Math.round(py))
        return
      }

      // Otherwise: magnetic alignment / flush-join to nearby panels (grid as fallback).
      const res = computeMoveSnap(
        { x: px, y: py, width: panel.rect.width, height: panel.rect.height },
        otherRects(panel.id),
        {
          threshold: SNAP_THRESHOLD_PX / zoom,
          grid: GRID,
          gridSnap: true,
          adjMargin: ADJ_MARGIN_PX / zoom,
          minGuideOverlap: MIN_GUIDE_OVERLAP_PX / zoom,
        },
      )
      useSnapStore.getState().show({ guides: res.guides, targets: res.targets })
      move(panel.id, res.x, res.y)
      return
    }

    let { x, y, width, height } = g.start
    const dir = g.kind as ResizeDir
    if (dir.includes('e')) width = Math.max(MIN_W, g.start.width + dx)
    if (dir.includes('s')) height = Math.max(MIN_H, g.start.height + dy)
    if (dir.includes('w')) {
      width = Math.max(MIN_W, g.start.width - dx)
      x = g.start.x + (g.start.width - width)
    }
    if (dir.includes('n')) {
      height = Math.max(MIN_H, g.start.height - dy)
      y = g.start.y + (g.start.height - height)
    }

    if (!snapping) {
      resize(panel.id, { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) })
      return
    }
    const res = computeResizeSnap({ x, y, width, height }, dir, otherRects(panel.id), {
      threshold: SNAP_THRESHOLD_PX / zoom,
      grid: GRID,
      gridSnap: true,
      adjMargin: ADJ_MARGIN_PX / zoom,
      minGuideOverlap: MIN_GUIDE_OVERLAP_PX / zoom,
      minW: MIN_W,
      minH: MIN_H,
    })
    useSnapStore.getState().show({ guides: res.guides, targets: res.targets })
    resize(panel.id, res.rect)
  }

  const endGesture = (): void => {
    const g = gesture.current
    const dock = g?.dock
    const zone = useSnapStore.getState().zone
    gesture.current = null
    setMoving(false)
    useSnapStore.getState().clear()

    // Dock (merge into a group) takes priority — this panel becomes docked and its frame unmounts.
    if (g && g.kind === 'move' && dock) {
      dockPanel(panel.id, dock.targetId, dock.side)
      return
    }
    if (g && g.kind === 'move' && zone) {
      // Commit the Windows-style tile and let the outer box ease into place (settling transition).
      const { x, y, zoom: z } = useViewportStore.getState()
      const worldRect = zoneToWorldRect(zone.rect, { x, y, zoom: z })
      setSettling(true)
      resize(panel.id, worldRect)
      if (settleTimer.current) window.clearTimeout(settleTimer.current)
      settleTimer.current = window.setTimeout(() => setSettling(false), 240)
    } else if (g && g.kind !== 'move') {
      // Remember the size after a resize so new panels of this type reopen at it.
      saveSize(panel.type, { width: panel.rect.width, height: panel.rect.height })
    }
  }

  const statusColor =
    panel.type === 'terminal'
      ? termStatus === 'exited'
        ? 'var(--status-error)'
        : agentActive
          ? agentAccent ?? 'var(--status-active)'
          : terminalAccent ?? 'var(--status-ready)'
      : 'var(--status-ready)'

  // Outer = world-space positioning only. Keeping the translate3d here (and never animating
  // it) lets the inner wrapper own transform-based life animations that compose around the
  // panel's own center instead of fighting the world transform.
  const positionStyle: CSSProperties = {
    // Position via GPU transform (not left/top) so moving a panel composites cleanly.
    left: 0,
    top: 0,
    width: panel.rect.width,
    height: panel.rect.height,
    transform: `translate3d(${panel.rect.x}px, ${panel.rect.y}px, 0)`,
    zIndex: zIndex ?? panel.z,
    // Only the one-shot tile-drop eases; live dragging stays instant (no transition) so the
    // panel tracks the cursor 1:1.
    transition: settling
      ? 'transform 220ms var(--ease-settle), width 220ms var(--ease-settle), height 220ms var(--ease-settle)'
      : undefined,
    willChange: settling ? 'transform, width, height' : undefined,
  }
  if (agentAccent) (positionStyle as Record<string, string>)['--agent-accent'] = agentAccent

  // Inner = the visual chrome + life animations. Exactly one animation class runs at a time
  // (kept as utility classes so Tailwind always emits their @keyframes). Close wins; then the
  // move wiggle, then the open-in, then the agent breathe — so dragging an agent panel shows
  // the wiggle and its breathe glow resumes on drop.
  const innerAnim = closing
    ? 'animate-panel-out'
    : moving
      ? 'animate-panel-wiggle'
      : mountAnim
        ? 'animate-panel-in'
        : agentActive
          ? 'animate-agent-breathe'
          : ''

  const innerStyle: CSSProperties = {
    boxShadow: isFront ? 'var(--shadow-panel-focus)' : 'var(--shadow-panel)',
    willChange: moving || closing || mountAnim ? 'transform' : undefined,
  }
  if (agentAccent) innerStyle.borderColor = agentAccent
  else if (terminalAccent)
    innerStyle.borderColor = `color-mix(in srgb, ${terminalAccent} ${isFront ? 48 : 32}%, var(--border-strong))`

  return (
    <div
      className="absolute"
      style={positionStyle}
      onPointerDownCapture={() => bringToFront(panel.id)}
      onPointerMove={onPointerMove}
      onPointerUp={endGesture}
      onPointerCancel={endGesture}
    >
      <div
        className={cn(
          'group absolute inset-0 flex flex-col overflow-hidden rounded-lg border bg-surface-1',
          isFront ? 'border-strong' : 'border-subtle',
          innerAnim,
          closing && 'pointer-events-none',
        )}
        style={innerStyle}
        onAnimationEnd={onInnerAnimationEnd}
      >
      {/* agent-mode: a one-shot scan hairline on detection (no persistent white rail) */}
      {agentActive && !closing && (
        <div
          key="scan"
          className="animate-agent-scan pointer-events-none absolute left-0 right-0 z-10 h-px"
          style={{ background: 'color-mix(in srgb, var(--accent-primary) 45%, transparent)' }}
        />
      )}

      {/* header (drag handle — inert while the panel is locked) */}
      <div
        className={cn(
          'flex h-9 shrink-0 items-center gap-2 border-b border-subtle bg-surface-2 px-2.5',
          locked ? 'cursor-default' : 'cursor-grab active:cursor-grabbing',
        )}
        onPointerDown={beginMove}
        onDoubleClick={() => setEditingTitle(true)}
      >
        <span className="datum-grip shrink-0 group-hover:[&>span]:bg-[var(--text-secondary)]">
          {Array.from({ length: 6 }).map((_, i) => (
            <span key={i} />
          ))}
        </span>
        <span className="h-1.5 w-1.5 shrink-0 rounded-pill" style={{ background: statusColor }} />

        {agentActive ? (
          // Agent detected → Warp-style identity strip (brand + first prompt + Working/Done).
          // A plain shell never enters here, so a normal terminal keeps its usual title.
          <AgentTitle verdict={verdict} prompt={agentPrompt} accent={agentAccent} />
        ) : (
          <>
            <Icon name={meta.icon} size={14} className="shrink-0 text-text-secondary" />
            <div className="flex min-w-0 flex-1 items-center gap-2">
              {editingTitle ? (
                <input
                  autoFocus
                  defaultValue={panel.title}
                  onBlur={(e) => {
                    setTitle(panel.id, e.target.value || panel.title)
                    setEditingTitle(false)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                    if (e.key === 'Escape') setEditingTitle(false)
                  }}
                  className="app-no-drag min-w-0 flex-1 bg-transparent text-[13px] font-semibold text-text-primary focus:outline-none"
                />
              ) : (
                <>
                  {/* title shrinks/truncates so the git chip beside it stays visible */}
                  <span className="min-w-0 shrink truncate text-[13px] font-semibold text-text-primary">
                    {panel.title}
                  </span>
                  {/* per-terminal git/GitHub badge — in the chrome, next to the name (never over content) */}
                  {panel.type === 'terminal' && ptyId && activeTermId && (
                    <TerminalGitChip termId={activeTermId} />
                  )}
                </>
              )}
            </div>
          </>
        )}

        {/* Auto-approve guardrail — folded into the header (no separate bar) so it stays
            visible while an agent runs without spending a whole row on one toggle. */}
        {agentActive && <AgentControls />}

        {/* Header action cluster — generic panel chrome (pin + close). Terminal-specific
            controls (Clear, scroll-to-bottom) live at the bottom of the terminal body,
            beside the Agents launcher. Stays visible (not just on hover) while pinned. */}
        <div
          className={cn(
            'app-no-drag flex shrink-0 items-center gap-0.5 transition-opacity group-hover:opacity-100',
            locked ? 'opacity-100' : 'opacity-60',
          )}
        >
          <IconButton
            icon={locked ? 'Lock' : 'LockOpen'}
            label={locked ? 'Unlock panel' : 'Lock panel (pin in place)'}
            size={24}
            active={locked}
            onClick={() => toggleLock(panel.id)}
          />
          <IconButton icon="X" label="Close panel" size={24} danger onClick={handleClose} />
        </div>
      </div>

      {/* body — selectable so text copies natively (Ctrl+C) from any panel; panels that
          manage their own selection (terminal, editor, file tree) override locally. */}
      <div className="min-h-0 flex-1 select-text">
        <Body panel={panel} />
      </div>

      {/* resize handles (8-way) — suppressed while the panel is locked */}
      {!locked && <ResizeHandles onBegin={beginResize} />}
      </div>
    </div>
  )
}

// Memoized so dragging or panning ONE panel doesn't re-render every other panel on the
// canvas. immer keeps un-touched panels' references stable, so their props stay shallow-equal
// and React skips them; the dragged panel's `panel` reference changes each tick, so it still
// updates. Internal zustand subscriptions (isFront, agent verdict, terminal controls) still
// trigger their own re-renders independently of memo.
export const PanelFrame = memo(PanelFrameInner)

function ResizeHandles({ onBegin }: { onBegin: (dir: ResizeDir) => (e: React.PointerEvent) => void }) {
  const edge = 'absolute z-20'
  return (
    <>
      <div className={cn(edge, 'inset-x-2 top-0 h-1.5 cursor-ns-resize')} onPointerDown={onBegin('n')} />
      <div className={cn(edge, 'inset-x-2 bottom-0 h-1.5 cursor-ns-resize')} onPointerDown={onBegin('s')} />
      <div className={cn(edge, 'inset-y-2 left-0 w-1.5 cursor-ew-resize')} onPointerDown={onBegin('w')} />
      <div className={cn(edge, 'inset-y-2 right-0 w-1.5 cursor-ew-resize')} onPointerDown={onBegin('e')} />
      <div className={cn(edge, 'left-0 top-0 h-3 w-3 cursor-nwse-resize')} onPointerDown={onBegin('nw')} />
      <div className={cn(edge, 'right-0 top-0 h-3 w-3 cursor-nesw-resize')} onPointerDown={onBegin('ne')} />
      <div className={cn(edge, 'bottom-0 left-0 h-3 w-3 cursor-nesw-resize')} onPointerDown={onBegin('sw')} />
      <div className={cn(edge, 'bottom-0 right-0 h-3 w-3 cursor-nwse-resize')} onPointerDown={onBegin('se')} />
    </>
  )
}
