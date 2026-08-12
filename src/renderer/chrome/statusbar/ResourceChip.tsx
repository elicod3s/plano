import { useRef } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '@/design-system/Icon'
import { useUsageStore } from '@/stores/useUsageStore'
import { formatBytes } from './usageFormat'
import { useChipHover } from './useChipHover'

/**
 * Resources chip: RSS of the app + every agent process (`▤ 5.34 GB`). The app's own RSS is a
 * main-process fact; agent RSS is summed by the host's scanner. A failed agent scan reads 0 —
 * the chip then shows the app alone rather than inventing a number.
 */
export function ResourceChip() {
  const resources = useUsageStore((s) => s.aux.resources)
  const chipRef = useRef<HTMLButtonElement>(null)
  const { open, triggerProps, popoverProps } = useChipHover()
  const appBytes = resources.appRssBytes ?? 0
  const agentBytes = resources.agentRssBytes ?? 0
  const total = appBytes + agentBytes

  return (
    <>
      <button
        ref={chipRef}
        type="button"
        {...triggerProps}
        className="app-no-drag flex h-5 items-center gap-1 rounded-pill px-2 text-[11px] text-text-secondary hover:bg-glass motion-safe:transition-colors motion-safe:duration-300"
      >
        <Icon name="Gauge" size={11} className="text-text-quaternary" />
        <span className="font-mono tabular-nums">{formatBytes(total)}</span>
      </button>

      {open &&
        chipRef.current &&
        createPortal(
          <div
            {...popoverProps}
            data-surface-layer="popover"
            className="animate-menu-in surface-layer surface-layer--popover fixed z-[var(--z-popover)] w-[220px] origin-top-left rounded-[14px] p-3"
            style={{
              left: Math.min(chipRef.current.getBoundingClientRect().left, window.innerWidth - 230),
              top: chipRef.current.getBoundingClientRect().top - 8,
              transform: 'translateY(-100%)',
            }}
          >
            <div className="mb-2 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-label text-text-3">
              <Icon name="Gauge" size={11} />
              Memory
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-[12px] text-text-secondary">App</span>
                <span className="font-mono text-[12px] tabular-nums text-text-primary">{formatBytes(appBytes)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[12px] text-text-secondary">Agents</span>
                <span className="font-mono text-[12px] tabular-nums text-text-primary">{formatBytes(agentBytes)}</span>
              </div>
              <div className="border-t border-glass pt-1.5 text-[10px] text-text-quaternary">Live RSS of PLANO + every agent process.</div>
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}
