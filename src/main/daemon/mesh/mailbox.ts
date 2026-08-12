/**
 * Durable mailboxes (plan F1): per-agent queues persisted under <userData>/mesh/ so no message
 * is lost when the daemon restarts (agents survive app closes — their mesh must too).
 * Writes are atomic (temp + rename) with a size cap and rotation, mirroring agent-host.json.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MeshMessage } from './types'

const MAX_MAILBOX_BYTES = 512 * 1024
const MAX_MESSAGES_PER_BOX = 200

export class MailboxStore {
  private dir: string
  private boxes = new Map<string, MeshMessage[]>()

  constructor(userData: string) {
    this.dir = join(userData, 'mesh')
    mkdirSync(this.dir, { recursive: true })
  }

  private fileFor(agentId: string): string {
    return join(this.dir, `inbox-${agentId.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`)
  }

  /** Load an agent's persisted box (or start empty). */
  load(agentId: string): MeshMessage[] {
    const cached = this.boxes.get(agentId)
    if (cached) return cached
    const file = this.fileFor(agentId)
    let messages: MeshMessage[] = []
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8'))
        if (Array.isArray(parsed)) messages = parsed.filter((m) => typeof m?.id === 'string')
      } catch {
        messages = []
      }
    }
    this.boxes.set(agentId, messages)
    return messages
  }

  /** Queue a message for an agent. Returns the box size (for the pending counter). */
  push(agentId: string, message: MeshMessage): number {
    const box = this.load(agentId)
    box.push(message)
    while (box.length > MAX_MESSAGES_PER_BOX) box.shift()
    this.persist(agentId, box)
    return box.length
  }

  /** Remove an acked/expired message. Returns true when anything was removed. */
  remove(agentId: string, messageId: string): boolean {
    const box = this.load(agentId)
    const before = box.length
    const next = box.filter((m) => m.id !== messageId)
    if (next.length === before) return false
    this.persist(agentId, next)
    return true
  }

  /** Prune expired messages; returns the box with only live messages. */
  prune(agentId: string, now: number): MeshMessage[] {
    const box = this.load(agentId)
    const live = box.filter((m) => m.ttl === 0 || m.at + m.ttl > now)
    if (live.length !== box.length) this.persist(agentId, live)
    return live
  }

  /** Drop an agent's whole box (v3 §3.5 — the agent died / was deprovisioned). */
  clear(agentId: string): void {
    this.boxes.delete(agentId)
    try {
      unlinkSync(this.fileFor(agentId))
    } catch {
      /* nothing persisted — fine */
    }
  }

  private persist(agentId: string, box: MeshMessage[]): void {
    this.boxes.set(agentId, box)
    const file = this.fileFor(agentId)
    // Rotate when oversized: drop the oldest half instead of growing unbounded.
    let payload = JSON.stringify(box)
    if (Buffer.byteLength(payload) > MAX_MAILBOX_BYTES) {
      const trimmed = box.slice(Math.floor(box.length / 2))
      payload = JSON.stringify(trimmed)
      this.boxes.set(agentId, trimmed)
    }
    const tmp = `${file}.tmp`
    writeFileSync(tmp, payload, 'utf8')
    renameSync(tmp, file)
  }
}
