/**
 * Toast notifications — the in-app surface for phone-created agents and the v4 awareness
 * notifications (agent finished / awaiting input). A toast carries an optional action
 * (click → jump to the agent), a kind (informs its visual identity in Toasts.tsx), and a
 * persistence flag (a "waiting for you" toast stays until attended; "finished" auto-dismisses).
 */

import { create } from 'zustand'
import type { AgentKind } from '@shared/domain/agent'

export interface Toast {
  id: number
  title: string
  secondary?: string
  kind: 'info' | 'awaiting' | 'finished'
  /** Agent brand accent for the hairline (when the toast is agent-scoped). */
  accent?: string
  /** Harness kind for the AgentLogo identity (info toasts use a lucide icon). */
  agentKind?: AgentKind
  /** What the agent was asked — the line that makes the toast worth reading. */
  prompt?: string
  /** Where it lives: "Workspace 6 · Terminal 2". */
  context?: string
  /** How long the turn took ("3m 12s"), or a state word for a persistent toast. */
  duration?: string
  onClick?: () => void
  onDismiss?: () => void
  /** Auto-dismiss delay ms (0 = stays until dismissed). */
  ttlMs: number
  /** Grouping counter ("3 agents finished") — shown as a badge. */
  count?: number
  /**
   * Identity for merging. A second toast with a live key REPLACES the first instead of stacking:
   * a flapping detector used to paint four identical "2 agents finished" cards for one finish.
   */
  dedupeKey?: string
}

interface ToastState {
  toasts: Toast[]
  push: (t: Omit<Toast, 'id'>) => void
  dismiss: (id: number) => void
  /**
   * Retire whatever currently occupies a dedupe key. The counterpart to push()'s replace-in-place:
   * a persistent toast (ttl 0) is owned by a live condition, so whoever raised it needs a way to
   * take it back down when the condition ends — the toast has no timer to save it.
   */
  dismissKey: (dedupeKey: string) => void
}

let nextId = 1

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  push: (t) => {
    const id = nextId++
    set((s) => ({
      // Same dedupeKey → replace in place, keeping its slot in the stack, so a repeated event
      // refreshes the card instead of adding another copy of it.
      toasts: t.dedupeKey && s.toasts.some((x) => x.dedupeKey === t.dedupeKey)
        ? s.toasts.map((x) => (x.dedupeKey === t.dedupeKey ? { ...t, id } : x))
        : [...s.toasts, { ...t, id }],
    }))
    if (t.ttlMs > 0) {
      setTimeout(() => {
        set((s) => ({ toasts: s.toasts.filter((toast) => toast.id !== id) }))
      }, t.ttlMs)
    }
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((toast) => toast.id !== id) })),
  dismissKey: (dedupeKey) =>
    set((s) =>
      s.toasts.some((t) => t.dedupeKey === dedupeKey)
        ? { toasts: s.toasts.filter((t) => t.dedupeKey !== dedupeKey) }
        : s,
    ),
}))
