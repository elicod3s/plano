/**
 * UsageService — the Agent Host's collector for the status bar (plan PLAN_STATUS_BAR_LIVE_USAGE).
 *
 * One instance, owned by the daemon, started at boot after installCli. Refresh policy:
 *   - claude: PUSH-driven — the statusLine hook POSTs to /usage/claude (no polling).
 *   - file-backed (codex): 60 s poll; on error the interval doubles up to 15 min.
 *   - network-backed (opencode-go): 10 min refresh; Retry-After honoured when present.
 * Plus an immediate refresh on the `usage:refresh` RPC.
 *
 * The last good snapshot is cached to <userData>/usage.json so the bar populates instantly on
 * launch; cache-loaded providers render `stale` until their first live read lands. A provider
 * with no credentials is ABSENT from the snapshot — never a zero. Every snapshot change is
 * broadcast as a `usage` frame on the daemon→app channel (+ the phone WebSocket).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import type { ProviderUsage, UsageSnapshot, StatusbarAux } from '@shared/domain/usage'
import * as claude from './claude'
import * as codex from './codex'
import * as grok from './grok'
import { scanPorts, type PortScanSession } from './ports'
import { scanAgentRss, type ResourceScanSession } from './resources'
import type { ProcessTreeService } from '../../services/ProcessTreeService'

/**
 * Reading order of the island: the harnesses the user actually runs first, then everything else
 * alphabetically. Declared here (not left to whichever adapter answers first) so the row never
 * reshuffles between refreshes.
 */
const PROVIDER_ORDER = ['claude', 'codex', 'grok'] as const

function providerRank(provider: string): number {
  const i = PROVIDER_ORDER.indexOf(provider as (typeof PROVIDER_ORDER)[number])
  return i === -1 ? PROVIDER_ORDER.length : i
}

const FILE_INTERVAL_MS = 60_000
/**
 * Grok's billing endpoint is the only network read left, and a quota the user watches while
 * working has to move on its own — 10 minutes felt frozen. One call a minute is well inside the
 * endpoint's budget, and the error path still doubles the interval up to MAX_BACKOFF_MS.
 */
const NETWORK_INTERVAL_MS = 60_000
/** Claude's OAuth usage endpoint rate-limits hard — this is the slow fallback, not the feed. */
const CLAUDE_API_INTERVAL_MS = 5 * 60_000
const AUX_INTERVAL_MS = 30_000
const MAX_BACKOFF_MS = 15 * 60_000

export interface UsageServiceDeps {
  userData: string
  log: (message: string) => void
  /** Broadcast a daemon→app frame (also pushed to phone WebSocket clients). */
  broadcast: (frame: Record<string, unknown>) => void
  processTree: ProcessTreeService
  sessions: () => Array<PortScanSession & ResourceScanSession>
}

export class UsageService {
  private current: UsageSnapshot = { providers: [], at: 0 }
  private hook: claude.ClaudeHookResult | null = null
  /** Providers that had a live read this boot (cache-loaded ones stay `stale` until then). */
  private live = new Set<string>()
  private fileIntervalMs = FILE_INTERVAL_MS
  private networkIntervalMs = NETWORK_INTERVAL_MS
  private timers: ReturnType<typeof setInterval>[] = []
  private watchers: FSWatcher[] = []
  private codexDebounce: ReturnType<typeof setTimeout> | null = null
  private disposed = false
  private lastAuxAt = 0
  private lastClaudeApiAt = 0
  private auxState: StatusbarAux = { ports: [], resources: { agentRssBytes: 0, at: 0 } }
  private auxScanning: Promise<StatusbarAux> | null = null

  constructor(private readonly deps: UsageServiceDeps) {}

  private cachePath(): string {
    return join(this.deps.userData, 'usage.json')
  }

  start(): void {
    // The hook merge decides the claude chip's existence (absent / unavailable / push-fed).
    this.hook = claude.installUsageHook(this.deps.userData)
    this.loadCache()
    this.deps.log(`usage: hook merged=${this.hook.merged}${this.hook.reason ? ` reason=${this.hook.reason}` : ''}`)
    // Immediate first reads so the bar goes live quickly after launch.
    void this.refresh('all')
    this.timers.push(setInterval(() => void this.refresh('file'), FILE_INTERVAL_MS))
    this.timers.push(setInterval(() => void this.refresh('network'), NETWORK_INTERVAL_MS))
    this.timers.push(setInterval(() => void this.scanAux(), AUX_INTERVAL_MS))
    this.watchCodexSessions()
  }

  /**
   * Live codex usage: its rollout file is appended the moment a turn ends, so watching the
   * session directory turns a 60 s poll into a sub-second update — the poll stays as the safety
   * net for a watcher that silently dies (network drives, antivirus). Debounced, because one
   * turn writes several times.
   */
  private watchCodexSessions(): void {
    const dir = codex.sessionsRoot()
    if (!dir || !existsSync(dir)) return
    try {
      const watcher = watch(dir, { recursive: true }, () => {
        if (this.codexDebounce) clearTimeout(this.codexDebounce)
        this.codexDebounce = setTimeout(() => void this.refresh('file'), 800)
      })
      watcher.on('error', () => watcher.close())
      this.watchers.push(watcher)
    } catch {
      /* a watcher is an optimisation: the interval already covers correctness */
    }
  }

  /** The statusLine hook POSTed a payload (push-driven claude refresh). */
  postClaude(raw: unknown): void {
    const parsed = claude.postClaudePayload(raw)
    if (!parsed) return
    this.live.add('claude')
    this.upsert(parsed)
    this.commit()
  }

  async refresh(kind: 'file' | 'network' | 'all'): Promise<void> {
    if (this.disposed) return
    const runFile = kind === 'file' || kind === 'all'
    const runNetwork = kind === 'network' || kind === 'all'
    try {
      if (runFile) {
        const entry = await codex.read()
        if (entry) {
          this.live.add('codex')
          this.upsert(entry)
          this.fileIntervalMs = FILE_INTERVAL_MS
        } else {
          this.remove('codex')
          this.fileIntervalMs = FILE_INTERVAL_MS
        }
      }
    } catch (err) {
      this.deps.log(`usage: codex refresh failed: ${String(err)} — backoff ${this.fileIntervalMs}`)
      this.fileIntervalMs = Math.min(MAX_BACKOFF_MS, this.fileIntervalMs * 2)
    }
    // opencode-go is NOT polled: its quota is only readable with an opencode.ai web-session
    // cookie (the CLI's API key reaches the server as a public actor — verified live), so the
    // row could never be anything but "paste a cookie". A permanent apology in the island is
    // worse than no row. The adapter stays in the tree, ready to be re-registered here the day
    // a credential we actually have can read it.
    this.remove('opencode-go')
    try {
      if (runNetwork) {
        const entry = await grok.read()
        if (entry) {
          this.live.add('grok')
          this.upsert(entry)
          this.networkIntervalMs = NETWORK_INTERVAL_MS
        } else {
          this.remove('grok')
          this.networkIntervalMs = NETWORK_INTERVAL_MS
        }
      }
    } catch (err) {
      this.networkIntervalMs = Math.min(MAX_BACKOFF_MS, this.networkIntervalMs * 2)
      this.deps.log(`usage: grok refresh failed: ${String(err)} — backoff ${this.networkIntervalMs}`)
    }
    // Claude's OAuth endpoint is the SLOW path that makes the chip work without waiting for a
    // new Claude session (the CLI only reads settings.json at startup, so an already-open session
    // never fires the hook). Skipped entirely once the hook is feeding us live payloads, and kept
    // to its own cadence because this endpoint 429s under tight polling.
    try {
      if (runNetwork && !this.live.has('claude') && Date.now() - this.lastClaudeApiAt > CLAUDE_API_INTERVAL_MS) {
        this.lastClaudeApiAt = Date.now()
        const entry = await claude.readOauthUsage()
        if (entry) this.upsert(entry)
      }
    } catch (err) {
      this.lastClaudeApiAt = Date.now()
      this.deps.log(`usage: claude oauth usage failed: ${String(err)}`)
    }
    this.reconcileClaude()
    this.commit()
  }

  /** The claude provider's presence/status is driven by the hook install result. */
  private reconcileClaude(): void {
    const hook = this.hook
    const existing = this.current.providers.find((p) => p.provider === 'claude')
    if (existing && (existing.status === 'ok' || this.live.has('claude'))) return
    if (!hook || !hook.merged) {
      if (hook && hook.reason === 'a custom statusLine is installed') {
        this.upsert({
          provider: 'claude',
          status: 'unavailable',
          session: null,
          weekly: null,
          monthly: null,
          source: 'statusline',
          updatedAt: Date.now(),
          detail: hook.reason,
        })
        return
      }
      // No credentials (or the hook couldn't install) → absent, never zero.
      this.remove('claude')
      return
    }
    // Hook merged but no POST yet. Keep the last known windows from the cache: Claude reports
    // only when it takes a turn, so blanking them on every daemon restart left the user staring
    // at an empty chip for a budget that had not changed. They render `stale` until a fresh
    // payload lands — old numbers labelled old, never no numbers at all.
    this.upsert({
      provider: 'claude',
      status: this.live.has('claude') ? 'ok' : 'stale',
      session: existing?.session ?? null,
      weekly: existing?.weekly ?? null,
      premiumWeekly: existing?.premiumWeekly ?? null,
      premiumLabel: existing?.premiumLabel,
      monthly: existing?.monthly ?? null,
      source: 'statusline',
      updatedAt: existing?.updatedAt ?? Date.now(),
      detail: this.live.has('claude')
        ? undefined
        : existing?.session || existing?.weekly
          ? 'last known reading — Claude reports on its next turn'
          : 'waiting for the first statusLine event',
    })
  }

  /**
   * Insert or update one provider entry, keeping the snapshot in a FIXED reading order.
   * Whichever adapter happens to answer first must not reorder the island under the user's eyes,
   * so the order is declared (claude, codex, grok) and anything else follows, alphabetically.
   */
  private upsert(entry: ProviderUsage): void {
    const idx = this.current.providers.findIndex((p) => p.provider === entry.provider)
    if (idx >= 0) this.current.providers[idx] = entry
    else this.current.providers.push(entry)
    this.current.providers.sort((a, b) => providerRank(a.provider) - providerRank(b.provider) || a.provider.localeCompare(b.provider))
  }

  private remove(provider: string): void {
    const idx = this.current.providers.findIndex((p) => p.provider === provider)
    if (idx >= 0) this.current.providers.splice(idx, 1)
  }

  /** Persist + broadcast the current snapshot. */
  private commit(): void {
    this.current = { ...this.current, at: Date.now() }
    this.persist()
    this.deps.broadcast({ event: 'usage', usage: this.current })
  }

  /** Cache-load on boot: providers render `stale` until their first live read lands. */
  private loadCache(): void {
    try {
      if (!existsSync(this.cachePath())) return
      const doc = JSON.parse(readFileSync(this.cachePath(), 'utf8')) as UsageSnapshot
      if (!Array.isArray(doc.providers)) return
      this.current = {
        providers: doc.providers.map((p) => (p.status === 'unavailable' ? p : { ...p, status: 'stale' as const })),
        at: Date.now(),
      }
    } catch {
      /* corrupt cache — start empty */
    }
  }

  private persist(): void {
    try {
      mkdirSync(this.deps.userData, { recursive: true })
      const tmp = `${this.cachePath()}.${randomUUID()}.tmp`
      writeFileSync(tmp, JSON.stringify(this.current, null, 2), 'utf8')
      renameSync(tmp, this.cachePath())
    } catch {
      /* cache write must never crash the host */
    }
  }

  snapshot(): UsageSnapshot {
    return this.current
  }

  /** Current ports + resources, scanning on demand when the cached one is older than 30 s. */
  async aux(): Promise<StatusbarAux> {
    if (Date.now() - this.lastAuxAt < AUX_INTERVAL_MS && !this.auxScanning) return this.auxState
    return this.scanAux()
  }

  private scanAux(): Promise<StatusbarAux> {
    if (this.auxScanning) return this.auxScanning
    this.auxScanning = (async () => {
      const sessionList = this.deps.sessions()
      const [ports, agentRssBytes] = await Promise.all([
        scanPorts({ sessions: () => sessionList, processTree: this.deps.processTree }),
        scanAgentRss({ sessions: () => sessionList }),
      ])
      this.auxState = { ports, resources: { agentRssBytes, at: Date.now() } }
      this.lastAuxAt = Date.now()
      this.deps.broadcast({ event: 'statusbar-aux', aux: this.auxState })
      return this.auxState
    })().finally(() => {
      this.auxScanning = null
    })
    return this.auxScanning
  }

  /** Kill a port owner's process tree — only ever a PID the bar itself surfaced. */
  killPid(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false
    if (!this.auxState.ports.some((p) => p.pid === pid)) return false
    try {
      if (process.platform === 'win32') {
        const r = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 8000 })
        return r.status === 0
      }
      process.kill(pid, 'SIGKILL')
      return true
    } catch {
      return false
    }
  }

  dispose(): void {
    this.disposed = true
    for (const t of this.timers) clearInterval(t)
    this.timers = []
    for (const w of this.watchers) {
      try {
        w.close()
      } catch {
        /* already gone */
      }
    }
    this.watchers = []
    if (this.codexDebounce) clearTimeout(this.codexDebounce)
  }
}
