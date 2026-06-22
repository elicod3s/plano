import { useRef } from 'react'
import { useTerminalStore } from '@/stores/useTerminalStore'
import { useAgentStore, selectVerdict } from '@/stores/useAgentStore'
import { useXterm } from './useXterm'
import { AgentLauncher } from './AgentLauncher'
import { TerminalControls } from './TerminalControls'

/**
 * ONE live terminal (the active tab of a terminal panel). Owns the padded/clipped container
 * (wheel + paste + context-menu) and the counter-scaled render box xterm is opened into; `useXterm`
 * attaches the `terminalEngine` session keyed by `termId`. On unmount (tab/space switch) the hook
 * DETACHES the DOM only — the xterm instance, its PTY and its scrollback stay alive in the registry,
 * so returning is a pure DOM re-parent (no buffered replay). The session is destroyed only when the
 * terminal is truly closed (via app/terminalSessions → terminalEngine.dispose).
 */
export function TerminalView({
  termId,
  panelId,
  bg,
}: {
  termId: string
  panelId: string
  bg: string
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const renderBoxRef = useRef<HTMLDivElement>(null)
  useXterm(termId, panelId, renderBoxRef, containerRef)

  const ptyId = useTerminalStore((s) => s.byPanel[termId]?.ptyId ?? null)
  const verdict = useAgentStore(selectVerdict(ptyId))

  return (
    <div className="relative min-h-0 flex-1">
      {/* Outer wrapper owns the padding (the natural margin) + theme background. The inner
          container is the positioned, clipped box the absolute render box fills — so the render box
          sits INSIDE the padding instead of covering it. */}
      <div className="flex h-full min-h-0 overflow-hidden" style={{ background: bg, padding: 8 }}>
        <div
          ref={containerRef}
          // data-wheel-own: xterm owns the wheel here so scrolling the buffer never pans the canvas.
          data-wheel-own
          className="relative min-h-0 min-w-0 flex-1 overflow-hidden"
        >
          {/* Render box (Deska model): xterm is opened into THIS element — see useXterm. */}
          <div ref={renderBoxRef} style={{ position: 'absolute', top: 0, left: 0 }} />
        </div>
      </div>
      {/* Clear / scroll-to-bottom — bottom-right toolbar, mirrors the Agents launcher. */}
      {ptyId && <TerminalControls termId={termId} />}
      {/* Quick-launch AI CLIs in this terminal; hidden once an agent is detected. */}
      {!verdict.active && ptyId && <AgentLauncher ptyId={ptyId} />}
    </div>
  )
}
