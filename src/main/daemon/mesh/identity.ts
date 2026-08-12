/**
 * Mesh identity (plan F2): every PTY spawned by the daemon gets its OWN mesh identity —
 * `PLANO_AGENT_ID` (the stable ptyId), a per-agent HMAC-derived token, and workspace context.
 * The token is revocable: it is only valid while the PTY is alive (the bus keeps the active
 * set and drops it when the session dies). The master secret lives in <userData>/mesh/ so it
 * survives restarts but never leaves the machine.
 */

import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Fresh id for a mesh message or spawn request. */
export function newMeshId(): string {
  return randomUUID()
}

/** The port the mesh WANTS (same one the mobile client uses). Not necessarily the one it got. */
export const PREFERRED_MESH_PORT = 56780

/**
 * The port the web server ACTUALLY bound. The daemon falls back to a random port when 56780 is
 * busy (daemon/index.ts) — and that happens for real, because a daemon from a previous version
 * survives the app closing and can still hold it. A hardcoded URL would then point every agent
 * and every harness config at the wrong process, and the mesh would die silently. So the URL is
 * derived from the live port and nothing hardcodes it.
 */
let meshPort = PREFERRED_MESH_PORT

/** Called once by the daemon after `listen()` resolves. */
export function setMeshPort(port: number): void {
  if (Number.isInteger(port) && port > 0) meshPort = port
}

/** The live mesh endpoint (the `plano` CLI's POST target). Always read this — never cache it
 *  at module load. The /mesh path stays mounted as a compat alias so terminals spawned by an
 *  older daemon (whose PLANO_MESH_URL env points at /mesh) keep working after an upgrade. */
export function meshUrl(): string {
  return `http://127.0.0.1:${meshPort}/cli`
}

let masterSecret = ''
/** ptyId → live token. Presence = the agent is connected and unrevoked. */
const liveTokens = new Map<string, string>()

/** Load (or create) the persistent master secret. Call once at daemon boot. */
export function initIdentity(userData: string): void {
  const dir = join(userData, 'mesh')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'master-secret')
  if (existsSync(file)) {
    masterSecret = readFileSync(file, 'utf8').trim()
  } else {
    masterSecret = randomBytes(32).toString('hex')
    writeFileSync(file, masterSecret, { mode: 0o600 })
  }
}

/** Derive the per-agent token for a ptyId and mark it live. */
export function agentToken(ptyId: string): string {
  const token = createHmac('sha256', masterSecret).update(ptyId).digest('hex')
  liveTokens.set(ptyId, token)
  return token
}

/** Revoke an agent's identity (called when its session dies). */
export function revokeAgent(ptyId: string): void {
  liveTokens.delete(ptyId)
}

/** Resolve a presented token to its agent id, or null when unknown/revoked. */
export function resolveAgent(token: string): string | null {
  if (typeof token !== 'string' || token.length === 0) return null
  for (const [ptyId, live] of liveTokens) {
    if (live === token) return ptyId
  }
  return null
}
