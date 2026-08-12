import { useRef } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '@/design-system/Icon'
import { useUsageStore } from '@/stores/useUsageStore'
import { usePanelStore } from '@/stores/usePanelStore'
import { confirm } from '@/stores/useConfirmStore'
import { useChipHover } from './useChipHover'

/**
 * Ports chip: listening ports owned by this workspace's terminals (`⇄ 3`). The popover lists
 * `:5173  vite  Terminal 2` with three actions: open in a browser panel, copy the URL, and kill
 * (destructive — confirmed first, then delegated to the host which only kills PIDs the bar
 * surfaced).
 */
export function PortsChip() {
  const ports = useUsageStore((s) => s.aux.ports)
  const chipRef = useRef<HTMLButtonElement>(null)
  const { open, triggerProps, popoverProps } = useChipHover()
  const count = ports.length

  const openInPlano = (port: number): void => {
    const url = `http://localhost:${port}`
    const existing = Object.values(usePanelStore.getState().panels).find(
      (p) => p.type === 'browser' && (p.props as { url?: string }).url === url,
    )
    if (existing) {
      usePanelStore.getState().bringToFront(existing.id)
      return
    }
    const id = usePanelStore.getState().addPanel('browser', undefined)
    usePanelStore.getState().updateProps<'browser'>(id, { url })
  }

  const copyUrl = (port: number): void => {
    void window.plano.clipboard.writeText(`http://localhost:${port}`)
  }

  const killOwner = async (port: number, pid: number, name: string): Promise<void> => {
    const ok = await confirm({
      title: 'Kill process',
      message: `Kill ${name} (PID ${pid}) owning port ${port}? This terminates the process tree.`,
      confirmLabel: 'Kill',
      danger: true,
    })
    if (!ok) return
    await window.plano.statusbar.killPortPid(pid).catch(() => undefined)
  }

  return (
    <>
      <button
        ref={chipRef}
        type="button"
        {...triggerProps}
        className="app-no-drag flex h-5 items-center gap-1 rounded-pill px-2 text-[11px] text-text-secondary hover:bg-glass motion-safe:transition-colors motion-safe:duration-300"
      >
        <Icon name="ArrowLeftRight" size={11} className="text-text-quaternary" />
        <span className="font-mono tabular-nums">{count}</span>
      </button>

      {open &&
        chipRef.current &&
        createPortal(
          <div
            {...popoverProps}
            data-surface-layer="popover"
            className="animate-menu-in surface-layer surface-layer--popover fixed z-[var(--z-popover)] w-[300px] origin-top-left rounded-[14px] p-3"
            style={{
              left: Math.min(chipRef.current.getBoundingClientRect().left, window.innerWidth - 310),
              top: chipRef.current.getBoundingClientRect().top - 8,
              transform: 'translateY(-100%)',
            }}
          >
            <div className="mb-2 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-label text-text-3">
              <Icon name="ArrowLeftRight" size={11} />
              Listening ports
            </div>
            {count === 0 ? (
              <div className="py-1 text-[12px] text-text-tertiary">No dev servers from this workspace's terminals.</div>
            ) : (
              <div className="space-y-1">
                {ports.map((p) => (
                  <div key={`${p.port}:${p.terminalId}`} className="flex items-center gap-2 rounded-[10px] px-1.5 py-1.5 hover:bg-glass">
                    <span className="w-12 font-mono text-[12px] tabular-nums text-text-primary">:{p.port}</span>
                    <span className="min-w-0 flex-1 truncate text-[12px] text-text-secondary">
                      {p.name || 'process'} <span className="text-text-quaternary">· {p.title}</span>
                    </span>
                    <button
                      type="button"
                      onClick={() => openInPlano(p.port)}
                      title="Open in PLANO"
                      className="rounded-[8px] p-1 text-text-tertiary hover:bg-accent-soft hover:text-text-primary"
                    >
                      <Icon name="ExternalLink" size={13} />
                    </button>
                    <button
                      type="button"
                      onClick={() => copyUrl(p.port)}
                      title="Copy URL"
                      className="rounded-[8px] p-1 text-text-tertiary hover:bg-accent-soft hover:text-text-primary"
                    >
                      <Icon name="Copy" size={13} />
                    </button>
                    <button
                      type="button"
                      onClick={() => void killOwner(p.port, p.pid, p.name)}
                      title="Kill process"
                      className="rounded-[8px] p-1 text-text-tertiary hover:bg-destructive-soft hover:text-destructive"
                    >
                      <Icon name="SquareX" size={13} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>,
          document.body,
        )}
    </>
  )
}
