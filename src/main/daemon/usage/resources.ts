/**
 * resources — RSS of every agent process running under PLANO terminals.
 *
 * The daemon owns the agent PIDs (detection), so the agent-side RSS is computed here via one
 * PowerShell `Get-Process` query. The APP's own RSS is added by MAIN (process.memoryUsage().rss
 * is a main-process fact) when it serves the aux snapshot to the renderer. Never throws: a
 * failed scan returns 0 — the chip stays at the app's own RSS rather than inventing numbers.
 */

import { execFile } from 'node:child_process'

export interface ResourceScanSession {
  pid: number
  agentPid: number | null
}

export interface ResourceScanDeps {
  sessions: () => ResourceScanSession[]
}

const SCAN_TIMEOUT_MS = 10_000

/** Sum of WorkingSet64 over the given PIDs; 0 on any failure. */
function rawRss(pids: number[]): Promise<number> {
  if (pids.length === 0) return Promise.resolve(0)
  const idList = pids.join(',')
  const query = `Get-Process -Id ${idList} -ErrorAction SilentlyContinue | Measure-Object WorkingSet64 -Sum | Select-Object -ExpandProperty Sum`
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', query],
      { windowsHide: true, timeout: SCAN_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err || !stdout) return resolve(0)
        const n = Number(stdout.trim())
        resolve(Number.isFinite(n) && n > 0 ? n : 0)
      },
    )
  })
}

/** Agent RSS bytes across every session (agent CLI processes; falls back to the shell PID). */
export async function scanAgentRss(deps: ResourceScanDeps): Promise<number> {
  try {
    const sessions = deps.sessions()
    const pids = sessions
      .filter((s) => s.pid > 0)
      .map((s) => (s.agentPid && s.agentPid > 0 ? s.agentPid : s.pid))
    const dedup = [...new Set(pids)]
    if (dedup.length === 0) return 0
    if (process.platform === 'win32') return rawRss(dedup)
    // POSIX: /proc/<pid>/statm RSS pages (4 KiB) — no external deps.
    let total = 0
    for (const pid of dedup) {
      try {
        const { readFileSync } = await import('node:fs')
        const statm = readFileSync(`/proc/${pid}/statm`, 'utf8').split(/\s+/)
        total += Number(statm[1] ?? 0) * 4096
      } catch {
        /* process gone */
      }
    }
    return total
  } catch {
    return 0
  }
}
