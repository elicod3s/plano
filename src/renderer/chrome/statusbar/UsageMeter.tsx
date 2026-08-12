import { clampPercent, riskColor } from './usageFormat'

/**
 * UsageMeter — the per-window meter in the usage panel. 4 px track, `--surface-4` background,
 * fill `--text-secondary`; at ≥80 % the fill switches to the provider accent, at ≥95 % to
 * `#EF4444` — the same risk rule the island ring uses (riskColor in usageFormat), so a meter
 * and the ring cannot disagree about what "at risk" means.
 */
export function UsageMeter({ pct, accent, width = 92 }: { pct: number; accent: string; width?: number }) {
  const clamped = clampPercent(pct)
  return (
    <div className="h-1 shrink-0 overflow-hidden rounded-full bg-[var(--surface-4)]" style={{ width }}>
      <div
        className="h-full rounded-full motion-safe:transition-[width] motion-safe:duration-300 motion-safe:ease-out"
        style={{ width: `${clamped}%`, background: riskColor(clamped, accent) }}
      />
    </div>
  )
}
