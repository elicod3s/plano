import { memo, useEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
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
import { useSelectionStore } from '@/stores/useSelectionStore'
import { PanelOrigin } from './PanelOrigin'
import { useCanvasFocusStore } from '@/stores/useCanvasFocusStore'
import { useMeshArrival } from '@/stores/useMeshLinks'
import { useUiStore } from '@/stores/useUiStore'
import { FOCUS_ROOT_ID } from '@/chrome/FocusStage'

import { viewportController } from '@/canvas/ViewportController'
import { useSnapStore } from '@/stores/useSnapStore'
import { computeDockTarget, dockPanel } from '@/app/dockActions'
import { scheduleAutosave } from '@/app/autosave'
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
import { stickyToneColor } from '@/panels/sticky/stickyThemes'
import { AgentTitle } from '@/panels/terminal/AgentTitle'
import { TerminalGitChip } from '@/panels/terminal/TerminalGitChip'
import { getPanelComponent } from './PanelRegistry'
import { prefersReducedMotion } from '@/lib/motion'

const GRID = 8
const MIN_W = 200
const MIN_H = 120
/**
 * Resting opacity for a surface that is neither focused, hovered nor selected. Nudged up from
 * 0.75 because the recede no longer rides on opacity alone — the edge dims with it now, so less
 * fade buys the same distance while a background terminal stays readable.
 */
export const UNFOCUSED_OPACITY = 0.78
/** Terminal drags arm on pointer-down but reveal the ghost only after the pointer has
 *  traveled this far in SCREEN px — a plain click must never flicker the panel (§5.1). */
const MOVE_THRESHOLD_PX = 5
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
  const resetPanelSize = usePanelStore((s) => s.resetPanelSize)
  const bringToFront = usePanelStore((s) => s.bringToFront)
  const remove = usePanelStore((s) => s.removePanel)
  const setTitle = usePanelStore((s) => s.setTitle)
  const toggleLock = usePanelStore((s) => s.toggleLock)
  const isFront = usePanelStore((s) => s.zCounter === panel.z)
  // Narrow focus subscription: this surface is the focused one when the transient canvas focus
  // store points at its surface id. The selector returns a boolean, so unaffected surfaces bail
  // out of re-rendering (no re-render cascade) when focus moves elsewhere.
  const focused = useCanvasFocusStore((s) => s.focus?.surfaceId === panel.id)
  // Focus mode: this panel fills the canvas. The shell is PORTALED into the stage rather than
  // re-rendered there, so the terminal inside keeps its xterm instance and its PTY attachment.
  const isFocusMode = useUiStore((s) => s.focusedPanelId === panel.id)
  // Same narrow-selector trick for the marquee selection: a boolean, and only while MORE than one
  // panel is selected, so a normal single click never re-renders a panel for a ring it won't draw.
  // Deliberate selection only — a plain click sets an implicit one-panel selection so a drag knows
  // its subject, and painting that would put a gold ring around every panel you touch.
  const multiSelected = useSelectionStore((s) => s.explicit && s.ids.includes(panel.id))
  // Hover is LOCAL state so a pointer move over one panel never touches another (and never runs
  // on pointer-move frames — only on enter/leave state changes).
  const [hovered, setHovered] = useState(false)
  // Plan F7: one-shot accent border flash when a mesh message arrives in this panel.
  const arrival = useMeshArrival(panel.id)
  const snapping = useUiStore((s) => s.snapping)
  // True briefly while Odla auto-arranges the canvas — eases every panel to its new slot.
  const arranging = useUiStore((s) => s.arranging)
  const locked = !!panel.locked

  // A terminal panel hosts one or more terminals (tabs); the chrome (agent morph, title, controls)
  // reflects the ACTIVE tab. Resolve its terminal id from the panel props, then read the store.
  const terminalProps = panel.type === 'terminal' ? (panel.props as TerminalProps) : null
  const activeTermId = terminalProps
    ? terminalProps.activeTabId ?? terminalProps.tabs?.[0]?.id ?? null
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
  const [mountAnim, setMountAnim] = useState(true)
  const [closing, setClosing] = useState(false)
  const [settling, setSettling] = useState(false)
  const [gesturing, setGesturing] = useState(false)
  const closeTimer = useRef<number | null>(null)
  const settleTimer = useRef<number | null>(null)
  // Pointer devices can emit far more events than the display can present. Keep only the
  // latest coordinates and do snapping + the global store mutation at most once per frame.
  const gestureRaf = useRef(0)
  const pendingPointer = useRef<{ x: number; y: number } | null>(null)

  const meta = PANEL_META[panel.type]
  const gesture = useRef<{
    kind: 'move' | ResizeDir
    /** §5.1 drag state machine: every move ARMS on pointer-down and only starts tracking after
     *  MOVE_THRESHOLD_PX of screen travel, so a plain click never twitches the panel. Resizes
     *  and all non-move gestures stay direct. */
    phase?: 'armed' | 'dragging'
    sx: number
    sy: number
    start: Rect
    canvasRect: DOMRect | null
    dock?: { targetId: string; side: DockSide }
    /** Other selected panels moving with this one, with the rect each started from. */
    followers?: { id: string; start: Rect }[]
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
    if (gestureRaf.current) window.cancelAnimationFrame(gestureRaf.current)
  }, [])

  // Actually destroy the panel: end its terminal session (kills the PTY — a real close, unlike a
  // space switch which keeps it alive) THEN remove it from the store. No-op kill for non-terminals.
  const commitClose = (): void => {
    killTerminalSession(panel.id)
    remove(panel.id)
  }

  // Play the collapse animation; the panel is removed from the store when it finishes (or
  // via the reduced-motion fallback timer). The whole visual shell animates as ONE piece.
  const startClose = (): void => {
    setClosing(true)
    closeTimer.current = window.setTimeout(commitClose, prefersReducedMotion() ? 0 : 320)
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
    if (locked || isFocusMode) return // a panel that fills the stage has nowhere to be dragged
    if ((e.target as HTMLElement).closest('.app-no-drag, input, textarea, button')) return
    e.preventDefault()
    // The anchor's pointerdown-capture already focused the surface (every primary click does).
    bringToFront(panel.id)
    cancelSettle()
    pendingPointer.current = null
    // §5.1: every move ARMS on pointer-down (nothing moves until the pointer travels
    // MOVE_THRESHOLD_PX), so a plain click never twitches the panel. The panel is dragged
    // DIRECTLY — live translate of the anchor, exactly like the pre-glass build the user
    // verified as correct (no ghost overlay, no source hiding).
    const canvasEl = (e.currentTarget as HTMLElement).closest('[data-canvas-background]') as HTMLElement | null
    // Multi-drag: remember where every OTHER selected panel started, so the same world delta can
    // be applied to all of them. Captured once per gesture — the set cannot change mid-drag.
    const selection = useSelectionStore.getState().ids
    const panels = usePanelStore.getState().panels
    const followers =
      selection.length > 1 && selection.includes(panel.id)
        ? selection
            .filter((id) => id !== panel.id && panels[id] && !panels[id].dockedIn)
            .map((id) => ({ id, start: { ...panels[id].rect } }))
        : []
    gesture.current = {
      kind: 'move',
      phase: 'armed',
      sx: e.clientX,
      sy: e.clientY,
      start: { ...panel.rect },
      canvasRect: canvasEl?.getBoundingClientRect() ?? null,
      followers,
    }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }

  const beginResize = (dir: ResizeDir) => (e: React.PointerEvent): void => {
    if (locked) return
    e.preventDefault()
    e.stopPropagation()
    // The anchor's pointerdown-capture already focused the surface; resize bands keep working from
    // an unfocused state because the focus change never blocks the gesture.
    bringToFront(panel.id)
    cancelSettle()
    setGesturing(true)
    pendingPointer.current = null
    gesture.current = { kind: dir, sx: e.clientX, sy: e.clientY, start: { ...panel.rect }, canvasRect: null }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }

  const applyPointerMove = (clientX: number, clientY: number): void => {
    const g = gesture.current
    if (!g) return
    // §5.1: an armed move stays inert until the pointer leaves the 5-screen-px radius — a
    // plain click must never twitch the panel. While armed, no snapping previews are drawn.
    if (g.kind === 'move' && g.phase === 'armed') {
      if (Math.hypot(clientX - g.sx, clientY - g.sy) <= MOVE_THRESHOLD_PX) return
      g.phase = 'dragging'
      setGesturing(true)
    }
    const zoom = viewportController.getLive().zoom
    const dx = (clientX - g.sx) / zoom
    const dy = (clientY - g.sy) / zoom

    // Direct manipulation for every panel type (pre-glass behavior): the live panel — xterm
    // included — translates with the pointer. Pure translate3d on the anchor is compositor-only
    // (crisp); no scale is ever applied, which is what kept the terminal sharp while dragging.
    const positionMovingPanel = (x: number, y: number): void => {
      move(panel.id, Math.round(x), Math.round(y))
      // The rest of the selection rides the SAME delta from its own start rect, so the group keeps
      // its relative layout (and never accumulates rounding drift frame over frame).
      const ddx = Math.round(x) - g.start.x
      const ddy = Math.round(y) - g.start.y
      for (const follower of g.followers ?? []) {
        move(follower.id, follower.start.x + ddx, follower.start.y + ddy)
      }
    }

    if (g.kind === 'move') {
      const px = g.start.x + dx
      const py = g.start.y + dy

      if (!snapping) {
        positionMovingPanel(px, py)
        return
      }

      const cr = g.canvasRect

      // Dock (merge) wins when the cursor is OVER another panel/group.
      if (cr) {
        const vp = viewportController.getLive()
        const world = screenToWorld({ x: clientX - cr.left, y: clientY - cr.top }, { x: vp.x, y: vp.y, zoom: vp.zoom })
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
          positionMovingPanel(px, py)
          return
        }
        g.dock = undefined
      }

      // Windows-style zone wins when the cursor reaches the viewport border.
      const zone = cr
        ? computeSnapZone(
            { x: clientX - cr.left, y: clientY - cr.top },
            { width: cr.width, height: cr.height },
            { edge: ZONE_EDGE, corner: ZONE_CORNER },
          )
        : null
      if (zone) {
        useSnapStore.getState().show({ zone })
        positionMovingPanel(px, py)
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
      positionMovingPanel(res.x, res.y)
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

  const flushPointerMove = (): void => {
    if (gestureRaf.current) {
      window.cancelAnimationFrame(gestureRaf.current)
      gestureRaf.current = 0
    }
    const pending = pendingPointer.current
    pendingPointer.current = null
    if (pending) applyPointerMove(pending.x, pending.y)
  }

  const onPointerMove = (e: React.PointerEvent): void => {
    if (!gesture.current) return
    pendingPointer.current = { x: e.clientX, y: e.clientY }
    if (gestureRaf.current) return
    gestureRaf.current = window.requestAnimationFrame(() => {
      gestureRaf.current = 0
      const pending = pendingPointer.current
      pendingPointer.current = null
      if (pending) applyPointerMove(pending.x, pending.y)
    })
  }

  // §5.1 / F2.6: abort an in-flight gesture without committing anything — restore full
  // source opacity, unmount the ghost and leave the panel exactly where it was. Covers
  // pointercancel, lostpointercapture and the Escape key.
  const cancelGesture = (): void => {
    const g = gesture.current
    if (!g) return
    if (gestureRaf.current) {
      window.cancelAnimationFrame(gestureRaf.current)
      gestureRaf.current = 0
    }
    pendingPointer.current = null
    // Direct drag: the store already followed the pointer — put the panel back where the
    // gesture started (Escape / pointercancel / lostpointercapture never commit).
    if (g.kind === 'move') move(panel.id, g.start.x, g.start.y)
    gesture.current = null
    setGesturing(false)
    useSnapStore.getState().clear()
  }

  const endGesture = (): void => {
    // Pointer-up on an armed (never-dragged) move is a plain click: nothing moved, so there
    // is no commit — clean up. This also swallows the final pending frame, which could
    // otherwise cross the threshold after the fact.
    if (gesture.current?.phase === 'armed') {
      cancelGesture()
      return
    }
    // Pointer-up can beat the final scheduled frame. Commit that last coordinate so the
    // panel never jumps backward or drops at the previous snap target.
    flushPointerMove()
    const g = gesture.current
    const dock = g?.dock
    const zone = useSnapStore.getState().zone
    gesture.current = null
    setGesturing(false)
    useSnapStore.getState().clear()
    // Workspace autosave happens on GESTURE END, not on every panel-store write (plan D5):
    // a drag used to schedule 60 saves per second; the debounce made them harmless but the
    // per-frame churn of store listeners was real. Non-gesture mutations still flush on
    // beforeunload and the camera-settle subscription.
    scheduleAutosave()

    // Dock (merge into a group) takes priority — this panel becomes docked and its frame unmounts.
    if (g && g.kind === 'move' && dock) {
      dockPanel(panel.id, dock.targetId, dock.side)
      return
    }
    if (g && g.kind === 'move' && zone) {
      const { x, y, zoom: z } = viewportController.getLive()
      const worldRect = zoneToWorldRect(zone.rect, { x, y, zoom: z })
      setSettling(true)
      resize(panel.id, worldRect)
      if (settleTimer.current) window.clearTimeout(settleTimer.current)
      settleTimer.current = window.setTimeout(() => setSettling(false), 240)
    } else if (g && g.kind !== 'move') {
      const finalRect = usePanelStore.getState().panels[panel.id]?.rect ?? panel.rect
      saveSize(
        panel.type,
        { width: finalRect.width, height: finalRect.height },
        meta.defaultSize,
      )
    }
  }

  // Escape cancels any in-flight gesture (never commits). Registered once; the ref guard
  // makes it a no-op when no gesture is active.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && gesture.current) cancelGesture()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const statusColor =
    panel.type === 'terminal'
      ? termStatus === 'exited'
        ? 'var(--status-error)'
        : agentActive
          ? agentAccent ?? 'var(--status-active)'
          : terminalAccent ?? 'var(--status-ready)'
      : 'var(--status-ready)'

  // Sticky notes are full-bleed tone glass (the design's amber sticky): the frame owns NO
  // padding/gap and its border carries the tone color, so the note reads as one surface.
  const isSticky = panel.type === 'sticky'
  const stickyTone = isSticky ? stickyToneColor((panel.props as { tone?: string }).tone as never) : null

  // ONE transformed box per panel (PLAN_OPTICAL_GLASS_UNIFIED_RENDER §6.1): the same node
  // Anchor: WORLD POSITION ONLY (the camera lives permanently on the world layer). The
  // anchor is the ONLY node whose transform changes during a drag — material, border,
  // header and content all live in the visual shell below and move as one piece.
  const anchorStyle: CSSProperties = {
    left: 0,
    top: 0,
    width: panel.rect.width,
    height: panel.rect.height,
    transform: `translate3d(${panel.rect.x}px, ${panel.rect.y}px, 0)`,
    transformOrigin: '0 0',
    zIndex: zIndex ?? panel.z,
    transition:
      settling || arranging
        ? 'transform 320ms var(--ease-settle), width 320ms var(--ease-settle), height 320ms var(--ease-settle)'
        : undefined,
    willChange: gesturing || settling || arranging ? 'transform, width, height' : undefined,
  }
  if (agentAccent) (anchorStyle as Record<string, string>)['--agent-accent'] = agentAccent

  // Visual shell: the ENTIRE window (material + border + shadow + header + content). Entry
  // and exit animations live here as one piece; nothing inside moves independently.
  const shellAnim = closing ? 'animate-panel-out' : mountAnim ? 'animate-panel-in' : ''
  const dragging = gesturing && gesture.current?.kind === 'move'
  // Resting opacity: focused, hovered OR marquee-selected → awake; everything else rests dim.
  // Selection counts as awake because picking a panel out of the canvas and having it stay faded
  // reads as "nothing happened" — the act of selecting is what should bring it forward.
  // Content and shell dim together (opacity sits on the whole shell); mounting/closing panels
  // keep their animation.
  const dimmed = !mountAnim && !closing && !focused && !hovered && !multiSelected
  const shellStyle: CSSProperties = {
    // Focus mode: the shell stops obeying the panel's canvas rect and fills the stage. `position`
    // flips to relative so `inset-0` inside the portal host resolves against the stage, not the
    // (now irrelevant) anchor.
    ...(isFocusMode ? { position: 'relative' as const, width: '100%', height: '100%' } : null),
    borderRadius: isSticky ? 24 : 26,
    opacity: dimmed ? UNFOCUSED_OPACITY : 1,
    // Direct drag (pre-glass behavior): NO lift transform, NO scale on the shell while moving.
    // The panel translates via its anchor's pure translate3d (compositor-only, crisp); a
    // fractional scale here was the original cause of the terminal text re-rasterizing while
    // dragging. The shell itself stays untransformed.
    transform: undefined,
    transformOrigin: '50% 50%',
    // Asymmetric by intent: waking is a RESPONSE to the user and lands almost immediately, while
    // receding is ambient and takes its time — the same way a surface you stop touching settles
    // rather than snaps. One symmetric 180ms curve for both is what made the effect feel cheap.
    // Edge and halo ride the same timing as the opacity so a panel changes state as one object.
    transition:
      !mountAnim && !closing
        ? [
            `transform ${dragging ? 140 : 240}ms cubic-bezier(0.22, 1, 0.36, 1)`,
            `opacity ${dimmed ? 300 : 130}ms var(--ease-settle)`,
            `border-color ${dimmed ? 300 : 130}ms var(--ease-settle)`,
            `box-shadow ${dimmed ? 320 : 190}ms var(--ease-settle)`,
          ].join(', ')
        : undefined,
    willChange: dragging ? 'transform' : undefined,
    // NO `content-visibility: auto` here. Chromium decides "relevant to the user" from a
    // viewport intersection computed in the compositor lifecycle; inside this canvas the
    // panel lives in a SCALED, `will-change: transform`-promoted world layer, so that
    // intersection is stale exactly while the panel moves — the shell blanked mid-drag and
    // popped back on settle. Isolation comes from `contain: layout paint style` on
    // `.surface-layer--panel` (globals.css), which has none of that behavior.
  }
  if (agentAccent) {
    // Agent panel: a quiet tinted border only. No glow, no inner ring, no bright top
    // line — just the edge carrying the brand color at a restrained alpha, so the panel
    // reads as "this window belongs to the agent" without shouting.
    const a = isFront ? 45 : 34
    shellStyle.borderColor = `color-mix(in srgb, ${agentAccent} ${a}%, transparent)`
  } else if (stickyTone) {
    shellStyle.borderColor = `color-mix(in srgb, ${stickyTone} 45%, transparent)`
    shellStyle.background = `color-mix(in srgb, var(--layer-panel-bg) 84%, ${stickyTone})`
  } else if (terminalAccent) {
    shellStyle.borderColor = `color-mix(in srgb, ${terminalAccent} ${isFront ? 42 : 32}%, transparent)`
  }

  // In focus mode the shell is PORTALED into the stage: same React element, new DOM parent, so the
  // xterm/CodeMirror instance inside is never unmounted (a remount would drop the PTY attachment
  // and replay the whole scrollback). The anchor stays in the canvas holding this component's
  // place, which is also what makes leaving focus instant — nothing is rebuilt.
  const focusHost = isFocusMode ? document.getElementById(FOCUS_ROOT_ID) : null

  return (
    <div
      className="absolute"
      style={anchorStyle}
      onPointerDownCapture={(e) => {
        bringToFront(panel.id)
        // Deska parity: every primary pointer-down on the surface is a focus action — refocusing
        // an ALREADY-focused panel (e.g. after an overlay/palette stole DOM focus) still bumps the
        // epoch. Header buttons/inputs (.app-no-drag) are excluded so close/lock/title-edit never
        // refocus; the unfocused shield consumes the event so this never reaches the content.
        if (e.button === 0 && !(e.target as HTMLElement).closest('.app-no-drag, input, textarea, button')) {
          useCanvasFocusStore.getState().focusSurface(panel.id, panel.id)
          // Canvas selection follows the click: shift/ctrl toggles this panel in or out, a plain
          // click makes it the selection UNLESS it already belongs to one — grabbing a member of a
          // multi-selection must keep the group intact so the whole set can be dragged.
          if (e.shiftKey || e.ctrlKey || e.metaKey) useSelectionStore.getState().toggle(panel.id)
          else useSelectionStore.getState().selectOnly(panel.id)
        }
      }}
      onPointerMove={onPointerMove}
      onPointerUp={endGesture}
      onPointerCancel={cancelGesture}
      onLostPointerCapture={cancelGesture}
    >
      {focusHost ? createPortal(shellWrapper(), focusHost) : shellWrapper()}
    </div>
  )

  /** The panel's whole visual shell — rendered in place, or portaled into the focus stage. */
  function shellWrapper() {
    return (
      <div
        data-surface-layer="panel"
        data-panel-type={panel.type}
        data-panel-active={isFront ? 'true' : 'false'}
        data-panel-focused={focused ? 'true' : 'false'}
        data-panel-selected={multiSelected ? 'true' : 'false'}
        className={cn(
          'surface-layer surface-layer--panel group absolute inset-0 flex flex-col overflow-hidden',
          isFront && 'surface-layer--front',
          // Selection is drawn by the shell material itself (globals.css, [data-panel-selected]):
          // an accent edge plus a soft outer halo. The old flat 1px ring sat on top of the panel's
          // own border as a second contour and read as a debug outline rather than a picked object.
          panel.type === 'sticky' && 'rounded-[24px]',
          shellAnim,
          closing && 'pointer-events-none',
        )}
        style={shellStyle}
        onAnimationEnd={onInnerAnimationEnd}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        {/* Plan F7: mesh arrival highlight — a one-shot accent border fade when a message
            lands in this panel. Pure CSS animation, no per-frame React. */}
        {arrival && !closing && (
          <div
            key={arrival.id}
            aria-hidden
            className={arrival.dim ? 'mesh-arrival mesh-arrival--dim pointer-events-none absolute inset-0' : 'mesh-arrival pointer-events-none absolute inset-0'}
            style={{ boxShadow: `inset 0 0 0 1.5px ${arrival.color}` }}
          />
        )}
        {/* agent-mode: the tinted border + the shell's inset ring already draw the agent
            outline — the old extra breathe ring stacked a second accent contour (the
            visible "duplicated colors" bug), so there is no separate breathe overlay. */}
        {/* agent-mode: a one-shot scan hairline on detection */}
        {agentActive && !closing && (
          <div
            key="scan"
            className="animate-agent-scan pointer-events-none absolute left-0 right-0 z-10 h-px"
            style={{ background: 'color-mix(in srgb, var(--accent-primary) 45%, transparent)' }}
          />
        )}

        {/* header — full-width professional bar (comfortable padding, no cramping) */}
        <div
          className={cn(
            'relative flex w-full shrink-0 items-center gap-3 border-b border-glass px-4',
            locked ? 'cursor-default' : 'cursor-grab active:cursor-grabbing',
          )}
          style={{
            height: 'var(--density-head, 34px)',
            background: 'var(--layer-panel-header-bg)',
            boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.08)',
          }}
          onPointerDown={beginMove}
          onDoubleClick={() => setEditingTitle(true)}
        >
          <span className="datum-grip shrink-0 group-hover:[&>span]:bg-[var(--text-secondary)]">
            {Array.from({ length: 6 }).map((_, i) => (
              <span key={i} />
            ))}
          </span>
          <span className="h-1.5 w-1.5 shrink-0 rounded-pill" style={{ background: statusColor }} />

          {/* Persistent terminal index — TYPESET, not badged. */}
          {panel.type === 'terminal' &&
            typeof (panel.props as TerminalProps).terminalNumber === 'number' && (
              <span
                title={`Terminal ${(panel.props as TerminalProps).terminalNumber}`}
                aria-label={`Terminal ${(panel.props as TerminalProps).terminalNumber}`}
                className="inline-flex shrink-0 select-none items-baseline font-mono leading-none transition-colors duration-150"
              >
                <span
                  aria-hidden
                  className={cn(
                    'text-[10px] tracking-label transition-colors duration-150',
                    isFront ? 'text-text-tertiary' : 'text-text-quaternary',
                  )}
                >
                  #
                </span>
                <span
                  className={cn(
                    'min-w-[0.9ch] text-center text-[13px] tabular-nums transition-colors duration-150',
                    isFront ? 'font-semibold text-text-primary' : 'font-medium text-text-secondary',
                  )}
                >
                  {(panel.props as TerminalProps).terminalNumber}
                </span>
              </span>
            )}

          {/* Provenance: this terminal was opened BY an agent, not by the user. A quiet mark
              rather than a badge — it is a fact about the panel's history, not its state, so it
              should be findable without ever competing with the live status dot beside it. The
              hover card carries the whole story. */}
          {panel.type === 'terminal' && (panel.props as TerminalProps).origin && (
            <PanelOrigin origin={(panel.props as TerminalProps).origin!} dim={!isFront} />
          )}

          {agentActive ? (
            <AgentTitle verdict={verdict} prompt={agentPrompt} accent={agentAccent} />
          ) : (
            <>
              <Icon name={meta.icon} size={15} className="shrink-0 text-text-2" />
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
                    className="app-no-drag min-w-0 flex-1 bg-transparent text-[15px] font-semibold text-text-primary focus:outline-none"
                  />
                ) : (
                  <>
                    <span className="min-w-0 shrink truncate text-[15px] font-semibold tracking-tightui text-text-1">
                      {panel.title}
                    </span>
                    {panel.type === 'terminal' && ptyId && activeTermId && (
                      <TerminalGitChip termId={activeTermId} />
                    )}
                  </>
                )}
              </div>
            </>
          )}


          {/* Header action cluster — reset/lock/close. */}
          <div
            className={cn(
              'app-no-drag flex shrink-0 items-center gap-0.5 transition-opacity group-hover:opacity-100',
              locked ? 'opacity-100' : 'opacity-60',
            )}
          >
            {!locked && (
              <IconButton
                // NOT `Scaling`: that glyph is a square with a diagonal arrow, which sits right
                // next to the focus button's diagonal arrows and read as the same action. A plain
                // rectangle-in-rectangle says "size" and nothing else.
                icon={'Proportions'}
                label={'Reset to default size'}
                size={26}
                onClick={() => resetPanelSize(panel.id)}
              />
            )}
            <IconButton
              icon={isFocusMode ? 'Minimize2' : 'Maximize2'}
              label={isFocusMode ? 'Exit focus (Esc)' : 'Focus this panel'}
              size={26}
              active={isFocusMode}
              onClick={() => useUiStore.getState().toggleFocusedPanel(panel.id)}
            />
            <IconButton
              icon={locked ? 'Lock' : 'LockOpen'}
              label={locked ? 'Unlock panel' : 'Lock panel (pin in place)'}
              size={26}
              active={locked}
              onClick={() => toggleLock(panel.id)}
            />
            <IconButton icon="X" label="Close panel" size={26} danger onClick={handleClose} />
          </div>
        </div>

        {/* body — selectable so text copies natively (Ctrl+C) from any panel.
            The body is ALWAYS mounted. Unmounting it off-screen destroyed real state the user
            expects to survive a pan (CodeMirror view + undo history, the Files tree's expanded
            directories and scroll), and the "off screen" placeholder was visible whenever the
            cull set lagged the camera. Per-panel isolation is handled by CSS containment. */}
        <div className="relative min-h-0 flex-1 select-text">
          <PanelBody panel={panel} />
          {/* Transparent first-click shield: consumes the first primary pointer-down on an
              unfocused surface so it never reaches xterm/CodeMirror/webview/buttons/links.
              Above the content, below the header drag + resize handles (z-10 < z-20). */}
          {!closing && <FocusShield surfaceId={panel.id} memberId={panel.id} />}
        </div>

        {/* resize handles — pointless while the panel fills the stage, so focus mode hides them */}
        {!locked && !isFocusMode && <ResizeHandles onBegin={beginResize} />}
      </div>
    )
  }
}

// Memoized so dragging or panning ONE panel doesn't re-render every other panel on the
// canvas. immer keeps un-touched panels' references stable, so their props stay shallow-equal
// and React skips them; the dragged panel's `panel` reference changes each tick, so it still
// updates. Internal zustand subscriptions (isFront, agent verdict, terminal controls) still
// trigger their own re-renders independently of memo.
export const PanelFrame = memo(PanelFrameInner)

// The panel BODY (xterm terminals, code editors, …) is the expensive subtree, and during a
// drag/resize only `rect`/`z` change — `props` stays reference-stable under immer. Memoize it
// on the fields the bodies actually read (type/props/title/locked/dockedIn) so a gesture
// repositions the frame WITHOUT re-rendering the body every pointermove — the difference
// between a 60fps drag and a stuttery one on low-end Windows GPUs.
const PanelBody = memo(
  function PanelBody({ panel }: { panel: Panel }) {
    const Body = getPanelComponent(panel.type)
    return <Body panel={panel} />
  },
  (a, b) =>
    a.panel.type === b.panel.type &&
    a.panel.props === b.panel.props &&
    a.panel.title === b.panel.title &&
    a.panel.locked === b.panel.locked &&
    a.panel.dockedIn === b.panel.dockedIn,
)

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

/**
 * Deska's transparent unfocused input shield (canvas-node-view overlay). Absolutely positioned by
 * its parent over a surface's CONTENT area; it is the mechanism that makes the first click on an
 * unfocused surface a pure focus action — capture alone does NOT prevent descendant activation,
 * but a sibling layer does: the pointer-down hits the shield, never the terminal/editor/browser
 * below. The parent (the surface frame) decides surface/member ids:
 *   - standalone panel:  surfaceId = panel.id, memberId = panel.id
 *   - dock group pane:   surfaceId = group panel id, memberId = clicked pane id
 *
 * Behavior:
 *   - primary pointer-down on an unfocused surface → the frame's anchor capture already focused
 *     the surface (bumping the epoch) and brought it to front; this layer CONSUMES the event so
 *     no character/click reaches xterm/CodeMirror/webview/buttons/links beneath;
 *   - right/middle pointer-down → focuses the surface too (Windows activation; the anchor capture
 *     only bumps for the primary button) but lets the browser finish the interaction (context
 *     menu / autoscroll) on the now-focused content;
 *   - `pointer-events: auto` only while unfocused — a focused surface passes straight through;
 *   - header drag and the z-20 resize bands sit ABOVE the shield (z-10) and stay usable;
 *   - an OS file drag hovering the surface disables the shield until the drag leaves/drops, so
 *     supported file/drop flows reach the content (and the canvas drop handler) as before;
 *   - aria-hidden, never focusable, visually transparent with Deska's 150ms ease transition.
 *
 * A DOM shield reliably intercepts Electron `<webview>` guests too (the guest composites INSIDE the
 * webview element box, which sits below this layer). If a future Electron version regresses that
 * hit-testing, the smallest fallback is the browser panel gating its own pointer events while
 * unfocused — same visible semantics, no shield change needed elsewhere.
 */
export function FocusShield({ surfaceId, memberId }: { surfaceId: string; memberId: string }) {
  const focused = useCanvasFocusStore((s) => s.focus?.surfaceId === surfaceId)
  // While an OS file drag hovers this surface, drop the shield so the drop can reach the content
  // (and the canvas root's drop handler) exactly as it would on a focused surface.
  const [dragOver, setDragOver] = useState(false)
  const dragDepth = useRef(0)

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (focused) return // pointer-events:none when focused; belt-and-suspenders guard
    if (e.button === 0) {
      // First primary click on an unfocused surface: swallow it so the content beneath never
      // activates. Focus + raise already happened in the frame anchor's pointerdown-capture.
      e.preventDefault()
      e.stopPropagation()
    } else {
      // Right/middle click: focus the surface (the capture only bumps for primary), but do not
      // cancel the interaction — the browser finishes it (context menu / autoscroll) on the
      // now-focused content.
      useCanvasFocusStore.getState().focusSurface(surfaceId, memberId)
    }
  }

  return (
    <div
      aria-hidden
      data-focus-shield="true"
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 10,
        pointerEvents: !focused && !dragOver ? 'auto' : 'none',
        opacity: focused ? 0 : 1,
        transition: 'opacity 150ms ease',
      }}
      onPointerDown={onPointerDown}
      onDragEnter={() => {
        dragDepth.current += 1
        if (!dragOver) setDragOver(true)
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1)
        if (dragDepth.current === 0 && dragOver) setDragOver(false)
      }}
      onDrop={() => {
        dragDepth.current = 0
        if (dragOver) setDragOver(false)
      }}
    />
  )
}
