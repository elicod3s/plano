/**
 * useAgentSnippetStore — persistent, provider-neutral prompt library ("snippets") for the
 * Agent Mesh. Survives restarts (zustand persist under `plano.agent-snippets.v1`), sorts by
 * use, and imports/exports validated JSON. Shared by the Agent Control Center's Snippets tab.
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { nanoid } from 'nanoid'
import type { AgentSnippet } from '@shared/domain/agentMesh'

const MAX_BODY_BYTES = 32 * 1024
const KEY = 'plano.agent-snippets.v1'

/** The six built-in, provider-neutral prompts from the mesh design. */
export const BUILTIN_SNIPPETS: Omit<AgentSnippet, 'id' | 'createdAt'>[] = [
  {
    name: 'Status pulse',
    body:
      'Give a short status pulse without modifying any files: (1) current objective, (2) files changed, (3) checks run and their result, (4) anything blocking, (5) next step.',
  },
  {
    name: 'Avoid overlap',
    body:
      'Before working, read the PLANO shared context. Detect duplication with other listed agents, declare which files you own, and warn before editing a file another agent is using.',
  },
  {
    name: 'Verify work',
    body:
      'Run the minimal validation for this change. Report the exact command, its output, and any failure verbatim. Do not claim success without running it.',
  },
  {
    name: 'Review peer',
    body:
      'Review the existing changes (not your own). Do not overwrite anything. Prioritise bugs, then missing tests. Summarise findings per file.',
  },
  {
    name: 'Handoff',
    body:
      'Write a handoff: summary of what was done, files touched, decisions taken, commands used, verification results, and remaining work.',
  },
  {
    name: 'Plan only',
    body:
      'Analyse the request and produce a concrete plan (steps, files, risks). Do not modify any files.',
  },
]

interface AgentSnippetState {
  snippets: AgentSnippet[]
  create: (name: string, body: string) => void
  update: (id: string, patch: Partial<Pick<AgentSnippet, 'name' | 'body'>>) => void
  duplicate: (id: string) => void
  remove: (id: string) => void
  /** Record usage (sort-by-use) when a snippet is inserted/sent. */
  touch: (id: string) => void
  exportJson: () => string
  importJson: (raw: string) => { ok: boolean; error?: string }
  resetToBuiltins: () => void
}

function seed(): AgentSnippet[] {
  const now = new Date().toISOString()
  return BUILTIN_SNIPPETS.map((s) => ({ ...s, id: nanoid(10), createdAt: now }))
}

function validateBody(body: string): boolean {
  if (!body || !body.trim()) return false
  // Renderer-safe byte-ish estimate (no Buffer in the browser sandbox).
  return body.length <= MAX_BODY_BYTES
}

export const useAgentSnippetStore = create<AgentSnippetState>()(
  persist(
    (set, get) => ({
      snippets: seed(),

      create: (name, body) => {
        const n = name.trim()
        const b = body.trim()
        if (!n || !validateBody(b)) return
        set((s) => ({
          snippets: [
            { id: nanoid(10), name: n, body: b, createdAt: new Date().toISOString() },
            ...s.snippets,
          ],
        }))
      },

      update: (id, patch) =>
        set((s) => ({
          snippets: s.snippets.map((sn) =>
            sn.id === id
              ? {
                  ...sn,
                  name: patch.name !== undefined ? patch.name.trim() || sn.name : sn.name,
                  body: patch.body !== undefined ? patch.body.trim() : sn.body,
                }
              : sn,
          ),
        })),

      duplicate: (id) =>
        set((s) => {
          const src = s.snippets.find((sn) => sn.id === id)
          if (!src) return s
          return {
            snippets: [
              { ...src, id: nanoid(10), name: `${src.name} (copy)`, createdAt: new Date().toISOString() },
              ...s.snippets,
            ],
          }
        }),

      remove: (id) => set((s) => ({ snippets: s.snippets.filter((sn) => sn.id !== id) })),

      touch: (id) =>
        set((s) => ({
          snippets: s.snippets
            .map((sn) => (sn.id === id ? { ...sn, lastUsed: new Date().toISOString() } : sn))
            .sort((a, b) => {
              const ta = a.lastUsed ? Date.parse(a.lastUsed) : 0
              const tb = b.lastUsed ? Date.parse(b.lastUsed) : 0
              return tb - ta
            }),
        })),

      exportJson: () => JSON.stringify(get().snippets, null, 2),

      importJson: (raw) => {
        let parsed: unknown
        try {
          parsed = JSON.parse(raw)
        } catch {
          return { ok: false, error: 'Invalid JSON.' }
        }
        if (!Array.isArray(parsed)) return { ok: false, error: 'Expected an array of snippets.' }
        const now = new Date().toISOString()
        const imported: AgentSnippet[] = []
        for (const item of parsed) {
          if (!item || typeof item !== 'object') continue
          const o = item as { name?: unknown; body?: unknown }
          if (typeof o.name !== 'string' || !o.name.trim()) continue
          if (typeof o.body !== 'string' || !validateBody(o.body)) continue
          imported.push({
            id: nanoid(10),
            name: o.name.trim(),
            body: o.body.trim(),
            createdAt: now,
          })
        }
        if (imported.length === 0) return { ok: false, error: 'No valid snippets in file.' }
        set((s) => ({ snippets: [...imported, ...s.snippets] }))
        return { ok: true }
      },

      resetToBuiltins: () => set({ snippets: seed() }),
    }),
    {
      name: KEY,
      // Older/partial stores: fall back to the builtin seed.
      merge: (persisted, current) => {
        const p = persisted as { snippets?: unknown } | undefined
        if (!p || !Array.isArray(p.snippets)) return current
        const valid = (p.snippets as unknown[]).filter((x) => {
          const o = x as { id?: unknown; name?: unknown; body?: unknown }
          return (
            typeof o.id === 'string' &&
            typeof o.name === 'string' &&
            o.name.trim().length > 0 &&
            typeof o.body === 'string' &&
            o.body.trim().length > 0
          )
        }) as AgentSnippet[]
        return valid.length > 0 ? { ...current, snippets: valid } : current
      },
    },
  ),
)
