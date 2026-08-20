/**
 * ports — listening sockets owned by this workspace's terminals.
 *
 * Reuses ProcessTreeService's snapshot for the descendant check: a listening socket is shown
 * only when its owning PID is a descendant of a PLANO PTY shell (the daemon's own web/TCP
 * listeners are owned by the daemon process itself, never a PTY descendant, so they can't leak
 * in). Windows: `Get-NetTCPConnection -State Listen`; POSIX: `lsof -iTCP -sTCP:LISTEN`.
 */

import { execFile } from 'node:child_process'
import type { PortInfo } from '@shared/domain/usage'
import { ProcessTreeService } from '../../services/ProcessTreeService'
import type { Proc } from '../../services/ProcessTreeService'

export interface PortScanSession {
  ptyId: string
  pid: number
  panelId: string
  terminalId: string
}

export interface PortScanDeps {
  sessions: () => PortScanSession[]
  processTree: ProcessTreeService
}

const SCAN_TIMEOUT_MS = 10_000

interface ListenEntry {
  port: number
  pid: number
  name: string
}

/** One-shot listening-socket scan; never throws (returns [] on any failure). */
async function rawListeners(): Promise<ListenEntry[]> {
  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      execFile(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          "Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -gt 0 } | Select-Object LocalPort,OwningProcess | ConvertTo-Json -Compress",
        ],
        { windowsHide: true, timeout: SCAN_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout) => {
          if (err || !stdout) return resolve([])
          try {
            const data = JSON.parse(stdout.trim())
            const rows = Array.isArray(data) ? data : [data]
            const out: ListenEntry[] = []
            for (const r of rows) {
              const port = Number(r.LocalPort)
              const pid = Number(r.OwningProcess)
              if (Number.isFinite(port) && Number.isFinite(pid) && port > 0 && pid > 0) {
                out.push({ port, pid, name: '' })
              }
            }
            resolve(out)
          } catch {
            resolve([])
          }
        },
      )
    })
  }
  // Linux: prefer `ss` (always present via iproute), fall back to `lsof`.
  // `ss -tlnpH` prints: "State Recv-Q Send-Q Local Address:Port Peer Address:Port users:(("name",pid=N,fd=M))"
  if (process.platform === 'linux') {
    return new Promise((resolve) => {
      execFile('ss', ['-tlnpH'], { timeout: SCAN_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (ssErr, ssStdout) => {
        if (!ssErr && ssStdout) {
          resolve(parseSs(ssStdout))
          return
        }
        // Fallback: lsof -iTCP -sTCP:LISTEN
        execFile('lsof', ['-iTCP', '-sTCP:LISTEN', '-P', '-n'], { timeout: SCAN_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
          if (err || !stdout) return resolve([])
          resolve(parseLsof(stdout))
        })
      })
    })
  }
  // macOS and other POSIX: lsof -iTCP -sTCP:LISTEN → "COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME"
  return new Promise((resolve) => {
    execFile('lsof', ['-iTCP', '-sTCP:LISTEN', '-P', '-n'], { timeout: SCAN_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err || !stdout) return resolve([])
      resolve(parseLsof(stdout))
    })
  })
}

/** Parse `ss -tlnpH` output. Never throws — returns [] on any parse failure. */
function parseSs(stdout: string): ListenEntry[] {
  const out: ListenEntry[] = []
  for (const line of stdout.split(/\r?\n/).slice(1)) {
    // Match a port at the end of the Local Address:Port column, then the users:() field for pid.
    const portMatch = /[:\]](\d+)\s+\S+\s+/.exec(line)
    const userMatch = /users:\(\("([^"]+)",pid=(\d+),fd=\d+\)\)/.exec(line)
    if (!portMatch || !userMatch) continue
    const port = Number(portMatch[1])
    const pid = Number(userMatch[2])
    if (!Number.isFinite(port) || !Number.isFinite(pid)) continue
    out.push({ port, pid, name: userMatch[1] })
  }
  return out
}

/** Parse `lsof -iTCP -sTCP:LISTEN -P -n` output. Never throws — returns [] on any parse failure. */
function parseLsof(stdout: string): ListenEntry[] {
  const out: ListenEntry[] = []
  const lines = stdout.split(/\r?\n/).slice(1)
  for (const line of lines) {
    const cols = line.trim().split(/\s+/)
    if (cols.length < 9) continue
    const name = cols[0]
    const pid = Number(cols[1])
    const addr = cols[8]
    const portMatch = /:(\d+)$/.exec(addr)
    if (!portMatch || !Number.isFinite(pid)) continue
    out.push({ port: Number(portMatch[1]), pid, name })
  }
  return out
}

/** Listening ports whose owning PID is a descendant of a PLANO PTY shell, joined to panels. */
export async function scanPorts(deps: PortScanDeps): Promise<PortInfo[]> {
  const [listeners, map] = await Promise.all([
    rawListeners().catch(() => [] as ListenEntry[]),
    deps.processTree.ensureFresh(5000).catch(() => new Map<number, Proc>()),
  ])
  if (listeners.length === 0) return []
  const sessions = deps.sessions()
  const roots = sessions.filter((s) => s.pid > 0)
  const ownerToSession = new Map<number, PortScanSession>()
  for (const s of roots) {
    ownerToSession.set(s.pid, s)
    for (const p of ProcessTreeService.descendants(s.pid, map)) ownerToSession.set(p.pid, s)
  }
  const seen = new Set<string>()
  const out: PortInfo[] = []
  for (const l of listeners) {
    const session = ownerToSession.get(l.pid)
    if (!session) continue
    const key = `${l.port}:${session.ptyId}`
    if (seen.has(key)) continue
    seen.add(key)
    const proc = map.get(l.pid)
    out.push({
      port: l.port,
      pid: l.pid,
      name: (proc?.name ?? l.name).replace(/\.exe$/i, ''),
      panelId: session.panelId,
      terminalId: session.terminalId,
      title: `Terminal ${session.terminalId.slice(-4)}`,
    })
  }
  out.sort((a, b) => a.port - b.port)
  return out
}
