import { useTerminalControlStore } from '@/stores/useTerminalControlStore'
import { IconButton } from '@/design-system/IconButton'

/**
 * A compact glass toolbar pinned to the bottom-RIGHT of a terminal (the Agents launcher
 * sits centered at the bottom). Drives the live xterm through the controls `useXterm`
 * registered for this panel — so these actions sit on the terminal's edge, out of the way,
 * instead of crowding the panel header. Renders nothing until the xterm has registered.
 */
export function TerminalControls({ termId }: { termId: string }) {
  const controls = useTerminalControlStore((s) => s.byPanel[termId])
  if (!controls) return null

  return (
    <div
      className="app-no-drag pointer-events-auto absolute bottom-2.5 right-2.5 z-20 flex items-center gap-px rounded-pill border border-default p-0.5 opacity-70 shadow-popover transition-opacity hover:opacity-100"
      style={{ background: 'color-mix(in srgb, var(--surface-3) 82%, transparent)' }}
    >
      <IconButton icon="Eraser" label="Clear terminal" size={26} onClick={controls.clear} />
      <IconButton icon="ChevronsDown" label="Scroll to bottom" size={26} onClick={controls.scrollToBottom} />
    </div>
  )
}
