/**
 * codex adapter — Codex CLI usage from its local session rollouts.
 *
 * Reads the newest rollout files under ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl (honours
 * CODEX_HOME). Only files modified in the last 24 h are read, tail-first, capped at 256 KiB per
 * file. The rate-limit state rides the `event_msg` with `payload.type === 'token_count'`:
 *
 *   { "type": "event_msg", "payload": { "type": "token_count", "info": {…},
 *     "rate_limits": { "primary": { "used_percent": 28, "window_minutes": 10080, "resets_at": 1787016846 },
 *                       "secondary": null, "plan_type": "plus", … } } }
 *
 * Field names VERIFIED on this machine (codex-cli 0.147.0, 2026-08-12 rollout) — see the plan's
 * Findings. `resets_at` is epoch SECONDS; `window_minutes` on `primary` is 10080 (7d) on the
 * Plus plan, so windows are classified by their size, not by primary/secondary position.
 */

import { statSync, existsSync, openSync, readSync, closeSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { ProviderUsage, UsageWindow } from '@shared/domain/usage'

const MAX_FILE_BYTES = 256 * 1024
const FRESH_MS = 24 * 60 * 60 * 1000

/** 300 = 5h session, 10080 = 7d weekly, 43200 = 30d monthly. */
function classifyWindow(minutes: number): 'session' | 'weekly' | 'monthly' | null {
  if (minutes === 300) return 'session'
  if (minutes === 10080) return 'weekly'
  if (minutes === 43200) return 'monthly'
  return null
}

function parseWindow(value: unknown): UsageWindow | null {
  if (!value || typeof value !== 'object') return null
  const o = value as Record<string, unknown>
  const used = typeof o.used_percent === 'number' ? o.used_percent : NaN
  const minutes = typeof o.window_minutes === 'number' ? o.window_minutes : NaN
  const resets = typeof o.resets_at === 'number' && Number.isFinite(o.resets_at) ? o.resets_at : NaN
  if (!Number.isFinite(used)) return null
  return {
    usedPercent: Math.min(100, Math.max(0, used)),
    windowMinutes: Number.isFinite(minutes) ? minutes : 0,
    resetsAt: Number.isFinite(resets) ? resets * 1000 : null, // epoch seconds → ms
  }
}

/** Read the tail of a JSONL file (newest lines first), capped at MAX_FILE_BYTES. */
function tailLines(file: string, maxBytes: number): string[] {
  const size = statSync(file).size
  const start = Math.max(0, size - maxBytes)
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.alloc(size - start)
    readSync(fd, buf, 0, buf.length, start)
    const text = buf.toString('utf8')
    const lines = text.split(/\r?\n/)
    // The first line of the tail may be truncated mid-line — drop it, keep complete lines, newest last.
    const complete = size > maxBytes ? lines.slice(1) : lines
    return complete.filter((l) => l.trim()).reverse()
  } finally {
    closeSync(fd)
  }
}

/** Parse the newest rate-limit state out of one rollout tail. Null when absent. */
export function parseRolloutTail(lines: string[]): ProviderUsage | null {
  for (const line of lines) {
    let msg: { type?: unknown; payload?: unknown }
    try {
      msg = JSON.parse(line) as { type?: unknown; payload?: unknown }
    } catch {
      continue
    }
    if (msg.type !== 'event_msg') continue
    const payload = msg.payload as { type?: unknown; rate_limits?: unknown } | null
    if (!payload || payload.type !== 'token_count') continue
    const rl = payload.rate_limits as Record<string, unknown> | null
    if (!rl || typeof rl !== 'object') continue
    const primary = parseWindow(rl.primary)
    const secondary = parseWindow(rl.secondary)
    const session =
      primary && classifyWindow(primary.windowMinutes) === 'session' ? primary
      : secondary && classifyWindow(secondary.windowMinutes) === 'session' ? secondary
      : null
    const weekly =
      primary && classifyWindow(primary.windowMinutes) === 'weekly' ? primary
      : secondary && classifyWindow(secondary.windowMinutes) === 'weekly' ? secondary
      : null
    const monthly =
      primary && classifyWindow(primary.windowMinutes) === 'monthly' ? primary
      : secondary && classifyWindow(secondary.windowMinutes) === 'monthly' ? secondary
      : null
    // A token_count without any recognized window still proves the provider is readable —
    // but never invent a number: no window → nothing to show.
    if (!session && !weekly && !monthly) continue
    return { provider: 'codex', status: 'ok', session, weekly, monthly, source: 'session-file', updatedAt: Date.now() }
  }
  return null
}

/**
 * The `sessions` directory rollouts are written into, or '' when codex is not installed here.
 * Exported so the collector can WATCH it: codex appends the moment a turn ends, which is what
 * turns the 60 s poll into a live update.
 */
export function sessionsRoot(): string {
  const root = process.env.CODEX_HOME || join(homedir(), '.codex')
  const dir = join(root, 'sessions')
  return existsSync(dir) ? dir : ''
}

/** Adapter contract: newest rollout within 24 h, tail-first, 256 KiB cap. */
export async function read(): Promise<ProviderUsage | null> {
  try {
    const root = process.env.CODEX_HOME || join(homedir(), '.codex')
    if (!existsSync(join(root, 'auth.json'))) return null // no credentials → absent, not zero
    const now = Date.now()
    const candidates: string[] = []
    for (let y = 0; y < 3; y += 1) {
      const year = new Date(now - y * 365 * 24 * 3600 * 1000).getFullYear()
      for (let m = 1; m <= 12; m += 1) {
        const month = String(m).padStart(2, '0')
        for (let d = 1; d <= 31; d += 1) {
          const day = String(d).padStart(2, '0')
          const dir = join(root, 'sessions', String(year), month, day)
          if (!existsSync(dir)) continue
          let entries: string[] = []
          try {
            entries = readdirSync(dir) as string[]
          } catch {
            continue
          }
          for (const name of entries) {
            if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue
            const file = join(dir, name)
            try {
              if (now - statSync(file).mtimeMs > FRESH_MS) continue
              candidates.push(file)
            } catch {
              /* unreadable file — skip */
            }
          }
        }
      }
    }
    // Newest first: the freshest rollout carries the latest rate-limit state.
    candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
    for (const file of candidates) {
      const parsed = parseRolloutTail(tailLines(file, MAX_FILE_BYTES))
      if (parsed) return parsed
    }
    return null
  } catch {
    return null
  }
}
