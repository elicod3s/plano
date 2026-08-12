/**
 * AgentContextService — the CANONICAL source of agent/runtime context in the MAIN process.
 *
 * Why main and not React: PTYs keep running (and producing output) while their panels are
 * hibernated across workspace switches. The renderer only knows what it was sent; main is
 * the only place that can assemble a complete, always-fresh picture. This service:
 *
 *   - registers every PTY (stable identity from PtyManager);
 *   - ingests every byte of PTY output (clean tail per terminal);
 *   - receives detection verdicts, prompts, URLs and exits;
 *   - keeps a bounded timeline of agent events;
 *   - applies central redaction before anything leaves (mesh dispatch, CLI, search);
 *   - exposes snapshots/transcripts/timeline/search/scratchpad to IPC and the mesh.
 *
 * It works even when the renderer is detached — that is the entire point.
 */

import { EventEmitter } from 'node:events'
import { mkdirSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { AgentKind, AgentVerdict } from '@shared/domain/agent'
import { normalizeTerminalText, truncateText } from './terminalText'
import { redactContext } from './contextRedaction'
import type { PtyManager } from './PtyManager'
import type { AgentDetectionService } from './AgentDetectionService'

export const MESH_LIMITS = {
  /** Clean tail kept per PTY (raw output is far larger — this is the analysed slice). */
  tailBytes: 64 * 1024,
  /** A partial (unterminated) line is capped at this before it can grow unbounded. */
  partialLineBytes: 8 * 1024,
  /** Max timeline events held. */
  timelineEvents: 2000,
  /** A captured prompt is capped at this. */
  promptBytes: 4 * 1024,
  /** A snapshot's serialised payload is capped at this. */
  snapshotBytes: 512 * 1024,
  /** Transcript request limits. */
  transcriptLines: 200,
  transcriptBytes: 64 * 1024,
  /** Max agents in one dispatch. */
  maxDispatchTargets: 32,
  /** Max bytes per dispatched message (context + user prompt). */
  maxDispatchBytes: 32 * 1024,
} as const

export type MeshPromptSource = 'keyboard' | 'mesh' | 'voice'

export interface AgentPromptEvent {
  ptyId: string
  text: string
  first: boolean
  source: MeshPromptSource
  at: number
}

export type MeshTimelineKind =
  | 'agent-started'
  | 'phase-changed'
  | 'prompt-sent'
  | 'url-detected'
  | 'process-exited'
  | 'dispatch'

export interface MeshTimelineEvent {
  id: string
  at: number
  kind: MeshTimelineKind
  ptyId: string
  /** Human-readable one-liner, e.g. "Claude Code started in Terminal 2". */
  summary: string
  /** Optional agent kind at the time of the event. */
  agent?: AgentKind | null
}

export interface AgentContextEntry {
  ptyId: string
  terminalId: string
  panelId: string
  spaceId: string
  /** Snapshot-time identity (resolved from PtyManager). */
  cwd: string
  title: string
  pid: number
  exited: boolean
  verdict: AgentVerdict
  firstPrompt: string
  lastPrompt: string
  lastOutputAt: number
  updatedAt: number
  /** Normalised, redacted rolling tail (bounded). */
  tail: string
  /** Raw output stats (bytes seen) — metadata only, never the raw bytes. */
  bytesSeen: number
}

interface TimelineStats {
  lastPhase: string | null
}

export class AgentContextService extends EventEmitter {
  private readonly entries = new Map<string, AgentContextEntry>()
  private readonly timeline: MeshTimelineEvent[] = []
  private readonly phaseCache = new Map<string, TimelineStats>()
  private timelineSeq = 0
  /** Last persisted redacted index (JSON string), for change-detection on save. */
  private lastPersistedIndex: string | null = null

  constructor(
    private readonly pty: PtyManager,
    private readonly detection: AgentDetectionService,
  ) {
    super()
  }

  /** A PTY was created. Seed the entry from PtyManager's stable identity. */
  register(ptyId: string): void {
    const meta = this.pty.runtimeMeta(ptyId)
    if (!meta) return
    this.entries.set(ptyId, {
      ptyId,
      terminalId: meta.terminalId,
      panelId: meta.panelId,
      spaceId: meta.spaceId,
      cwd: meta.cwd,
      title: meta.title,
      pid: meta.pid,
      exited: meta.exited,
      verdict: this.detection.currentVerdict(ptyId),
      firstPrompt: '',
      lastPrompt: '',
      lastOutputAt: 0,
      updatedAt: Date.now(),
      tail: '',
      bytesSeen: 0,
    })
    this.emit('entry', ptyId)
    this.emit('changed')
  }

  /** PTY output — normalise + append to the bounded tail. NEVER stores raw bytes. */
  feed(ptyId: string, data: string): void {
    const e = this.entries.get(ptyId)
    if (!e || !data) return
    e.bytesSeen += data.length
    const clean = normalizeTerminalText(data)
    if (clean) {
      const next = e.tail + clean
      e.tail = next.length > MESH_LIMITS.tailBytes ? next.slice(-MESH_LIMITS.tailBytes) : next
      // Cap a single unterminated trailing line so a runaway progress line can't grow.
      const nl = e.tail.lastIndexOf('\n')
      if (nl !== -1 && e.tail.length - nl > MESH_LIMITS.partialLineBytes) {
        e.tail = e.tail.slice(0, nl + 1)
      }
      e.lastOutputAt = Date.now()
      e.updatedAt = Date.now()
      this.emit('changed')
    }
  }

  /** Detection verdict changed (or first arrived) for a PTY. */
  updateVerdict(ptyId: string, verdict: AgentVerdict): void {
    const e = this.entries.get(ptyId)
    if (!e) return
    const prev = e.verdict
    e.verdict = verdict
    e.updatedAt = Date.now()

    const kindChanged = !!verdict.active && verdict.kind !== prev.kind
    const phaseChanged = verdict.active && verdict.phase !== prev.phase
    if (kindChanged) {
      this.pushTimeline(ptyId, 'agent-started', `${verdict.displayName ?? 'Agent'} started`, verdict.kind)
      this.phaseCache.set(ptyId, { lastPhase: null })
    } else if (phaseChanged) {
      // Group repetitive working↔idle flapping: only record when the phase actually flips
      // to idle (the meaningful "turn finished" signal), and collapse consecutive ids.
      const stat = this.phaseCache.get(ptyId) ?? { lastPhase: null }
      if (verdict.phase === 'idle' && stat.lastPhase !== 'idle') {
        this.pushTimeline(ptyId, 'phase-changed', 'Agent turn finished (idle)', verdict.kind)
      }
      stat.lastPhase = verdict.phase ?? null
      this.phaseCache.set(ptyId, stat)
    } else if (!verdict.active && prev.active) {
      this.phaseCache.delete(ptyId)
    }
  }

  /** A prompt was captured (keyboard/mesh/voice). First prompt is frozen; last updates. */
  recordPrompt(e: AgentPromptEvent): void {
    const entry = this.entries.get(e.ptyId)
    if (!entry) return
    const text = truncateText(e.text, MESH_LIMITS.promptBytes).text
    if (!text) return
    if (e.first || !entry.firstPrompt) entry.firstPrompt = text
    entry.lastPrompt = text
    entry.updatedAt = Date.now()
    this.pushTimeline(
      e.ptyId,
      'prompt-sent',
      `${e.source === 'mesh' ? 'Mesh' : e.source === 'voice' ? 'Voice' : 'Prompt'}: ${text.slice(0, 80)}`,
      entry.verdict.kind,
    )
  }

  /** A local dev URL was detected in output. */
  recordUrl(ptyId: string, url: string): void {
    this.pushTimeline(ptyId, 'url-detected', `URL detected: ${url}`, this.entries.get(ptyId)?.verdict.kind)
    this.emit('changed')
  }

  /** A shell process exited. */
  markExited(ptyId: string): void {
    const e = this.entries.get(ptyId)
    if (!e) return
    e.exited = true
    e.updatedAt = Date.now()
    this.pushTimeline(ptyId, 'process-exited', 'Process exited', e.verdict.kind)
    this.emit('changed')
  }

  /** A mesh dispatch happened. */
  recordDispatch(ptyId: string, message: string): void {
    this.pushTimeline(ptyId, 'dispatch', `Mesh: ${message.slice(0, 80)}`, this.entries.get(ptyId)?.verdict.kind)
    this.emit('changed')
  }

  /** Remove a PTY from the registry (killed/closed). */
  unregister(ptyId: string): void {
    this.entries.delete(ptyId)
    this.phaseCache.delete(ptyId)
    this.emit('changed')
  }

  /** Drop one PTY's clean context (tail + prompts) but keep the registry entry (PTY lives on). */
  clearContext(ptyId: string): void {
    const e = this.entries.get(ptyId)
    if (!e) return
    e.tail = ''
    e.firstPrompt = ''
    e.lastPrompt = ''
    e.bytesSeen = 0
    e.updatedAt = Date.now()
    this.emit('changed')
  }

  // ── reads ──

  /** All live (or exited-but-registered) agent contexts, newest-updated first. */
  snapshot(): AgentContextEntry[] {
    return [...this.entries.values()].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  entry(ptyId: string): AgentContextEntry | null {
    return this.entries.get(ptyId) ?? null
  }

  /** Bounded, redacted transcript for one PTY (tail). Empty when the pty is unknown. */
  transcript(ptyId: string): { text: string; truncated: boolean; redactions: number } {
    const e = this.entries.get(ptyId)
    if (!e) return { text: '', truncated: false, redactions: 0 }
    const { text, truncated } = truncateText(e.tail, MESH_LIMITS.transcriptBytes)
    const { text: redacted, redactionCount } = redactContext(text)
    return { text: redacted, truncated, redactions: redactionCount }
  }

  /** Recent timeline events (newest first), capped. */
  timelineEvents(limit = 200): MeshTimelineEvent[] {
    return this.timeline.slice(-limit).reverse()
  }

  /** Case-insensitive in-memory search over clean tails + prompts. */
  search(query: string, opts: { workspace?: string; agent?: string; terminal?: string; limit?: number } = {}): {
    ptyId: string
    terminalId: string
    panelId: string
    spaceId: string
    title: string
    cwd: string
    kind: AgentKind | null
    snippet: string
    matches: number
  }[] {
    const q = query.trim().toLowerCase()
    const limit = opts.limit ?? 50
    if (!q) return []
    const out: {
      ptyId: string
      terminalId: string
      panelId: string
      spaceId: string
      title: string
      cwd: string
      kind: AgentKind | null
      snippet: string
      matches: number
    }[] = []
    for (const e of this.entries.values()) {
      if (opts.workspace && e.spaceId !== opts.workspace) continue
      if (opts.agent && e.verdict.kind !== opts.agent) continue
      if (opts.terminal && e.terminalId !== opts.terminal) continue
      const hay = `${e.tail}\n${e.firstPrompt}\n${e.lastPrompt}\n${e.title}`.toLowerCase()
      let idx = hay.indexOf(q)
      if (idx === -1) continue
      let matches = 0
      let cursor = 0
      while ((cursor = hay.indexOf(q, cursor)) !== -1) {
        matches++
        cursor += q.length
      }
      const from = Math.max(0, idx - 60)
      const snippet = e.tail.slice(from, from + 160) || `${e.firstPrompt} ${e.lastPrompt}`.slice(0, 160)
      const { text } = redactContext(snippet)
      out.push({
        ptyId: e.ptyId,
        terminalId: e.terminalId,
        panelId: e.panelId,
        spaceId: e.spaceId,
        title: e.title,
        cwd: e.cwd,
        kind: e.verdict.kind,
        snippet: text,
        matches,
      })
      if (out.length >= limit) break
    }
    return out
  }

  /** Total bytes held across all clean tails (metadata for the UI "usage" readout). */
  usageBytes(): number {
    let total = 0
    for (const e of this.entries.values()) total += e.tail.length
    return total
  }

  /**
   * Persist a REDACTED context index to <folder>/.plano/context/ (opt-in, atomic, rotated by
   * size). Returns bytes written, or 0 when nothing changed / not allowed. Never stores raw
   * output — every field passes through redactContext before touching disk.
   */
  async persistIndex(folder: string, maxBytes: number): Promise<number> {
    if (!folder) return 0
    const entries = [...this.entries.values()]
      .filter((e) => e.bytesSeen > 0 || e.firstPrompt || e.lastPrompt)
      .map((e) => {
        const tail = redactContext(truncateText(e.tail, 12_000).text).text
        return {
          ptyId: e.ptyId,
          terminalId: e.terminalId,
          panelId: e.panelId,
          spaceId: e.spaceId,
          cwd: e.cwd,
          title: e.title,
          verdict: e.verdict.active
            ? { kind: e.verdict.kind, phase: e.verdict.phase }
            : null,
          firstPrompt: redactContext(e.firstPrompt).text,
          lastPrompt: redactContext(e.lastPrompt).text,
          lastOutputAt: e.lastOutputAt,
          tail,
        }
      })
    const index = JSON.stringify({ savedAt: Date.now(), entries })
    if (index === this.lastPersistedIndex) return 0
    try {
      const dir = join(folder, '.plano', 'context')
      mkdirSync(dir, { recursive: true })
      const file = join(dir, 'index.json')
      let bytes = Buffer.byteLength(index)
      if (bytes > maxBytes) {
        // Rotation by size: keep the newest entries, drop oldest until under the cap.
        let trimmed = entries
        while (bytes > maxBytes && trimmed.length > 0) {
          trimmed = trimmed.slice(1)
          bytes = Buffer.byteLength(JSON.stringify({ savedAt: Date.now(), entries: trimmed }))
        }
      }
      const tmp = `${file}.${randomUUID()}.tmp`
      await fs.writeFile(tmp, index, 'utf8')
      await fs.rename(tmp, file)
      this.lastPersistedIndex = index
      return Buffer.byteLength(index)
    } catch {
      return 0
    }
  }

  dispose(): void {
    this.entries.clear()
    this.timeline.length = 0
    this.removeAllListeners()
  }

  // ── internals ──

  private pushTimeline(ptyId: string, kind: MeshTimelineKind, summary: string, agent?: AgentKind | null): void {
    this.timeline.push({ id: `t${++this.timelineSeq}`, at: Date.now(), kind, ptyId, summary, agent })
    if (this.timeline.length > MESH_LIMITS.timelineEvents) this.timeline.shift()
  }
}
