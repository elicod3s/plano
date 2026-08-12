/**
 * TimeTrackingService — persists per-day active-usage time (app-global, in userData) and
 * answers "today / this week" aggregates for the top-bar time chip, including a per-AGENT
 * breakdown (how long you've spent in Claude, Pi, Codex, … — attributed by the renderer from
 * its agent detection).
 *
 * Storage: <userData>/time-tracking.json →
 *   { schemaVersion: 2, days: { "YYYY-MM-DD": seconds }, agentDays: { "YYYY-MM-DD": { kind: seconds } } }.
 * Schema 1 files (days only) migrate transparently. The renderer streams active seconds via
 * addActive() with optional per-agent attribution; main buckets both into the CURRENT local
 * day. Writes are debounced + atomic (temp + rename) like WorkspaceService.
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
import type { AgentTimeStat, TimeStats, TimeAddActiveRequest } from '@shared/ipc/contracts'

const FILE = 'time-tracking.json'
const SCHEMA_VERSION = 2
const KEEP_DAYS = 180 // prune older buckets so the file stays tiny
const WRITE_DEBOUNCE_MS = 2000

interface TimeDoc {
  schemaVersion: number
  days: DayTotals
  /** dayKey → { agentKind: seconds }. */
  agentDays: Record<string, DayTotals>
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
    return this.computeStats(doc)
  }

  async addActive(req: TimeAddActiveRequest): Promise<TimeStats> {
    const doc = await this.ensureLoaded()
    const seconds = Math.floor(req?.seconds ?? 0)
    const key = dayKey(new Date())
    if (Number.isFinite(seconds) && seconds > 0) {
      doc.days[key] = (doc.days[key] ?? 0) + seconds
    }
    for (const entry of req?.agents ?? []) {
      const kind = typeof entry?.kind === 'string' ? entry.kind.slice(0, 40) : ''
      const agentSecs = Math.floor(entry?.seconds ?? 0)
      if (!kind || !Number.isFinite(agentSecs) || agentSecs <= 0) continue
      const bucket = (doc.agentDays[key] ??= {})
      bucket[kind] = (bucket[kind] ?? 0) + agentSecs
    }
    if (Number.isFinite(seconds) && seconds > 0) {
      this.prune(doc.days)
      this.pruneAgentDays(doc.agentDays)
      this.scheduleWrite()
    }
    return this.computeStats(doc)
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
      const parsed = JSON.parse(raw) as { days?: unknown; agentDays?: unknown }
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
      // Schema 1 documents stored only `days`; agent buckets start empty and migrate in place.
      const agentDaysRaw =
        parsed && typeof parsed.agentDays === 'object' && parsed.agentDays
          ? (parsed.agentDays as Record<string, unknown>)
          : {}
      const agentDays: Record<string, DayTotals> = {}
      for (const [day, bucket] of Object.entries(agentDaysRaw)) {
        if (!bucket || typeof bucket !== 'object') continue
        const clean: DayTotals = {}
        for (const [kind, value] of Object.entries(bucket as Record<string, unknown>)) {
          if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
            clean[kind] = Math.floor(value)
          }
        }
        if (Object.keys(clean).length > 0) agentDays[day] = clean
      }
      return { schemaVersion: SCHEMA_VERSION, days, agentDays }
    } catch {
      return { schemaVersion: SCHEMA_VERSION, days: {}, agentDays: {} }
    }
  }

  private computeStats(doc: TimeDoc): TimeStats {
    const now = new Date()
    const days = doc.days
    const weekKeys = weekDayKeys(now)
    return {
      today: secondsOnDay(days, now),
      week: secondsInWeek(days, now),
      weekDays: weekKeys.map((key) => ({ key, seconds: days[key] ?? 0 })),
      agentsToday: this.agentStatsFor(doc.agentDays, dayKey(now)),
      agentsWeek: this.agentStatsAcross(doc.agentDays, weekKeys),
    }
  }

  /** Sorted (desc) per-agent seconds on one day. */
  private agentStatsFor(agentDays: Record<string, DayTotals>, key: string): AgentTimeStat[] {
    const bucket = agentDays[key]
    if (!bucket) return []
    return Object.entries(bucket)
      .map(([kind, seconds]) => ({ kind, seconds }))
      .sort((a, b) => b.seconds - a.seconds)
  }

  /** Per-agent seconds aggregated across a set of day keys (the week). */
  private agentStatsAcross(agentDays: Record<string, DayTotals>, keys: string[]): AgentTimeStat[] {
    const total: Record<string, number> = {}
    for (const key of keys) {
      const bucket = agentDays[key]
      if (!bucket) continue
      for (const [kind, seconds] of Object.entries(bucket)) {
        total[kind] = (total[kind] ?? 0) + seconds
      }
    }
    return Object.entries(total)
      .map(([kind, seconds]) => ({ kind, seconds }))
      .sort((a, b) => b.seconds - a.seconds)
  }

  private prune(days: DayTotals): void {
    const keys = Object.keys(days).sort() // ascending "YYYY-MM-DD"
    if (keys.length <= KEEP_DAYS) return
    for (const key of keys.slice(0, keys.length - KEEP_DAYS)) delete days[key]
  }

  private pruneAgentDays(agentDays: Record<string, DayTotals>): void {
    const keys = Object.keys(agentDays).sort()
    if (keys.length <= KEEP_DAYS) return
    for (const key of keys.slice(0, keys.length - KEEP_DAYS)) delete agentDays[key]
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
