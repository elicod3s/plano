/**
 * Pure helpers for resolving an AI-agent CLI's on-disk conversation id from its session store.
 * Each resumable CLI writes a per-conversation file (created at the first prompt), so the file
 * whose birthtime is at/after the agent process start is this run's session. Windows-first
 * (uses `os.homedir()` = %USERPROFILE%); no Electron/DOM deps so it stays unit-testable.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SESSION_ID_RE } from '@shared/domain/agent'

const codexRolloutCache = new Map<string, string>()

/**
 * Claude Code's per-project session dir name. It replaces every non-alphanumeric char in the
 * absolute cwd with `-` (verified on Windows: `D:\Tools\Plano` → `D--Tools-Plano` under
 * `%USERPROFILE%\.claude\projects\`). Case is preserved.
 */
export function escapeClaudeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

/** Codex rollout filename → `{ ms, sessionId }`. e.g.
 *  `rollout-2026-06-21T14-45-52-019eebb7-d0c6-77f0-9c35-4654c1eb65f9.jsonl`. */
export function parseRolloutName(name: string): { ms: number; sessionId: string } | null {
  const m = /^rollout-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-([0-9a-fA-F-]{8,})\.jsonl$/.exec(name)
  if (!m) return null
  const ms = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}`)
  if (!Number.isFinite(ms)) return null
  return { ms, sessionId: m[5] }
}

/** The Codex session dirs to scan: the agent-start day plus its neighbors (midnight boundary). */
export function codexDayDirs(startMs: number): string[] {
  const base = path.join(os.homedir(), '.codex', 'sessions')
  const dirs: string[] = []
  for (const offset of [0, -1, 1]) {
    const d = new Date(startMs + offset * 86_400_000)
    const yyyy = `${d.getFullYear()}`
    const mm = `${d.getMonth() + 1}`.padStart(2, '0')
    const dd = `${d.getDate()}`.padStart(2, '0')
    dirs.push(path.join(base, yyyy, mm, dd))
  }
  return dirs
}

/**
 * Pull an exact session id from a Codex process command line. This is the strongest signal for a
 * resumed process because its rollout keeps the ORIGINAL timestamp, so matching by process/file
 * birthtime cannot work.
 */
export function codexSessionIdFromCommand(command: string): string | null {
  const match = /(?:^|\s)resume\s+([0-9a-fA-F-]{8,64})(?=\s|$)/i.exec(command)
  return match && SESSION_ID_RE.test(match[1]) ? match[1] : null
}

/** Locate a Codex rollout by id (fast UUIDv7 lookup, with a compatibility scan for older UUIDs). */
export function findCodexRollout(sessionId: string): string | null {
  if (!SESSION_ID_RE.test(sessionId)) return null
  const key = sessionId.toLowerCase()
  const cached = codexRolloutCache.get(key)
  if (cached !== undefined) return cached

  const suffix = `-${key}.jsonl`
  const compact = key.replace(/-/g, '')
  // Current Codex ids are UUIDv7: their first 48 bits are epoch milliseconds. Restrict the direct
  // lookup to v7 ids; interpreting an older UUIDv4 as a timestamp points at a nonsense year.
  if (compact.length >= 13 && compact[12] === '7') {
    const sessionMs = Number.parseInt(compact.slice(0, 12), 16)
    if (Number.isFinite(sessionMs)) {
      for (const dir of codexDayDirs(sessionMs)) {
        try {
          const name = fs.readdirSync(dir).find((candidate) => candidate.toLowerCase().endsWith(suffix))
          if (name) {
            const found = path.join(dir, name)
            codexRolloutCache.set(key, found)
            return found
          }
        } catch {
          /* missing day directory */
        }
      }
    }
  }

  // Compatibility fallback for pre-UUIDv7 sessions and stores moved between Codex versions. The
  // tree is only year/month/day directories, so this bounded metadata walk is cheap and reads no
  // conversation content.
  const root = path.join(os.homedir(), '.codex', 'sessions')
  const dirs = [root]
  while (dirs.length > 0) {
    const dir = dirs.pop()!
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) dirs.push(fullPath)
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(suffix)) {
        codexRolloutCache.set(key, fullPath)
        return fullPath
      }
    }
  }
  return null
}

/**
 * Newest Codex session ids that accepted a prompt after `sinceMs`. Unlike rollout birthtime,
 * history.jsonl also identifies a newly-started process that resumed an older conversation.
 */
export function recentCodexHistoryIds(sinceMs: number, slackMs: number): string[] {
  const file = path.join(os.homedir(), '.codex', 'history.jsonl')
  try {
    const stat = fs.statSync(file)
    const maxBytes = 1024 * 1024
    const start = Math.max(0, stat.size - maxBytes)
    const fd = fs.openSync(file, 'r')
    const buffer = Buffer.alloc(stat.size - start)
    let read = 0
    try {
      read = fs.readSync(fd, buffer, 0, buffer.length, start)
    } finally {
      fs.closeSync(fd)
    }
    let text = buffer.toString('utf8', 0, read)
    if (start > 0) text = text.slice(Math.max(0, text.indexOf('\n') + 1))
    const ids: string[] = []
    const seen = new Set<string>()
    const lines = text.split(/\r?\n/)
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (!lines[i]) continue
      try {
        const row = JSON.parse(lines[i]) as { session_id?: unknown; ts?: unknown }
        const id = typeof row.session_id === 'string' ? row.session_id : ''
        const ts = Number(row.ts)
        if (!SESSION_ID_RE.test(id) || !Number.isFinite(ts)) continue
        if (ts * 1000 < sinceMs - slackMs) continue
        const key = id.toLowerCase()
        if (!seen.has(key)) {
          seen.add(key)
          ids.push(id)
        }
      } catch {
        /* tolerate a partial/corrupt line */
      }
    }
    return ids
  } catch {
    return []
  }
}

/** First JSON line of a Codex rollout → `{ id, cwd }` (never reads conversation rows). */
export function readRolloutMeta(
  filePath: string,
): { id?: string; cwd?: string; originator?: string } | null {
  const firstLine = readFirstLine(filePath)
  if (firstLine === null) return null
  try {
    const parsed = JSON.parse(firstLine) as {
      payload?: { id?: string; cwd?: string; originator?: string }
    }
    return parsed.payload ?? null
  } catch {
    return null
  }
}

/**
 * Read exactly the first JSONL row, up to a defensive ceiling. Codex 0.145 expanded its metadata
 * row beyond 18 KB; the old fixed 4 KB head truncated valid JSON and silently lost every session id.
 */
function readFirstLine(filePath: string, maxBytes = 512 * 1024): string | null {
  let fd: number | null = null
  try {
    fd = fs.openSync(filePath, 'r')
    const chunks: Buffer[] = []
    let total = 0
    while (total < maxBytes) {
      const chunk = Buffer.alloc(Math.min(16 * 1024, maxBytes - total))
      const read = fs.readSync(fd, chunk, 0, chunk.length, total)
      if (read <= 0) break
      const slice = chunk.subarray(0, read)
      const newline = slice.indexOf(0x0a)
      if (newline >= 0) {
        chunks.push(slice.subarray(0, newline))
        return Buffer.concat(chunks).toString('utf8').replace(/\r$/, '')
      }
      chunks.push(slice)
      total += read
    }
    // A small final row without a trailing newline is still valid; a row that hit the ceiling is
    // treated as malformed rather than reading arbitrary conversation data.
    return total < maxBytes ? Buffer.concat(chunks).toString('utf8').replace(/\r$/, '') : null
  } catch {
    return null
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        /* already closed */
      }
    }
  }
}

/** A Gemini chat record carries its `sessionId` in the first ~4 KB — pull it with a regex. */
export function readGeminiSessionId(filePath: string): string | null {
  const head = readHead(filePath)
  if (head === null) return null
  const m = /"sessionId"\s*:\s*"([0-9a-fA-F-]{36})"/.exec(head)
  return m ? m[1] : null
}

/** Gemini's per-project chats dir, via `~/.gemini/projects.json` (cwd → identifier), or null. */
export function geminiChatsDir(cwd: string): string | null {
  try {
    const registry = JSON.parse(
      fs.readFileSync(path.join(os.homedir(), '.gemini', 'projects.json'), 'utf-8'),
    ) as { projects?: Record<string, string> }
    const id = registry.projects?.[cwd]
    if (!id) return null
    return path.join(os.homedir(), '.gemini', 'tmp', id, 'chats')
  } catch {
    return null
  }
}

/**
 * Pi's per-project session dir, mirroring pi's own encoding
 * (`getDefaultSessionDir` in @earendil-works/pi-coding-agent):
 * `~/.pi/agent/sessions/--<cwd with [/\\:] → ->--/`. On Windows `C:\Tools\Foo` → `--C-Tools-Foo--`.
 */
export function piSessionDir(cwd: string): string {
  const encoded = `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`
  return path.join(os.homedir(), '.pi', 'agent', 'sessions', encoded)
}

/**
 * Oh My Pi (omp) is a fork of pi — same session layout and same cwd encoding, but its own
 * home: `~/.omp/agent/sessions/--<encoded-cwd>--` (confirmed in the omp bundle:
 * `Yn="omp", sW=".omp"`; `--export ~/.omp/agent/sessions/...`). Same `<timestamp>_<uuid>.jsonl`
 * filenames, so `parsePiSessionName` applies unchanged.
 */
export function ompSessionDir(cwd: string): string {
  const encoded = `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`
  return path.join(os.homedir(), '.omp', 'agent', 'sessions', encoded)
}

/** Pi session filename → id. Files are `<ISO-timestamp-with-dashes>_<uuid>.jsonl`. */
export function parsePiSessionName(name: string): string | null {
  const m = /_([0-9a-fA-F-]{8,64})\.jsonl$/.exec(name)
  return m && SESSION_ID_RE.test(m[1]) ? m[1] : null
}

/**
 * Pull an exact (full-uuid) session id from a `pi --session <id>` command line — the strongest
 * signal for a manually resumed process whose file birthtime predates the process. Partial ids
 * are deliberately not captured so the on-disk existence check keeps working.
 */
export function piSessionIdFromCommand(command: string): string | null {
  const match = /(?:^|\s)--session\s+([0-9a-fA-F-]{36})(?=\s|$)/i.exec(command)
  return match ? match[1] : null
}

/**
 * Earliest session file in `dir` whose birthtime is at/after `startMs` (minus slack) and whose
 * extracted id isn't already claimed by another live terminal. `extractId(name, fullPath)` maps
 * a filename to a candidate session id (null = not a session file). The "earliest at/after start,
 * not claimed" rule picks THIS process's file even with many concurrent sessions in one cwd.
 */
export function resolveByBirthtime(
  dir: string,
  startMs: number,
  slackMs: number,
  claimed: ReadonlySet<string>,
  extractId: (name: string, fullPath: string) => string | null,
): string | null {
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return null
  }
  let best: { sessionId: string; birthMs: number } | null = null
  for (const name of names) {
    const fullPath = path.join(dir, name)
    const sessionId = extractId(name, fullPath)
    if (!sessionId || !SESSION_ID_RE.test(sessionId) || claimed.has(sessionId)) continue
    let birthMs: number
    try {
      birthMs = fs.statSync(fullPath).birthtimeMs
    } catch {
      continue
    }
    if (birthMs < startMs - slackMs) continue
    if (!best || birthMs < best.birthMs) best = { sessionId, birthMs }
  }
  return best?.sessionId ?? null
}

/** Read the first 4 KB of a file as UTF-8, or null on any error. */
function readHead(filePath: string): string | null {
  try {
    const fd = fs.openSync(filePath, 'r')
    const buf = Buffer.alloc(4096)
    const read = fs.readSync(fd, buf, 0, buf.length, 0)
    fs.closeSync(fd)
    return buf.toString('utf-8', 0, read)
  } catch {
    return null
  }
}
