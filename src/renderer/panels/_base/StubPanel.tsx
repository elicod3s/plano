import type { Panel } from '@shared/domain/panel'
import { PANEL_META } from '@shared/domain/panel'
import { Icon } from '@/design-system/Icon'

/** Placeholder body for panel types whose full implementation lands in a later milestone. */
export function StubPanel({ panel }: { panel: Panel }) {
  const meta = PANEL_META[panel.type]
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 bg-surface-1 px-6 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-md bg-surface-3">
        <Icon name={meta.icon} size={22} className="text-text-secondary" />
      </div>
      <div>
        <p className="text-[14px] font-medium text-text-primary">{meta.label.replace(/^New\s+/, '')}</p>
        <p className="mt-1 text-[12px] text-text-tertiary">Coming soon in PLANO.</p>
      </div>
    </div>
  )
}
