import { Fragment, useEffect, useRef, useState } from 'react'
import { Icon } from '@/design-system/Icon'
import { AgentLogo } from '@/panels/terminal/AgentLogo'
import type { ProviderUsage } from '@shared/domain/usage'
import { useUsageStore } from '@/stores/useUsageStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useAgentStore, selectActiveAgentCount } from '@/stores/useAgentStore'
import { useUiStore } from '@/stores/useUiStore'
import { providerMeta, windowsOf, headlineWindow } from './providerMeta'
import { UsageMeter } from './UsageMeter'
import { PortsChip } from './PortsChip'
import { ResourceChip } from './ResourceChip'
import { DANGER, formatResetsAt, formatTimeToReset, riskLevel, roundPercent } from './usageFormat'

/** One provider block: brand mark + name + reset time, then one meter per window. */
function ProviderRow({ usage, now }: { usage: ProviderUsage; now: number }) {
  const meta = providerMeta(usage.provider)
  const wins = windowsOf(usage)
  const headline = headlineWindow(usage)
  const accent = meta.accent

  return (
    <div tabIndex={0} className="focus-caliper rounded-[12px] px-4 py-2 outline-none">
      <div className="flex items-center gap-2">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center">
          {/* The mark renders in ITS OWN colour — the established accent precedent; it greys out
              only when the provider has nothing to report. */}
          <AgentLogo kind={meta.kind} size={15} color={accent} className={wins.length > 0 ? undefined : 'opacity-45'} />
        </span>
        <span className="min-w-0 truncate text-[12.5px] font-medium text-text-primary">{meta.label}</span>
        <span className="ml-auto shrink-0 font-mono text-[11px] tabular-nums text-text-tertiary">
          {headline?.resetsAt ? `resets in ${formatTimeToReset(headline.resetsAt - now)}` : ''}
        </span>
      </div>
      {wins.length > 0 ? (
        // ONE grid, not a stack of flex rows: label, meter and percentage share their columns
        // across every provider, so the whole panel reads as a single aligned table instead of
        // three blocks that happen to sit near each other.
        <div className="mt-2 grid grid-cols-[2.75rem_1fr_2.5rem] items-center gap-x-2.5 gap-y-1.5 pl-8 pr-1">
          {wins.map(({ key, label, w }) => {
            const level = riskLevel(w.usedPercent)
            const pctColor = level === 'danger' ? DANGER : level === 'accent' ? accent : 'var(--text-secondary)'
            const title = `resets ${formatResetsAt(w.resetsAt, w.windowMinutes)}`
            return (
              <Fragment key={key}>
                <span className="truncate font-mono text-[10px] uppercase leading-none tracking-label text-text-quaternary" title={title}>
                  {label}
                </span>
                <UsageMeter pct={w.usedPercent} accent={accent} />
                <span className="text-right font-mono text-[11px] leading-none tabular-nums" style={{ color: pctColor }} title={title}>
                  {roundPercent(w.usedPercent)}%
                </span>
              </Fragment>
            )
          })}
        </div>
      ) : (
        // Credentials present but unreadable → the row EXISTS with the reason, never a 0 % meter.
        <div className="mt-1 pl-8 text-[11px] leading-snug text-text-tertiary">
          {usage.detail ?? 'No quota windows available.'}
        </div>
      )}
    </div>
  )
}

/**
 * UsagePanel — ONE panel for the whole island (never one popover per chip). Anchored
 * bottom-left above the island. Provider blocks with per-window meters, a machine row
 * (ports · memory · agents), and exactly one navigation: `Usage settings`.
 */
export function UsagePanel({ now, onClose }: { now: number; onClose: () => void }) {
  const usageSettings = useSettingsStore((s) => s.settings.usage)
  const providers = useUsageStore((s) => s.snapshot.providers)
  const agents = useAgentStore(selectActiveAgentCount)
  const [refreshing, setRefreshing] = useState(false)
  const [disabledUntil, setDisabledUntil] = useState(0)
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const shown = providers.filter((p) => usageSettings.chips.providers[p.provider] !== false)

  useEffect(
    () => () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current)
    },
    [],
  )

  // Esc closes the panel from anywhere (the island button handles Enter/Space).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const refresh = (): void => {
    const until = Date.now() + 3000
    setDisabledUntil(until)
    setRefreshing(true)
    // Spin until the host's refreshed snapshot lands (usage:changed), then a 3 s quiet window.
    const unsub = window.plano.usage.onChanged(() => {
      unsub()
      setRefreshing(false)
    })
    void window.plano.usage.refresh().catch(() => {
      unsub()
      setRefreshing(false)
    })
    refreshTimer.current = setTimeout(() => {
      unsub()
      setRefreshing(false)
    }, 15_000)
  }

  return (
    <div
      data-surface-layer="popover"
      className="surface-layer surface-layer--popover animate-menu-in motion-safe:animate-menu-in w-[300px] overflow-hidden rounded-[20px]"
      role="dialog"
      aria-label="Usage"
    >
      {/* header: label + refresh */}
      <div className="flex items-center justify-between px-4 pb-1.5 pt-3">
        <span className="text-[10px] font-medium uppercase tracking-label text-text-3">Usage</span>
        <button
          type="button"
          onClick={refresh}
          disabled={refreshing || Date.now() < disabledUntil}
          title="Refresh all providers"
          aria-label="Refresh all providers"
          className="app-no-drag rounded-[8px] p-1 text-text-tertiary transition-colors hover:bg-glass hover:text-text-primary disabled:opacity-40"
        >
          <Icon name="RotateCw" size={12} className={refreshing ? 'motion-safe:animate-spin' : ''} />
        </button>
      </div>

      {/* provider blocks, hairline-divided */}
      <div className="divide-y divide-[var(--border-glass)]">
        {shown.length === 0 && <div className="px-4 py-3 text-[12px] text-text-tertiary">No providers to show.</div>}
        {shown.map((p) => (
          <ProviderRow key={p.provider} usage={p} now={now} />
        ))}
      </div>

      {/* machine row: three equal cells, each centred — ports · memory · agents */}
      <div className="grid grid-cols-3 items-center border-t border-[var(--border-glass)] px-2 py-2 text-[11px] text-text-secondary">
        <div className="flex items-center justify-center gap-1">
          <PortsChip />
          <span className="text-text-quaternary">ports</span>
        </div>
        <div className="flex items-center justify-center border-x border-[var(--border-glass)]">
          <ResourceChip />
        </div>
        <button
          type="button"
          onClick={() => useUiStore.getState().toggleAgentControl()}
          title={`${agents} live agent${agents === 1 ? '' : 's'}`}
          className="app-no-drag flex h-5 items-center justify-center gap-1 rounded-pill text-[11px] text-text-secondary hover:text-text-primary motion-safe:transition-colors motion-safe:duration-300"
        >
          <Icon name="Activity" size={11} className="text-text-quaternary" />
          <span className="font-mono tabular-nums">{agents}</span>
          <span className="text-text-quaternary">agents</span>
        </button>
      </div>

      {/* footer: the ONLY navigation in the panel */}
      <button
        type="button"
        onClick={() => {
          onClose()
          useSettingsStore.getState().openTo('usage')
        }}
        className="app-no-drag flex w-full items-center justify-between border-t border-[var(--border-glass)] px-4 py-2.5 text-[12px] text-text-secondary transition-colors hover:bg-glass hover:text-text-primary"
      >
        Usage settings
        <Icon name="ChevronRight" size={12} className="text-text-quaternary" />
      </button>
    </div>
  )
}
