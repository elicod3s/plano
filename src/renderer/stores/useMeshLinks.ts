/**
 * Mesh link state (plan F7 + v3 E): the renderer-side mirror of PERSISTENT relations.
 * The DAEMON is the source of truth and pushes a full relation snapshot per 'link'
 * event — the renderer never reconstructs links from message events. One line per pair
 * (grouped by a counter), states active/waiting/done/failed, direction from the link's
 * emitter→receiver. Done/failed links fade/flash then leave; a closed panel removes its
 * relations with it (agent-down), so no ghost lines survive.
 */

import { useSyncExternalStore } from 'react'
import { AGENTS } from '@shared/domain/agent'
import type { MeshUiEvent } from '@shared/domain/agentMesh'

export interface MeshLink {
  /** Stable pair key (ordered pty ids, same as the daemon). */
  id: string
  fromPanel: string
  toPanel: string
  color: string
  /** idle (at-rest mesh line) | active | waiting | done (fading) | failed (flashing). */
  state: 'idle' | 'active' | 'waiting' | 'done' | 'failed'
  /** Open messages/asks between the pair (drawn as a counter when > 1). */
  count: number
  since: number
  /** v4 A4/B1: an armed chain exists — the line is dashed until it fires. */
  chained?: boolean
}

const links = new Map<string, MeshLink>()
const panelByPty = new Map<string, { panelId: string; kind: string }>()
const listeners = new Set<() => void>()
/** v4 awareness: raw mesh events for side consumers (agentActivity detector). */
const rawListeners = new Set<(ev: MeshUiEvent) => void>()

/** v4 A3: queued (un-delivered) messages per target — the ▾N counter + tooltip senders. */
const pendingByTo = new Map<string, { count: number; froms: string[] }>()
/** v4 A3: latest mesh state per pty (awaiting-input → amber breathing dot). */
const stateByPty = new Map<string, string>()
/** v4 A5: recent mesh events (the Mesh view timeline). */
const timelineEvents: Array<{ at: number; kind: string; from: string; to?: string; detail?: string }> = []

/** Arrival highlight per panel — the last delivered message's accent, fading out. */
export interface MeshArrival {
  id: string
  color: string
  /** v4 A3: unconfirmed delivery (written-but-unconfirmed) — one dim pulse. */
  dim?: boolean
}
const arrivals = new Map<string, MeshArrival>()
/** Cached snapshot — useSyncExternalStore REQUIRES the same reference until data changes. */
let linksSnapshot: MeshLink[] = []

function emit(): void {
  linksSnapshot = [...links.values()]
  for (const listener of listeners) listener()
}

function agentColor(kind: string): string {
  const key = kind as keyof typeof AGENTS
  return AGENTS[key]?.accent ?? '#8b9bff'
}

/** Ingest one mesh timeline event forwarded by the daemon. */
export function ingestMeshEvent(ev: MeshUiEvent): void {
  // v4 awareness: side consumers (agentActivity) see every raw event first.
  for (const cb of rawListeners) {
    try {
      cb(ev)
    } catch {
      /* a broken consumer never breaks the link store */
    }
  }
  // v4 A5: the Mesh view's audit trail — newest first, bounded.
  timelineEvents.unshift({ at: ev.at, kind: ev.kind, from: ev.from, to: ev.to, detail: ev.detail })
  if (timelineEvents.length > 60) timelineEvents.length = 60
  if (ev.kind === 'agent-up') {
    panelByPty.set(ev.from, { panelId: ev.panelId ?? '', kind: ev.detail ?? '' })
    return
  }
  if (ev.kind === 'agent-down') {
    const gone = panelByPty.get(ev.from)
    panelByPty.delete(ev.from)
    pendingByTo.delete(ev.from)
    stateByPty.delete(ev.from)
    if (gone?.panelId) {
      // v3 E: a closed panel takes its relations with it — no ghost lines.
      for (const [key, link] of links) {
        if (link.fromPanel === gone.panelId || link.toPanel === gone.panelId) links.delete(key)
      }
      arrivals.delete(gone.panelId)
    }
    emit()
    return
  }
  if (ev.kind === 'state' && ev.from) {
    // v4 A3: mesh state per pty — awaiting-input drives the amber breathing dot.
    stateByPty.set(ev.from, ev.detail ?? '')
    emit()
    return
  }
  if (ev.kind === 'msg-queued' && ev.from && ev.to) {
    // v4 A3: a queued message is visible (▾N) until delivered.
    const entry = pendingByTo.get(ev.to)
    if (entry) {
      entry.count += 1
      if (!entry.froms.includes(ev.from)) entry.froms = [ev.from, ...entry.froms].slice(0, 3)
    } else {
      pendingByTo.set(ev.to, { count: 1, froms: [ev.from] })
    }
    emit()
    return
  }
  if (ev.kind === 'msg-delivered' && ev.to) {
    const entry = pendingByTo.get(ev.to)
    if (entry) {
      entry.count = Math.max(0, entry.count - 1)
      if (entry.count === 0) pendingByTo.delete(ev.to)
      emit()
    }
    return
  }
  if (ev.kind === 'msg-delivered') {
    // One-shot arrival highlight (accent border fade on the receiver panel).
    // v4 A3: an unconfirmed delivery flashes once, more dimly — written ≠ accepted.
    const from = panelByPty.get(ev.from)
    const to = ev.to ? panelByPty.get(ev.to) : undefined
    if (from && to && to.panelId && from.panelId) {
      const dim = (ev.detail ?? '').includes('written-but-unconfirmed')
      arrivals.set(to.panelId, { id: `${ev.from}\u2192${ev.to}:${ev.at}`, color: agentColor(from.kind), dim })
      setTimeout(() => {
        if (arrivals.delete(to.panelId)) emit()
      }, dim ? 900 : 1600)
    }
    return
  }
  if (ev.kind === 'link' && ev.link) {
    const l = ev.link
    const from = panelByPty.get(l.from)
    const to = panelByPty.get(l.to)
    if (!from || !to || !from.panelId || !to.panelId) return
    const key = `${l.a}\u2192${l.b}`
    if (l.count <= 0 && (l.state === 'done' || l.state === 'failed')) {
      // Resolved/failed: flash, then settle back to the at-rest mesh line (v4 A1) —
      // the line persists until a panel closes; it never disappears mid-session.
      const existing = links.get(key)
      if (existing) {
        existing.state = l.state
        existing.count = 0
        emit()
        const restMs = l.state === 'failed' ? 500 : 2200
        setTimeout(() => {
          const cur = links.get(key)
          if (cur && cur.state === l.state) {
            cur.state = 'idle'
            emit()
          }
        }, restMs)
      }
      return
    }
    links.set(key, {
      id: key,
      fromPanel: from.panelId,
      toPanel: to.panelId,
      color: agentColor(l.kind),
      state: l.state,
      count: l.count,
      since: l.since,
      chained: l.chained,
    })
    emit()
  }
}

export function subscribeLinks(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

export function getLinks(): MeshLink[] {
  return linksSnapshot
}

export function useMeshLinks(): MeshLink[] {
  return useSyncExternalStore(subscribeLinks, getLinks, () => [])
}

/** The receiver panel's one-shot arrival highlight (accent border fade). */
export function useMeshArrival(panelId: string): MeshArrival | null {
  return useSyncExternalStore(
    subscribeLinks,
    () => arrivals.get(panelId) ?? null,
    () => null,
  )
}

const NO_MEMBERSHIP = { member: false, peers: 0 }
const NO_PENDING = { count: 0, froms: [] as string[] }
let membershipCache = new Map<string, { member: boolean; peers: number }>()
let pendingCache = new Map<string, { count: number; froms: string[] }>()
let stateCache = new Map<string, string | null>()
let timelineCache: Array<{ at: number; kind: string; from: string; to?: string; detail?: string }> = []

/**
 * v4 A2: is this pty a live mesh member, and how many peers are there? Drives the
 * tiny node glyph in the panel header. Snapshot is cached (useSyncExternalStore
 * requires stable references).
 */
export function useMeshMembership(ptyId: string): { member: boolean; peers: number } {
  return useSyncExternalStore(
    subscribeLinks,
    () => {
      const member = panelByPty.has(ptyId)
      const peers = Math.max(0, panelByPty.size - 1)
      const cached = membershipCache.get(ptyId)
      if (cached && cached.member === member && cached.peers === peers) return cached
      const next = { member, peers }
      membershipCache.set(ptyId, next)
      return next
    },
    () => NO_MEMBERSHIP,
  )
}

/** v4 A3: queued messages for this pty (▾N counter + senders in the tooltip). */
export function useMeshPending(ptyId: string): { count: number; froms: string[] } {
  return useSyncExternalStore(
    subscribeLinks,
    () => {
      const entry = pendingByTo.get(ptyId)
      if (!entry) return NO_PENDING
      const key = `${entry.count}:${entry.froms.join(',')}`
      const cached = pendingCache.get(ptyId)
      if (cached && `${cached.count}:${cached.froms.join(',')}` === key) return cached
      const next = { count: entry.count, froms: [...entry.froms] }
      pendingCache.set(ptyId, next)
      return next
    },
    () => NO_PENDING,
  )
}

/** v4 A3: latest mesh state for this pty (null when unknown). */
export function useMeshState(ptyId: string): string | null {
  return useSyncExternalStore(
    subscribeLinks,
    () => {
      const value = stateByPty.get(ptyId) ?? null
      const cached = stateCache.get(ptyId)
      if (cached === value) return cached
      stateCache.set(ptyId, value)
      return value
    },
    () => null,
  )
}

/** v4 A5: the Mesh view's audit trail (newest first, bounded). */
export function useMeshTimeline(): Array<{ at: number; kind: string; from: string; to?: string; detail?: string }> {
  return useSyncExternalStore(
    subscribeLinks,
    () => {
      const cached = timelineCache
      if (cached.length === timelineEvents.length && cached[0]?.at === timelineEvents[0]?.at) return cached
      timelineCache = timelineEvents.map((e) => ({ ...e }))
      return timelineCache
    },
    () => [],
  )
}

let membersCache: Array<{ ptyId: string; panelId: string; kind: string }> = []
let awaitingCache: ReadonlyMap<string, string> | null = null

/** v4 awareness: raw mesh events for side consumers (agentActivity detector). */
export function subscribeRawMeshEvent(cb: (ev: MeshUiEvent) => void): () => void {
  rawListeners.add(cb)
  return () => {
    rawListeners.delete(cb)
  }
}

/** v4 awareness: the panel + kind hosting a pty ('' / 'unknown' when gone). */
export function meshPanelFor(ptyId: string): { panelId: string; kind: string } {
  return panelByPty.get(ptyId) ?? { panelId: '', kind: 'unknown' }
}

/** v4 awareness: awaiting-input states per pty — the shared amber source (stable ref). */
export function useMeshAwaiting(): ReadonlyMap<string, string> {
  return useSyncExternalStore(
    subscribeLinks,
    () => {
      const cached = awaitingCache
      if (cached && cached.size === stateByPty.size && [...cached.keys()].every((k) => stateByPty.get(k) === cached.get(k))) return cached
      awaitingCache = new Map(stateByPty)
      return awaitingCache
    },
    () => new Map<string, string>(),
  )
}

/** v4 A5: every live mesh member (graph nodes for the Mesh view). */
export function useMeshMembers(): Array<{ ptyId: string; panelId: string; kind: string }> {
  return useSyncExternalStore(
    subscribeLinks,
    () => {
      const cached = membersCache
      if (cached.length === panelByPty.size && cached.every((m) => panelByPty.has(m.ptyId))) return cached
      membersCache = [...panelByPty.entries()].map(([ptyId, v]) => ({ ptyId, panelId: v.panelId, kind: v.kind }))
      return membersCache
    },
    () => [],
  )
}
