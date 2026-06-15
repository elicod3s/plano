/**
 * Time-tracking domain helpers — shared by main (aggregation + persistence) and the
 * renderer (live display + weekly breakdown). Environment-agnostic: only `Date` and pure
 * math, so it stays importable from both the node and web tsconfig projects.
 *
 * Active usage time is bucketed per LOCAL calendar day, keyed "YYYY-MM-DD". Weeks start on
 * Monday to match how people think about a work week; both sides run on the same machine,
 * so their local timezone always agrees.
 */

export type DayTotals = Record<string, number>

/** Local calendar-day key for `date`, e.g. "2026-06-15" (local time, not UTC). */
export function dayKey(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** Local midnight of the Monday on or before `date`. */
export function startOfWeek(date: Date): Date {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const backToMonday = (d.getDay() + 6) % 7 // getDay: 0=Sun..6=Sat → Mon=0
  d.setDate(d.getDate() - backToMonday)
  return d
}

/** The seven local day-keys of the week containing `date`, Monday → Sunday. */
export function weekDayKeys(date: Date): string[] {
  const start = startOfWeek(date)
  const keys: string[] = []
  for (let i = 0; i < 7; i++) {
    const d = new Date(start)
    d.setDate(start.getDate() + i)
    keys.push(dayKey(d))
  }
  return keys
}

/** Seconds tracked on the local day containing `date`. */
export function secondsOnDay(days: DayTotals, date: Date): number {
  return days[dayKey(date)] ?? 0
}

/** Total seconds tracked across the local week (Mon → Sun) containing `date`. */
export function secondsInWeek(days: DayTotals, date: Date): number {
  return weekDayKeys(date).reduce((sum, key) => sum + (days[key] ?? 0), 0)
}
