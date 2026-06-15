/**
 * TimeTrackingService — persists per-day active-usage time (app-global, in userData) and
 * answers "today / this week" aggregates for the top-bar time chip.
 *
 * Storage: <userData>/time-tracking.json → { schemaVersion, days: { "YYYY-MM-DD": seconds } }.
 * The renderer streams active seconds via addActive(); main buckets them into the CURRENT
 * local day, so a session that crosses midnight is attributed correctly without the renderer
 * tracking date boundaries. Writes are debounced + atomic (temp + rename) like WorkspaceService.
 */

import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  dayKey,
  secondsOnDay,
  secondsInWeek,
  weekDayKeys,
  type DayTotals,
} from '@shared/domain/time'
import type { TimeStats, TimeAddActiveRequest } from '@shared/ipc/contracts'

const FILE = 'time-tracking.json'
const SCHEMA_VERSION = 1
const KEEP_DAYS = 180 // prune older buckets so the file stays tiny
const WRITE_DEBOUNCE_MS = 2000

interface TimeDoc {
  schemaVersion: number
  days: DayTotals
}

export class TimeTrackingService {
  private doc: TimeDoc | null = null
  private loading: Promise<TimeDoc> | null = null
  private writeTimer: NodeJS.Timeout | null = null
  private writeChain: Promise<void> = Promise.resolve()

  private filePath(): string {
    return join(app.getPath('userData'), FILE)
  }

  async getStats(): Promise<TimeStats> {
    const doc = await this.ensureLoaded()
    return this.computeStats(doc.days)
  }

  async addActive(req: TimeAddActiveRequest): Promise<TimeStats> {
    const doc = await this.ensureLoaded()
    const seconds = Math.floor(req?.seconds ?? 0)
    if (Number.isFinite(seconds) && seconds > 0) {
      const key = dayKey(new Date())
      doc.days[key] = (doc.days[key] ?? 0) + seconds
      this.prune(doc.days)
      this.scheduleWrite()
    }
    return this.computeStats(doc.days)
  }

  /** Force any pending write to disk now (called on app quit). */
  async flush(): Promise<void> {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer)
      this.writeTimer = null
    }
    if (this.doc) this.enqueueWrite(this.doc)
    await this.writeChain
  }

  // ── internals ──

  private ensureLoaded(): Promise<TimeDoc> {
    if (this.doc) return Promise.resolve(this.doc)
    if (!this.loading) {
      this.loading = this.read().then((doc) => {
        this.doc = doc
        return doc
      })
    }
    return this.loading
  }

  private async read(): Promise<TimeDoc> {
    try {
      const raw = await fs.readFile(this.filePath(), 'utf8')
      const parsed = JSON.parse(raw) as { days?: unknown }
      const rawDays =
        parsed && typeof parsed.days === 'object' && parsed.days
          ? (parsed.days as Record<string, unknown>)
          : {}
      // Never trust the file blindly — keep only finite, positive day buckets.
      const days: DayTotals = {}
      for (const [key, value] of Object.entries(rawDays)) {
        if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
          days[key] = Math.floor(value)
        }
      }
      return { schemaVersion: SCHEMA_VERSION, days }
    } catch {
      return { schemaVersion: SCHEMA_VERSION, days: {} }
    }
  }

  private computeStats(days: DayTotals): TimeStats {
    const now = new Date()
    return {
      today: secondsOnDay(days, now),
      week: secondsInWeek(days, now),
      weekDays: weekDayKeys(now).map((key) => ({ key, seconds: days[key] ?? 0 })),
    }
  }

  private prune(days: DayTotals): void {
    const keys = Object.keys(days).sort() // ascending "YYYY-MM-DD"
    if (keys.length <= KEEP_DAYS) return
    for (const key of keys.slice(0, keys.length - KEEP_DAYS)) delete days[key]
  }

  private scheduleWrite(): void {
    if (this.writeTimer) clearTimeout(this.writeTimer)
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null
      if (this.doc) this.enqueueWrite(this.doc)
    }, WRITE_DEBOUNCE_MS)
  }

  private enqueueWrite(doc: TimeDoc): void {
    const file = this.filePath()
    const content = JSON.stringify(doc, null, 2)
    this.writeChain = this.writeChain.then(async () => {
      const tmp = `${file}.${randomUUID()}.tmp`
      try {
        await fs.writeFile(tmp, content, 'utf8')
        await fs.rename(tmp, file)
      } catch {
        /* best-effort: usage time is non-critical, don't crash the app over it */
      }
    })
  }
}
