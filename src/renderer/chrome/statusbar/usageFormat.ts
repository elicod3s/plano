/**
 * usageFormat — pure formatting for the status bar. Every rounding decision lives here so it is
 * unit-testable and stays out of the components. Percentages are clamped 0-100 and rounded ONCE
 * at render time; nothing here stores pre-formatted strings.
 */

/** Clamp 0-100. */
export function clampPercent(v: number): number {
  return Math.min(100, Math.max(0, v))
}

/** Round once, at render. */
export function roundPercent(v: number): number {
  return Math.round(clampPercent(v))
}

/** The red reserved for a budget ≥95% — the ONLY red in the bar (and its panel). */
export const DANGER = '#EF4444'

/** Risk level of a used-percent — the meter and the island ring MUST agree on this. */
export type RiskLevel = 'default' | 'accent' | 'danger'

export function riskLevel(pct: number): RiskLevel {
  const p = clampPercent(pct)
  if (p >= 95) return 'danger'
  if (p >= 80) return 'accent'
  return 'default'
}

/** The fill colour for a meter/ring at `pct`: provider accent at ≥80 %, DANGER at ≥95 %. */
export function riskColor(pct: number, accent: string): string {
  const level = riskLevel(pct)
  if (level === 'danger') return DANGER
  if (level === 'accent') return accent
  return 'var(--text-secondary)'
}

/** 12 px donut ring (r = 6): stroke-dasharray values for `usedPercent`. */
export function ringDash(usedPercent: number, r = 6): { circumference: number; dash: number } {
  const circumference = 2 * Math.PI * r
  const pct = clampPercent(usedPercent) / 100
  return { circumference, dash: circumference * pct }
}

/** `msUntil` → "2h47m" / "5d18h" / "12m". Negative/unknown → "now". */
export function formatTimeToReset(msUntil: number): string {
  const totalMinutes = Math.max(0, Math.floor(msUntil / 60_000))
  if (totalMinutes <= 0) return 'now'
  const days = Math.floor(totalMinutes / (24 * 60))
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60)
  const minutes = totalMinutes % 60
  if (days > 0) return `${days}d${hours}h`
  if (hours > 0) return `${hours}h${minutes}m`
  return `${Math.max(1, minutes)}m`
}

/** Window size label: 300 → "5h", 10080 → "7d", 43200 → "30d". */
export function formatWindowLabel(minutes: number): string {
  if (minutes % (24 * 60) === 0) {
    const days = minutes / (24 * 60)
    return `${days}d`
  }
  const hours = minutes / 60
  return Number.isInteger(hours) ? `${hours}h` : `${minutes}m`
}

/**
 * When the window resets: 5h windows are daily → "19:40"; 7d/30d windows → weekday ("Thu").
 */
export function formatResetsAt(resetsAt: number | null, windowMinutes: number): string {
  if (typeof resetsAt !== 'number' || !Number.isFinite(resetsAt)) return '—'
  if (windowMinutes <= 300) {
    const d = new Date(resetsAt)
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(resetsAt).getDay()] ?? '—'
}

/** "5.34 GB" / "812 MB" — the resource chip reads as one instrument. */
export function formatBytes(bytes: number): string {
  const b = Math.max(0, bytes)
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(2)} GB`
  if (b >= 1024 ** 2) return `${Math.round(b / 1024 ** 2)} MB`
  if (b >= 1024) return `${Math.round(b / 1024)} KB`
  return `${Math.round(b)} B`
}
