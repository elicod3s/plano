/**
 * ProcessTreeService — a cheap, shared snapshot of the OS process list.
 *
 * Purpose is narrow and benign: PLANO only ever inspects the descendants of shells
 * IT ITSELF spawned (the PIDs node-pty hands us) so a terminal panel can show a nicer
 * UI when the user launches an AI coding CLI inside it — the same thing Warp / Wave do.
 *
 * The single most important scaling decision: ONE enumeration per cycle, cached and
 * reused by every terminal detector. 1 terminal and 30 terminals cost the same work.
 *
 * Windows perf: a COLD `powershell.exe -Command "Get-CimInstance Win32_Process"` spawn
 * costs ~1.5s here — almost all of it the PowerShell runtime start-up, not the query.
 * Detection fires this on a heartbeat, so cold-spawning per cycle pegged a core for ~1.5s
 * right as an agent CLI was booting and the user was typing — the input-lag/slow-morph bug.
 * We instead keep ONE long-lived PowerShell worker, fed queries over stdin: the runtime
 * start-up is paid ONCE (and pre-warmed via `warm()`), after which each enumeration is
 * ~50–300ms. A wedged/dead worker is killed and respawned; a one-shot `execFile` is the
 * fallback so detection never breaks if the worker can't be used.
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process'

export interface Proc {
  pid: number
  ppid: number
  /** image/base name, e.g. "node.exe", "claude", "python3" */
  name: string
  /** full command line when available (Windows via CIM; POSIX via ps) */
  cmd: string
  /** process start time, epoch ms (Windows via Win32_Process CreationDate). Undefined when
   *  unknown (e.g. the POSIX ps-list path) — used to match an agent process to the session
   *  file created at/after it started. */
  start?: number
}

// Snapshot freshness. With the long-lived worker an enumeration is ~50–300ms (was ~1.5s as a
// cold spawn), so we can afford a shorter TTL: it bounds how long after an agent CLI's child
// process appears we keep reading a stale (childless) snapshot — i.e. how fast the panel morphs.
const TTL_MS = 700
/** Hard ceiling on one enumeration; a worker that misses it is wedged → killed + respawned. */
const QUERY_TIMEOUT_MS = 4000
/** Printed by the worker after each query's JSON so we know its output is complete. */
const SENTINEL = '<<<PLANO_PROC_END>>>'
const WIN_QUERY =
  'Get-CimInstance Win32_Process | ' +
  'Select-Object ProcessId,ParentProcessId,Name,CommandLine,CreationDate | ' +
  'ConvertTo-Json -Compress'

export class ProcessTreeService {
  private cache: Map<number, Proc> | null = null
  private cachedAt = 0
  private inflight: Promise<Map<number, Proc>> | null = null

  // Long-lived Windows enumeration worker (see file header). Only ONE query is ever in
  // flight at a time because `ensureFresh` coalesces concurrent callers, so a single
  // pending slot + output accumulator is sufficient.
  private worker: ChildProcess | null = null
  private workerOut = ''
  private pending: { resolve: (map: Map<number, Proc>) => void; timer: NodeJS.Timeout } | null =
    null
  private warmed = false

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

  /**
   * Spin the enumeration worker up ahead of need (called when the first terminal opens) so
   * the ~1.5s PowerShell cold-start is paid in the background — long before the user launches
   * an agent CLI — instead of in the critical window where it would stall their typing.
   */
  warm(): void {
    if (this.warmed) return
    this.warmed = true
    if (process.platform === 'win32') void this.ensureFresh()
  }

  /** Kill the long-lived worker (graceful quit / teardown) so no PowerShell process is orphaned. */
  dispose(): void {
    if (this.pending) {
      clearTimeout(this.pending.timer)
      this.pending = null
    }
    const w = this.worker
    this.worker = null
    if (w) {
      try {
        w.stdin?.end()
      } catch {
        /* pipe already gone */
      }
      try {
        w.kill()
      } catch {
        /* already exited */
      }
    }
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

  /** Process start time (epoch ms) from the snapshot, or null when unknown. */
  static startTime(pid: number, map: Map<number, Proc>): number | null {
    return map.get(pid)?.start ?? null
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
   *
   * Served by the long-lived worker; falls back to a one-shot spawn if it can't be used.
   */
  private winSnapshot(): Promise<Map<number, Proc>> {
    const worker = this.ensureWorker()
    if (!worker || !worker.stdin?.writable) return this.winColdSnapshot()

    return new Promise((resolve) => {
      this.workerOut = ''
      const timer = setTimeout(() => {
        // Worker wedged — drop it so the next cycle respawns, and keep last-good for now.
        this.pending = null
        this.killWorker(worker)
        resolve(this.cache ?? new Map())
      }, QUERY_TIMEOUT_MS)

      this.pending = { resolve, timer }

      try {
        // `; Write-Output SENTINEL` marks the end of THIS query's output (the JSON is one
        // line because ConvertTo-Json -Compress emits no formatting whitespace).
        worker.stdin!.write(`${WIN_QUERY}; Write-Output '${SENTINEL}'\n`)
      } catch {
        clearTimeout(timer)
        this.pending = null
        this.killWorker(worker)
        // Fall back to a one-shot for this cycle.
        this.winColdSnapshot().then(resolve)
      }
    })
  }

  /** Lazily (re)spawn the persistent enumeration worker. Returns null if it can't start. */
  private ensureWorker(): ChildProcess | null {
    if (this.worker && this.worker.exitCode === null && !this.worker.killed) return this.worker
    try {
      // `-Command -` reads and executes statements from stdin as they arrive (verified), so
      // one process serves every enumeration. -NonInteractive suppresses the prompt noise.
      const w = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-NoLogo', '-Command', '-'],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] },
      )
      w.stdout?.setEncoding('utf8')
      w.stdout?.on('data', (chunk: string) => this.onWorkerData(chunk))
      const drop = (): void => {
        // A superseded worker (already killed/replaced) firing a late exit must NOT touch the
        // current worker's in-flight query — ignore it entirely.
        if (this.worker !== w) return
        this.worker = null
        // The ACTIVE worker died mid-query: resolve that waiter now (with last-good) instead of
        // leaving it to hang until the timeout; the next cycle respawns a fresh worker.
        const p = this.pending
        if (p) {
          this.pending = null
          clearTimeout(p.timer)
          p.resolve(this.cache ?? new Map())
        }
      }
      w.on('exit', drop)
      w.on('error', drop)
      this.worker = w
      return w
    } catch {
      this.worker = null
      return null
    }
  }

  /** Accumulate worker stdout; when the sentinel arrives, hand the JSON before it to the waiter. */
  private onWorkerData(chunk: string): void {
    this.workerOut += chunk
    const idx = this.workerOut.indexOf(SENTINEL)
    if (idx === -1) return
    const json = this.workerOut.slice(0, idx).trim()
    this.workerOut = this.workerOut.slice(idx + SENTINEL.length)
    const p = this.pending
    this.pending = null
    if (p) {
      clearTimeout(p.timer)
      p.resolve(parseCimJson(json))
    }
  }

  private killWorker(w: ChildProcess): void {
    if (this.worker === w) this.worker = null
    try {
      w.kill()
    } catch {
      /* already gone */
    }
  }

  /** One-shot fallback: the original cold spawn, used only when the worker is unavailable. */
  private winColdSnapshot(): Promise<Map<number, Proc>> {
    return new Promise((resolve) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', WIN_QUERY],
        { windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: QUERY_TIMEOUT_MS },
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
      start: parseCimDate(row.CreationDate),
    })
  }
  return map
}

/**
 * CIM CreationDate over ConvertTo-Json is `/Date(ms)/` on Windows PowerShell 5.1 and an ISO
 * string on PowerShell 7 — accept both. Returns epoch ms, or undefined if unparseable.
 */
function parseCimDate(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string' || !value) return undefined
  const m = /\/Date\((\d+)\)\//.exec(value)
  if (m) return Number(m[1])
  const t = Date.parse(value)
  return Number.isFinite(t) ? t : undefined
}
