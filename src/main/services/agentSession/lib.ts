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

/** First JSON line of a Codex rollout → `{ id, cwd }` (read only the head, files can be large). */
export function readRolloutMeta(filePath: string): { id?: string; cwd?: string } | null {
  const head = readHead(filePath)
  if (head === null) return null
  try {
    const parsed = JSON.parse(head.split('\n')[0]) as { payload?: { id?: string; cwd?: string } }
    return parsed.payload ?? null
  } catch {
    return null
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
