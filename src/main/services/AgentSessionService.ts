/**
 * AgentSessionService — resolve & cache the resumable conversation reference for the AI-agent
 * CLI running inside a terminal, so a reopened workspace can re-enter that exact conversation.
 *
 * It reuses the ONE detection signature table (via `AgentDetectionService.matchedAgentPid`) and
 * the ONE shared `Win32_Process` snapshot (via `ProcessTreeService`) — no duplicated scanning.
 * Resolution: matched agent pid → its start time → the session file in the agent's store created
 * at/after that start. A sidecar report keeps exact ids for sessions we resume ourselves (their
 * on-disk file has an old birthtime that file-matching alone would miss).
 */

import { app } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AgentSessionRef, ResumableAgent } from '@shared/domain/agent'
import { RESUMABLE_AGENTS, SESSION_ID_RE } from '@shared/domain/agent'
import { ProcessTreeService } from './ProcessTreeService'
import type { AgentDetectionService } from './AgentDetectionService'
import {
  codexDayDirs,
  escapeClaudeProjectDir,
  geminiChatsDir,
  parseRolloutName,
  readGeminiSessionId,
  readRolloutMeta,
  resolveByBirthtime,
} from './agentSession/lib'

/** Slack when comparing file/process timestamps — covers coarse fs times + wrapper ordering. */
const START_SLACK_MS = 30_000

interface CacheEntry {
  agentPid: number
  ref: AgentSessionRef
}

const normCwd = (p: string): string => p.replace(/[/\\]+$/, '').replace(/\//g, '\\').toLowerCase()

export class AgentSessionService {
  private readonly shellPidByPty = new Map<string, number>()
  /** ptyId → last resolved session for the agent pid that produced it. A new agent pid in the
   *  same terminal (user exited + relaunched) re-resolves. */
  private readonly cache = new Map<string, CacheEntry>()

  constructor(
    private readonly detection: AgentDetectionService,
    private readonly tree: ProcessTreeService,
  ) {}

  register(ptyId: string, shellPid: number): void {
    this.shellPidByPty.set(ptyId, shellPid)
  }

  unregister(ptyId: string): void {
    this.shellPidByPty.delete(ptyId)
    this.cache.delete(ptyId)
  }

  /**
   * Resolve the resumable conversation ref for the agent currently running under this terminal,
   * or null when none is running / it isn't resumable. `liveCwd` is the terminal's OSC-7 cwd.
   */
  async resolve(ptyId: string, liveCwd: string): Promise<AgentSessionRef | null> {
    const match = await this.detection.matchedAgentPid(ptyId)
    if (!match) return null
    const agent = RESUMABLE_AGENTS[match.kind]
    if (!agent) return null

    const cached = this.cache.get(ptyId)
    if (cached && cached.agentPid === match.pid) return cached.ref

    const cwd = liveCwd
    const ref: AgentSessionRef = { agent, cwd }

    const map = await this.tree.ensureFresh()
    const startMs = ProcessTreeService.startTime(match.pid, map)

    // Sidecar first (exact + survives a self-resumed session), then store scan.
    const sidecar = this.readSidecar(ptyId, agent, startMs)
    if (sidecar) {
      ref.sessionId = sidecar
    } else if (startMs != null && cwd) {
      ref.sessionId = this.resolveSessionId(agent, startMs, cwd, this.claimedSessionIds(ptyId)) ?? undefined
    }

    // Cache only settled resolutions: an id was found, OR the agent has an id-less fallback
    // (cursor/opencode/kiro). An unresolved claude/codex (file not created yet) is retried next call.
    const settled = !!ref.sessionId || agent === 'cursor' || agent === 'opencode' || agent === 'kiro'
    if (settled) this.cache.set(ptyId, { agentPid: match.pid, ref })
    return ref
  }

  /**
   * Whether the conversation behind `ref` still exists on disk for a resume run from `cwd`.
   * `null` for stores we can't verify locally (codex resumes by global id; cursor/kiro/opencode
   * have no checkable per-cwd file) — callers should proceed. `false` guards the "id pre-assigned
   * but never used" and "deleted since save" cases (which would make the CLI exit with an error).
   */
  validate(ref: AgentSessionRef, cwd: string): boolean | null {
    if (ref.agent === 'claude') {
      const sid = ref.sessionId
      if (!sid || !SESSION_ID_RE.test(sid)) return false
      return fs.existsSync(
        path.join(os.homedir(), '.claude', 'projects', escapeClaudeProjectDir(cwd), `${sid}.jsonl`),
      )
    }
    if (ref.agent === 'gemini') {
      const sid = ref.sessionId
      if (!sid || !SESSION_ID_RE.test(sid)) return false
      const dir = geminiChatsDir(cwd)
      if (!dir) return false
      try {
        return fs
          .readdirSync(dir)
          .some(
            (name) =>
              name.startsWith('session-') &&
              name.endsWith('.json') &&
              readGeminiSessionId(path.join(dir, name)) === sid,
          )
      } catch {
        return false
      }
    }
    return null
  }

  /** Re-seed the sidecar so a session we just resumed keeps its id across the NEXT restart. */
  report(ptyId: string, ref: AgentSessionRef): void {
    if (!ref.sessionId || !SESSION_ID_RE.test(ref.sessionId)) return
    if (!/^[\w-]+$/.test(ptyId)) return
    try {
      const dir = this.reportDir()
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(
        path.join(dir, `${ptyId}.json`),
        JSON.stringify({ agent: ref.agent, sessionId: ref.sessionId }),
        'utf-8',
      )
    } catch {
      /* fail-quiet: restore falls back to file matching / id-less resume */
    }
  }

  // ── internals ──

  private resolveSessionId(
    agent: ResumableAgent,
    startMs: number,
    cwd: string,
    claimed: ReadonlySet<string>,
  ): string | null {
    if (agent === 'claude') {
      const dir = path.join(os.homedir(), '.claude', 'projects', escapeClaudeProjectDir(cwd))
      return resolveByBirthtime(dir, startMs, START_SLACK_MS, claimed, (name) =>
        name.endsWith('.jsonl') ? name.slice(0, -'.jsonl'.length) : null,
      )
    }
    if (agent === 'gemini') {
      const dir = geminiChatsDir(cwd)
      if (!dir) return null
      return resolveByBirthtime(dir, startMs, START_SLACK_MS, claimed, (name, fullPath) =>
        name.startsWith('session-') && name.endsWith('.json') ? readGeminiSessionId(fullPath) : null,
      )
    }
    if (agent === 'codex') return this.resolveCodexSessionId(startMs, cwd, claimed)
    // cursor / opencode / kiro: no readable per-pid id → id-less resume.
    return null
  }

  private resolveCodexSessionId(
    startMs: number,
    cwd: string,
    claimed: ReadonlySet<string>,
  ): string | null {
    const candidates: { filePath: string; ms: number; sessionId: string }[] = []
    for (const dir of codexDayDirs(startMs)) {
      let names: string[]
      try {
        names = fs.readdirSync(dir)
      } catch {
        continue
      }
      for (const name of names) {
        const parsed = parseRolloutName(name)
        if (!parsed || claimed.has(parsed.sessionId)) continue
        if (Math.abs(parsed.ms - startMs) > START_SLACK_MS) continue
        candidates.push({ filePath: path.join(dir, name), ...parsed })
      }
    }
    candidates.sort((a, b) => Math.abs(a.ms - startMs) - Math.abs(b.ms - startMs))
    for (const c of candidates) {
      const meta = readRolloutMeta(c.filePath)
      if (!meta) continue
      if (cwd && meta.cwd && normCwd(meta.cwd) !== normCwd(cwd)) continue
      const sid = meta.id ?? c.sessionId
      if (SESSION_ID_RE.test(sid)) return sid
    }
    return null
  }

  /** Session ids already owned by other live terminals — never match one to a second terminal. */
  private claimedSessionIds(excludePtyId: string): Set<string> {
    const claimed = new Set<string>()
    for (const [ptyId, entry] of this.cache) {
      if (ptyId === excludePtyId) continue
      if (entry.ref.sessionId) claimed.add(entry.ref.sessionId)
    }
    return claimed
  }

  private readSidecar(ptyId: string, agent: ResumableAgent, startMs: number | null): string | null {
    if (!/^[\w-]+$/.test(ptyId)) return null
    try {
      const file = path.join(this.reportDir(), `${ptyId}.json`)
      const stat = fs.statSync(file)
      // A report older than this agent process is from a previous run in the same terminal.
      if (startMs != null && stat.mtimeMs < startMs - START_SLACK_MS) return null
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as {
        agent?: string
        sessionId?: string
      }
      if (parsed.agent !== agent) return null
      if (!parsed.sessionId || !SESSION_ID_RE.test(parsed.sessionId)) return null
      return parsed.sessionId
    } catch {
      return null
    }
  }

  private reportDir(): string {
    return path.join(app.getPath('userData'), 'agent-reports')
  }
}
