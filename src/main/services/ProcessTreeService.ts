/**
 * ProcessTreeService — a cheap, shared snapshot of the OS process list.
 *
 * Purpose is narrow and benign: PLANO only ever inspects the descendants of shells
 * IT ITSELF spawned (the PIDs node-pty hands us) so a terminal panel can show a nicer
 * UI when the user launches an AI coding CLI inside it — the same thing Warp / Wave do.
 *
 * The single most important scaling decision: ONE enumeration per cycle, cached and
 * reused by every terminal detector. 1 terminal and 30 terminals cost the same work.
 */

import { execFile } from 'node:child_process'

export interface Proc {
  pid: number
  ppid: number
  /** image/base name, e.g. "node.exe", "claude", "python3" */
  name: string
  /** full command line when available (Windows via CIM; POSIX via ps) */
  cmd: string
}

const TTL_MS = 1200

export class ProcessTreeService {
  private cache: Map<number, Proc> | null = null
  private cachedAt = 0
  private inflight: Promise<Map<number, Proc>> | null = null

  /** Return a process map no older than `maxAgeMs`, coalescing concurrent callers. */
  ensureFresh(maxAgeMs = TTL_MS): Promise<Map<number, Proc>> {
    if (this.cache && Date.now() - this.cachedAt < maxAgeMs) {
      return Promise.resolve(this.cache)
    }
    if (this.inflight) return this.inflight
    this.inflight = this.enumerate()
      .then((map) => {
        this.cache = map
        this.cachedAt = Date.now()
        return map
      })
      .catch(() => this.cache ?? new Map<number, Proc>()) // keep last-good on failure
      .finally(() => {
        this.inflight = null
      })
    return this.inflight
  }

  /** Descendant PIDs of `rootPid` computed from a snapshot (no extra enumeration). */
  static descendants(rootPid: number, map: Map<number, Proc>): Proc[] {
    const childrenByParent = new Map<number, Proc[]>()
    for (const p of map.values()) {
      const list = childrenByParent.get(p.ppid)
      if (list) list.push(p)
      else childrenByParent.set(p.ppid, [p])
    }
    const out: Proc[] = []
    const stack = [...(childrenByParent.get(rootPid) ?? [])]
    const seen = new Set<number>()
    while (stack.length) {
      const p = stack.pop()!
      if (seen.has(p.pid)) continue
      seen.add(p.pid)
      out.push(p)
      const kids = childrenByParent.get(p.pid)
      if (kids) stack.push(...kids)
    }
    return out
  }

  /** Depth of `pid` below `rootPid` in the snapshot (1 = direct child). */
  static depth(pid: number, rootPid: number, map: Map<number, Proc>): number {
    let d = 0
    let cur = map.get(pid)
    while (cur && cur.ppid && cur.ppid !== rootPid && d < 12) {
      cur = map.get(cur.ppid)
      d++
    }
    return d + 1
  }

  private enumerate(): Promise<Map<number, Proc>> {
    return process.platform === 'win32' ? this.winSnapshot() : this.posixSnapshot()
  }

  /**
   * Windows has no /proc. Win32_Process (via CIM) is the only reliable source of both
   * ParentProcessId AND CommandLine — and we need CommandLine because agent CLIs often
   * run as a node/python child (e.g. `node ...\@anthropic-ai\claude-code\cli.js`).
   */
  private winSnapshot(): Promise<Map<number, Proc>> {
    const script =
      'Get-CimInstance Win32_Process | ' +
      'Select-Object ProcessId,ParentProcessId,Name,CommandLine | ' +
      'ConvertTo-Json -Compress'
    return new Promise((resolve) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 4000 },
        (err, stdout) => {
          if (err || !stdout) return resolve(this.cache ?? new Map())
          resolve(parseCimJson(stdout))
        },
      )
    })
  }

  /** POSIX: ps-list is pure ESM, so load it dynamically from our CJS main bundle. */
  private async posixSnapshot(): Promise<Map<number, Proc>> {
    const { default: psList } = await import('ps-list')
    const list = await psList()
    const map = new Map<number, Proc>()
    for (const p of list) {
      map.set(p.pid, { pid: p.pid, ppid: p.ppid ?? 0, name: p.name ?? '', cmd: p.cmd ?? '' })
    }
    return map
  }
}

function parseCimJson(stdout: string): Map<number, Proc> {
  const map = new Map<number, Proc>()
  let data: unknown
  try {
    data = JSON.parse(stdout)
  } catch {
    return map
  }
  // ConvertTo-Json emits a single object when there is exactly one process.
  const rows = Array.isArray(data) ? data : [data]
  for (const row of rows as Array<Record<string, unknown>>) {
    const pid = Number(row.ProcessId)
    if (!Number.isFinite(pid)) continue
    map.set(pid, {
      pid,
      ppid: Number(row.ParentProcessId) || 0,
      name: String(row.Name ?? ''),
      cmd: String(row.CommandLine ?? ''),
    })
  }
  return map
}
