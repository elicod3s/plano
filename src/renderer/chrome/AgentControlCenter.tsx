import { useCallback, useEffect, useMemo, useState } from 'react'
import { useUiStore } from '@/stores/useUiStore'
import { usePanelStore } from '@/stores/usePanelStore'
import { useAgentStore } from '@/stores/useAgentStore'
import { useTerminalStore } from '@/stores/useTerminalStore'
import { useWorkspaceStore } from '@/stores/useWorkspaceStore'
import { useAgentSnippetStore } from '@/stores/useAgentSnippetStore'
import { switchSpace } from '@/app/workspaceActions'
import { focusPanel, addPanelAtCenter, openTerminalAt } from '@/app/actions'
import { buildAgentRoster, type RunningAgent } from '@/app/agentRoster'
import { AGENTS } from '@shared/domain/agent'
import type { AgentMeshSnapshot, ContextTimelineEvent } from '@shared/domain/agentMesh'
import { AgentLogo } from '@/panels/terminal/AgentLogo'
import { Icon } from '@/design-system/Icon'
import { cn } from '@/lib/cn'

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** The active workspace folder, or null when none is picked. */
const useWorkspaceFolder = (): string | null => useWorkspaceStore((s) => s.folderPath)

/** Wait until a terminal tab has a live PTY (poll the runtime store). */
async function waitForPty(termId: string, timeoutMs: number): Promise<string | null> {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const rt = useTerminalStore.getState().byPanel[termId]
    if (rt?.ptyId && rt.status === 'ready') return rt.ptyId
    await delay(150)
  }
  return null
}

type Tab = 'compose' | 'snippets' | 'context' | 'timeline'

const TAB_META: { id: Tab; label: string; icon: string }[] = [
  { id: 'compose', label: 'Compose', icon: 'PenLine' },
  { id: 'snippets', label: 'Snippets', icon: 'Bookmark' },
  { id: 'context', label: 'Context', icon: 'ScanSearch' },
  { id: 'timeline', label: 'Timeline', icon: 'History' },
]

function tint(color: string, pct: number): string {
  return `color-mix(in srgb, ${color} ${pct}%, transparent)`
}

/**
 * Agent Control Center — the cross-workspace Agent Mesh UI. Left column: the live roster of every
 * detected agent (from ANY workspace, PTYs keep running in the background) with multi-select,
 * focus and stop. Right column: Compose (send one message to N agents), Snippets (persistent
 * prompt library), Context (search + scratchpad + usage) and Timeline (recent agent events).
 * Styled to match the command palette (scrim + blur + rounded overlay), theme-safe, reduced-motion
 * aware. Provider-neutral: it controls whatever agent is running, never a specific vendor.
 */
export function AgentControlCenter() {
  const open = useUiStore((s) => s.agentControlOpen)
  const setOpen = useUiStore((s) => s.setAgentControl)

  const [tab, setTab] = useState<Tab>('compose')
  const [snapshot, setSnapshot] = useState<AgentMeshSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [composer, setComposer] = useState('')
  const [includeContext, setIncludeContext] = useState(true)
  const [onlyIdle, setOnlyIdle] = useState(false)
  const [dispatchResult, setDispatchResult] = useState<string | null>(null)
  const [timeline, setTimeline] = useState<ContextTimelineEvent[]>([])
  const [scratchpad, setScratchpad] = useState<{ text: string; bytes: number } | null>(null)
  const [scratchEntry, setScratchEntry] = useState('')
  const [fanoutMsg, setFanoutMsg] = useState<string | null>(null)
  const [fanoutBusy, setFanoutBusy] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const snap = await window.plano.agentMesh.getSnapshot()
      setSnapshot(snap)
    } catch {
      /* main unavailable */
    }
  }, [])

  // Live refresh: on open, on any mesh 'changed' event, and on the local roster stores changing.
  useEffect(() => {
    if (!open) return
    setLoading(true)
    void refresh().finally(() => setLoading(false))
    const unsubChanged = window.plano.agentMesh.onChanged(() => void refresh())
    const unsubAgents = useAgentStore.subscribe(() => void refresh())
    const unsubTerminals = useTerminalStore.subscribe(() => void refresh())
    return () => {
      unsubChanged()
      unsubAgents()
      unsubTerminals()
    }
  }, [open, refresh])

  // Esc closes; Ctrl+Enter sends from the composer.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setOpen(false)
        return
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault()
        void send()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // Timeline + scratchpad lazy-load when their tabs are opened.
  useEffect(() => {
    if (!open || tab !== 'timeline') return
    void window.plano.agentMesh.getTimeline(300).then((r) => setTimeline(r.events)).catch(() => undefined)
  }, [open, tab])
  useEffect(() => {
    if (!open || tab !== 'context') return
    void window.plano.agentMesh.readScratchpad().then(setScratchpad).catch(() => undefined)
  }, [open, tab])

  // The roster is the live join; the snapshot adds main-owned metadata (workspace names, usage).
  const roster = useMemo<RunningAgent[]>(() => (open ? buildAgentRoster() : []), [open])
  const byPty = useMemo(() => new Map(roster.map((r) => [r.ptyId, r])), [roster])
  const workingCount = roster.filter((r) => r.verdict.phase === 'working').length
  const idleCount = roster.length - workingCount

  // Prune dead selections when the roster changes (agent exited mid-selection).
  useEffect(() => {
    if (!open) return
    setSelected((prev) => {
      const next = new Set<string>()
      for (const id of prev) if (byPty.has(id)) next.add(id)
      return next.size === prev.size ? prev : next
    })
  }, [open, byPty])

  if (!open) return null

  const toggleAll = (): void => {
    setSelected((prev) => {
      const next = new Set<string>()
      const all = roster.every((r) => prev.has(r.ptyId))
      if (!all) for (const r of roster) next.add(r.ptyId)
      return next
    })
  }

  const goTo = (ptyId: string): void => {
    const agent = byPty.get(ptyId)
    if (!agent) return
    if (!agent.inActiveSpace && agent.spaceId) switchSpace(agent.spaceId)
    usePanelStore.getState().setActiveTerminalTab(agent.panelId, agent.termId)
    focusPanel(agent.panelId)
    setOpen(false)
  }

  const stop = (ptyId: string): void => {
    void window.plano.agentMesh.interrupt(ptyId).catch(() => undefined)
  }

  const send = async (): Promise<void> => {
    const message = composer.trim()
    const targets = [...selected]
    if (!message || targets.length === 0) {
      setDispatchResult('Select at least one agent and type a message.')
      return
    }
    setDispatchResult(null)
    try {
      const res = await window.plano.agentMesh.dispatch({
        targetPtyIds: targets,
        message,
        includeContext,
        onlyWhenIdle: onlyIdle,
      })
      const delivered = res.results.filter((r) => r.ok).length
      const failed = res.results.filter((r) => !r.ok)
      if (failed.length === 0) {
        setDispatchResult(`Sent to ${delivered} agent${delivered !== 1 ? 's' : ''}.`)
        setComposer('')
        setSelected(new Set())
        void refresh()
      } else {
        const reasons = [...new Set(failed.map((f) => f.error))].join(', ')
        setDispatchResult(
          `Delivered to ${delivered}/${res.results.length} — skipped: ${reasons}.`,
        )
      }
    } catch {
      setDispatchResult('Dispatch failed (main unavailable).')
    }
  }

  // ── fan-out: create a git worktree per selected agent, open a terminal in each, send the
  //    same prompt to every one. Only available when the active workspace is a git repo.
  const runFanout = async (): Promise<void> => {
    const message = composer.trim()
    if (!message || selected.size === 0) {
      setFanoutMsg('Select at least one agent and type a message.')
      return
    }
    const folder = useWorkspaceFolder()
    if (!folder) {
      setFanoutMsg('The active workspace has no folder.')
      return
    }
    const repo = await window.plano.worktree.isRepo(folder).catch(() => ({ ok: false }))
    if (!repo.ok) {
      setFanoutMsg('Fan-out needs a git repository — open a git project first.')
      return
    }
    setFanoutBusy(true)
    setFanoutMsg(null)
    try {
      const created = await window.plano.worktree.create(folder, message.slice(0, 40), selected.size)
      if (!created.ok || !created.worktrees) {
        setFanoutMsg(created.error ?? 'Could not create worktrees.')
        return
      }
      let opened = 0
      for (const wt of created.worktrees) {
        // Open a terminal rooted at the worktree, then send the prompt once its agent appears.
        const termId = openTerminalAt(wt.path)
        if (!termId) continue
        const ptyId = await waitForPty(termId, 6000)
        if (!ptyId) continue
        await delay(400)
        window.plano.terminal.write(ptyId, message + '\r')
        opened++
      }
      setFanoutMsg(
        `Created ${created.worktrees.length} worktree(s), opened ${opened} terminal(s) and sent the prompt.`,
      )
      setComposer('')
      setSelected(new Set())
      void refresh()
    } catch (error) {
      setFanoutMsg(error instanceof Error ? error.message : String(error))
    } finally {
      setFanoutBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center"
      style={{ background: 'var(--scrim)' }}
      onPointerDown={() => setOpen(false)}
    >
      <div
        data-surface-layer="modal"
        className="animate-palette-in surface-layer surface-layer--modal flex h-[min(78vh,860px)] w-[min(1024px,90vw)] flex-col overflow-hidden rounded-[24px]"
        onPointerDown={(e) => e.stopPropagation()}
      >
        {/* header */}
        <div className="flex h-[54px] shrink-0 items-center gap-3 border-b border-subtle px-4">
          <span
            className="flex h-7 w-7 items-center justify-center rounded-lg border border-strong"
            style={{ background: 'var(--surface-2)' }}
          >
            <Icon name="Waypoints" size={16} className="text-text-primary" />
          </span>
          <span className="text-[15px] font-semibold text-text-primary">Agent Mesh</span>
          <span className="rounded-pill bg-surface-3 px-2 py-0.5 font-mono text-[10px] text-text-tertiary">
            {roster.length} {roster.length === 1 ? 'agent' : 'agents'}
          </span>
          {loading && (
            <span className="h-3 w-3 animate-spin rounded-full border border-text-quaternary border-t-transparent" />
          )}
          <div className="ml-auto flex items-center gap-4 font-mono text-[10px] text-text-tertiary">
            <span className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-pill animate-status-pulse" style={{ background: 'var(--status-active)' }} />
              {workingCount} working
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-pill" style={{ background: 'var(--text-quaternary)' }} />
              {idleCount} idle
            </span>
            <span className="text-text-quaternary">esc</span>
          </div>
        </div>

        <div className="flex min-h-0 flex-1">
          {/* ── left: roster ── */}
          <div className="flex w-[340px] shrink-0 flex-col border-r border-subtle">
            <div className="flex items-center justify-between px-3 pb-1 pt-2.5">
              <span className="label-caps text-text-tertiary">All agents</span>
              <button
                type="button"
                onClick={toggleAll}
                className="flex items-center gap-1 rounded-pill px-2 py-0.5 text-[11px] font-medium text-text-secondary transition-colors hover:bg-accent-soft hover:text-text-primary"
              >
                <Icon name={selected.size === roster.length && roster.length > 0 ? 'CheckSquare' : 'Square'} size={12} />
                Select all
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
              {roster.length === 0 ? (
                <div className="flex flex-col items-center gap-3 px-4 py-14 text-center">
                  <Icon name="Bot" size={28} className="text-text-quaternary" />
                  <p className="text-[13px] text-text-tertiary">
                    No agents running. Open a terminal and launch an AI coding CLI.
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(false)
                      addPanelAtCenter('terminal')
                    }}
                    className="rounded-pill border border-default px-3 py-1.5 text-[12px] font-medium text-text-primary transition-colors hover:border-strong hover:bg-accent-soft"
                  >
                    Open a terminal
                  </button>
                </div>
              ) : (
                roster.map((a) => {
                  const kind = a.verdict.kind ?? 'generic-agent'
                  const info = AGENTS[kind]
                  const name = a.verdict.displayName ?? info.displayName
                  const checked = selected.has(a.ptyId)
                  const working = a.verdict.phase === 'working'
                  return (
                    <div
                      key={a.ptyId}
                      className={cn(
                        'mb-1 rounded-xl border p-2 transition-colors',
                        checked ? 'border-strong bg-accent-soft' : 'border-transparent hover:bg-surface-2',
                      )}
                    >
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          aria-label={checked ? 'Deselect' : 'Select'}
                          onClick={() =>
                            setSelected((prev) => {
                              const next = new Set(prev)
                              if (next.has(a.ptyId)) next.delete(a.ptyId)
                              else next.add(a.ptyId)
                              return next
                            })
                          }
                          className="flex h-4 w-4 shrink-0 items-center justify-center rounded border border-default bg-surface-1 transition-colors hover:border-strong"
                        >
                          {checked && <Icon name="Check" size={11} className="text-text-primary" />}
                        </button>
                        <span
                          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border"
                          style={{ background: tint(info.accent, 14), borderColor: tint(info.accent, 38), color: info.accent }}
                        >
                          <AgentLogo kind={a.verdict.kind} size={14} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1.5">
                            <span className="truncate text-[12.5px] font-medium text-text-primary">{name}</span>
                            <span
                              className={cn('h-1.5 w-1.5 shrink-0 rounded-pill', working && 'animate-status-pulse')}
                              style={{ background: working ? 'var(--status-active)' : 'var(--text-quaternary)' }}
                            />
                          </span>
                          <span className="mt-0.5 block truncate font-mono text-[10px] text-text-tertiary">
                            {typeof a.terminalNumber === 'number' ? `Terminal ${a.terminalNumber}` : a.title}
                            {!a.inActiveSpace && a.spaceName ? ` · ${a.spaceName}` : ''}
                          </span>
                        </span>
                        <button
                          type="button"
                          onClick={() => goTo(a.ptyId)}
                          title="Focus this agent"
                          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg text-text-quaternary transition-colors hover:bg-accent-soft hover:text-text-primary"
                        >
                          <Icon name="LocateFixed" size={13} />
                        </button>
                        <button
                          type="button"
                          onClick={() => stop(a.ptyId)}
                          title="Interrupt (Ctrl-C)"
                          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg text-text-quaternary transition-colors hover:bg-destructive-soft hover:text-destructive"
                        >
                          <Icon name="Square" size={12} />
                        </button>
                      </div>
                      {(a.prompt || a.lastPrompt) && (
                        <p className="mt-1.5 truncate pl-6 text-[11px] text-text-secondary">
                          {a.lastPrompt || a.prompt}
                        </p>
                      )}
                    </div>
                  )
                })
              )}
            </div>

            <div className="shrink-0 border-t border-subtle bg-surface-2 px-3 py-2 font-mono text-[10px] text-text-quaternary">
              <span className="flex items-center gap-1.5">
                <Icon name="Database" size={11} />
                {snapshot ? `${(snapshot.usageBytes / 1024).toFixed(1)} KiB context in main` : '…'}
              </span>
            </div>
          </div>

          {/* ── right: tabs ── */}
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex shrink-0 items-center gap-1 border-b border-subtle px-2 pt-1.5">
              {TAB_META.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setTab(t.id)}
                  className={cn(
                    'flex items-center gap-1.5 rounded-t-lg px-3 py-2 text-[12px] font-medium transition-colors',
                    tab === t.id
                      ? 'border-b-2 border-text-primary text-text-primary'
                      : 'text-text-tertiary hover:text-text-secondary',
                  )}
                >
                  <Icon name={t.icon} size={13} />
                  {t.label}
                </button>
              ))}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              {tab === 'compose' && (
                <ComposeTab
                  composer={composer}
                  setComposer={setComposer}
                  includeContext={includeContext}
                  setIncludeContext={setIncludeContext}
                  onlyIdle={onlyIdle}
                  setOnlyIdle={setOnlyIdle}
                  selectedCount={selected.size}
                  onSend={() => void send()}
                  result={dispatchResult}
                  onFanout={() => void runFanout()}
                  fanoutMsg={fanoutMsg}
                  fanoutBusy={fanoutBusy}
                />
              )}
              {tab === 'snippets' && (
                <SnippetsTab
                  onInsert={(body) => {
                    setComposer((prev) => (prev ? `${prev}\n${body}` : body))
                    setTab('compose')
                  }}
                />
              )}
              {tab === 'context' && (
                <ContextTab scratchpad={scratchpad} scratchEntry={scratchEntry} setScratchEntry={setScratchEntry} onAppend={() => {
                  if (!scratchEntry.trim()) return
                  void window.plano.agentMesh.writeScratchpad(scratchEntry).then(() => {
                    setScratchEntry('')
                    return window.plano.agentMesh.readScratchpad()
                  }).then(setScratchpad).catch(() => undefined)
                }} />
              )}
              {tab === 'timeline' && (
                <TimelineTab events={timeline} onFocus={goTo} />
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// A tiny hook indirection so the roster refreshes when the agent stores change.
// (Removed — subscriptions now live inline in the main effect to respect the Rules of Hooks.)

function ComposeTab(props: {
  composer: string
  setComposer: (v: string) => void
  includeContext: boolean
  setIncludeContext: (v: boolean) => void
  onlyIdle: boolean
  setOnlyIdle: (v: boolean) => void
  selectedCount: number
  onSend: () => void
  result: string | null
  onFanout: () => void
  fanoutMsg: string | null
  fanoutBusy: boolean
}) {
  const { composer, setComposer, includeContext, setIncludeContext, onlyIdle, setOnlyIdle, selectedCount, onSend, result, onFanout, fanoutMsg, fanoutBusy } = props
  return (
    <div className="flex h-full flex-col gap-3">
      <textarea
        value={composer}
        onChange={(e) => setComposer(e.target.value)}
        placeholder="Send a message to the selected agents…"
        className="min-h-[140px] flex-1 resize-none rounded-xl border border-default bg-surface-1 p-3 font-mono text-[12.5px] leading-relaxed text-text-primary outline-none placeholder:text-text-quaternary focus:border-strong"
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault()
            onSend()
          }
        }}
      />
      <div className="flex items-center gap-4">
        <label className="flex cursor-pointer items-center gap-2 text-[12px] text-text-secondary">
          <input type="checkbox" checked={includeContext} onChange={(e) => setIncludeContext(e.target.checked)} className="accent-[var(--accent-primary)]" />
          Include canvas context
        </label>
        <label className="flex cursor-pointer items-center gap-2 text-[12px] text-text-secondary">
          <input type="checkbox" checked={onlyIdle} onChange={(e) => setOnlyIdle(e.target.checked)} className="accent-[var(--accent-primary)]" />
          Only idle agents
        </label>
        <span className="ml-auto font-mono text-[10px] text-text-quaternary">{composer.length} chars</span>
      </div>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onSend}
          disabled={selectedCount === 0 || !composer.trim()}
          className="rounded-pill border border-default bg-surface-3 px-4 py-2 text-[12.5px] font-medium text-text-primary transition-colors hover:border-strong hover:bg-accent-soft disabled:cursor-not-allowed disabled:opacity-40"
        >
          Send to {selectedCount} agent{selectedCount !== 1 ? 's' : ''}
        </button>
        <button
          type="button"
          onClick={onFanout}
          disabled={selectedCount === 0 || !composer.trim() || fanoutBusy}
          title="Fan out: create a git worktree per selected agent, open a terminal in each and send this prompt"
          className="flex items-center gap-1.5 rounded-pill border border-default bg-surface-3 px-4 py-2 text-[12.5px] font-medium text-text-primary transition-colors hover:border-strong hover:bg-accent-soft disabled:cursor-not-allowed disabled:opacity-40"
        >
          {fanoutBusy ? (
            <span className="h-3 w-3 animate-spin rounded-full border border-text-quaternary border-t-transparent" />
          ) : (
            <Icon name="GitBranch" size={13} />
          )}
          Fan out
        </button>
        <span className="font-mono text-[10px] text-text-quaternary">Ctrl+Enter</span>
        {result && <span className="truncate text-[12px] text-text-secondary">{result}</span>}
        {fanoutMsg && <span className="truncate text-[12px] text-text-secondary">{fanoutMsg}</span>}
      </div>
    </div>
  )
}

function SnippetsTab({ onInsert }: { onInsert: (body: string) => void }) {
  const snippets = useAgentSnippetStore((s) => s.snippets)
  const create = useAgentSnippetStore((s) => s.create)
  const update = useAgentSnippetStore((s) => s.update)
  const duplicate = useAgentSnippetStore((s) => s.duplicate)
  const remove = useAgentSnippetStore((s) => s.remove)
  const touch = useAgentSnippetStore((s) => s.touch)
  const exportJson = useAgentSnippetStore((s) => s.exportJson)
  const importJson = useAgentSnippetStore((s) => s.importJson)
  const [editing, setEditing] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [body, setBody] = useState('')
  const [importError, setImportError] = useState<string | null>(null)

  const startEdit = (id: string | null, existing?: { name: string; body: string }): void => {
    setEditing(id)
    setName(existing?.name ?? '')
    setBody(existing?.body ?? '')
  }
  const saveEdit = (): void => {
    if (editing === null) create(name, body)
    else update(editing, { name, body })
    setEditing(null)
    setName('')
    setBody('')
  }
  const doExport = (): void => {
    const blob = new Blob([exportJson()], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'plano-agent-snippets.json'
    a.click()
    URL.revokeObjectURL(url)
  }
  const onImportFile = (file: File): void => {
    void file
      .text()
      .then((raw) => {
        const res = importJson(raw)
        setImportError(res.ok ? null : (res.error ?? 'Import failed.'))
      })
      .catch(() => setImportError('Could not read file.'))
  }

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <span className="label-caps text-text-tertiary">Prompt library</span>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => startEdit(null)}
            className="flex items-center gap-1 rounded-pill border border-default bg-surface-3 px-2.5 py-1 text-[11px] font-medium text-text-primary transition-colors hover:border-strong"
          >
            <Icon name="Plus" size={12} />
            New
          </button>
          <button
            type="button"
            onClick={doExport}
            className="flex items-center gap-1 rounded-pill border border-default bg-surface-3 px-2.5 py-1 text-[11px] font-medium text-text-primary transition-colors hover:border-strong"
          >
            <Icon name="Download" size={12} />
            Export
          </button>
          <label className="flex cursor-pointer items-center gap-1 rounded-pill border border-default bg-surface-3 px-2.5 py-1 text-[11px] font-medium text-text-primary transition-colors hover:border-strong">
            <Icon name="Upload" size={12} />
            Import
            <input type="file" accept=".json,application/json" className="hidden" onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) onImportFile(f)
              e.target.value = ''
            }} />
          </label>
          <span className="font-mono text-[10px] text-text-quaternary">{snippets.length}</span>
        </div>
      </div>
      {importError && <p className="mb-2 text-[11.5px] text-destructive">{importError}</p>}

      {editing !== null && (
        <div className="mb-2 rounded-xl border border-strong bg-surface-2 p-3">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Snippet name"
            className="mb-2 w-full rounded-lg border border-default bg-surface-1 px-2.5 py-1.5 text-[12.5px] font-medium text-text-primary outline-none placeholder:text-text-quaternary focus:border-strong"
          />
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Prompt body — sent verbatim to the selected agents…"
            rows={5}
            className="mb-2 w-full resize-none rounded-lg border border-default bg-surface-1 px-2.5 py-1.5 font-mono text-[11.5px] leading-relaxed text-text-primary outline-none placeholder:text-text-quaternary focus:border-strong"
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={saveEdit}
              disabled={!name.trim() || !body.trim()}
              className="rounded-pill border border-default bg-surface-3 px-3 py-1 text-[11.5px] font-medium text-text-primary transition-colors hover:border-strong disabled:cursor-not-allowed disabled:opacity-40"
            >
              {editing === null ? 'Create' : 'Save'}
            </button>
            <button
              type="button"
              onClick={() => setEditing(null)}
              className="rounded-pill px-3 py-1 text-[11.5px] text-text-tertiary transition-colors hover:text-text-primary"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {snippets.length === 0 ? (
        <p className="px-2 py-8 text-center text-[12.5px] text-text-tertiary">
          No snippets yet — create one to reuse prompts across agents.
        </p>
      ) : (
        <div className="space-y-1.5">
          {snippets.map((s) => (
            <div key={s.id} className="flex items-center gap-2 rounded-xl border border-subtle bg-surface-2 p-2.5">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[12.5px] font-medium text-text-primary">{s.name}</span>
                  {s.lastUsed && (
                    <span className="font-mono text-[9px] text-text-quaternary">
                      {new Date(s.lastUsed).toLocaleDateString()}
                    </span>
                  )}
                </div>
                <p className="mt-0.5 line-clamp-2 whitespace-pre-wrap font-mono text-[10.5px] text-text-tertiary">{s.body}</p>
              </div>
              <button
                type="button"
                onClick={() => {
                  touch(s.id)
                  onInsert(s.body)
                }}
                title="Insert into composer"
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-text-quaternary transition-colors hover:bg-accent-soft hover:text-text-primary"
              >
                <Icon name="ArrowDownToLine" size={13} />
              </button>
              <button
                type="button"
                onClick={() => startEdit(s.id, s)}
                title="Edit"
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-text-quaternary transition-colors hover:bg-accent-soft hover:text-text-primary"
              >
                <Icon name="Pencil" size={13} />
              </button>
              <button
                type="button"
                onClick={() => duplicate(s.id)}
                title="Duplicate"
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-text-quaternary transition-colors hover:bg-accent-soft hover:text-text-primary"
              >
                <Icon name="Copy" size={13} />
              </button>
              <button
                type="button"
                onClick={() => remove(s.id)}
                title="Delete"
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-text-quaternary transition-colors hover:bg-destructive-soft hover:text-destructive"
              >
                <Icon name="Trash2" size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function ContextTab(props: {
  scratchpad: { text: string; bytes: number } | null
  scratchEntry: string
  setScratchEntry: (v: string) => void
  onAppend: () => void
}) {
  const { scratchpad, scratchEntry, setScratchEntry, onAppend } = props
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<{ ptyId: string; title: string; kind: string | null; snippet: string; matches: number; cwd: string }[] | null>(null)

  const search = (): void => {
    if (!query.trim()) {
      setResults(null)
      return
    }
    void window.plano.agentMesh.search(query.trim(), { limit: 30 }).then(setResults).catch(() => setResults([]))
  }

  return (
    <div className="space-y-4">
      <div>
        <span className="label-caps mb-1.5 block text-text-tertiary">Search context</span>
        <div className="flex gap-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && search()}
            placeholder="Search terminal context (agents, prompts, output)…"
            className="min-w-0 flex-1 rounded-pill border border-default bg-surface-1 px-3 py-1.5 text-[12.5px] text-text-primary outline-none placeholder:text-text-quaternary focus:border-strong"
          />
          <button
            type="button"
            onClick={search}
            className="rounded-pill border border-default bg-surface-3 px-3 py-1.5 text-[12px] font-medium text-text-primary transition-colors hover:border-strong"
          >
            <Icon name="Search" size={13} />
          </button>
        </div>
        {results && (
          <div className="mt-2 space-y-1.5">
            {results.length === 0 ? (
              <p className="px-1 py-3 text-[12px] text-text-tertiary">No matches.</p>
            ) : (
              results.map((r) => (
                <div key={r.ptyId} className="rounded-xl border border-subtle bg-surface-2 p-2.5">
                  <div className="flex items-center gap-2 text-[11px] text-text-tertiary">
                    <span className="font-medium text-text-secondary">{r.kind ?? 'agent'}</span>
                    <span className="font-mono">{r.title}</span>
                    <span className="ml-auto font-mono text-[10px]">{r.matches} match{r.matches !== 1 ? 'es' : ''}</span>
                  </div>
                  <p className="mt-1 line-clamp-2 whitespace-pre-wrap font-mono text-[10.5px] text-text-secondary">{r.snippet}</p>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      <div>
        <span className="label-caps mb-1.5 block text-text-tertiary">Scratchpad</span>
        <div className="rounded-xl border border-default bg-surface-1 p-2.5">
          <pre className="max-h-[180px] overflow-y-auto whitespace-pre-wrap font-mono text-[10.5px] leading-relaxed text-text-secondary">
            {scratchpad?.text || 'Empty — shared notes your agents can read via the mesh.'}
          </pre>
          <div className="mt-2 flex items-center gap-2 border-t border-subtle pt-2">
            <input
              value={scratchEntry}
              onChange={(e) => setScratchEntry(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && onAppend()}
              placeholder="Append a note (timestamped)…"
              className="min-w-0 flex-1 rounded-pill border border-default bg-surface-1 px-3 py-1 text-[12px] text-text-primary outline-none placeholder:text-text-quaternary focus:border-strong"
            />
            <button
              type="button"
              onClick={onAppend}
              className="rounded-pill border border-default bg-surface-3 px-3 py-1 text-[12px] font-medium text-text-primary transition-colors hover:border-strong"
            >
              Append
            </button>
          </div>
          <div className="mt-1.5 font-mono text-[9.5px] text-text-quaternary">
            {scratchpad ? `${(scratchpad.bytes / 1024).toFixed(1)} KiB` : ''} · saved to the workspace .plano folder
          </div>
        </div>
      </div>
    </div>
  )
}

function TimelineTab({ events, onFocus }: { events: ContextTimelineEvent[]; onFocus: (ptyId: string) => void }) {
  const kindIcon: Record<string, string> = {
    'agent-started': 'Sparkles',
    'phase-changed': 'Activity',
    'prompt-sent': 'MessageSquareText',
    'url-detected': 'Link',
    'process-exited': 'Square',
    dispatch: 'Send',
  }
  return (
    <div>
      {events.length === 0 ? (
        <p className="px-2 py-10 text-center text-[12.5px] text-text-tertiary">No agent events yet.</p>
      ) : (
        <div className="relative space-y-1 pl-5">
          <div className="absolute bottom-1 left-[7px] top-1 w-px bg-border-subtle" />
          {events.map((e) => (
            <button
              key={e.id}
              type="button"
              onClick={() => onFocus(e.ptyId)}
              className="group relative flex w-full items-start gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-surface-2"
            >
              <span className="absolute -left-[18px] top-[10px] h-2 w-2 rounded-pill border border-strong bg-surface-3" />
              <Icon name={kindIcon[e.kind] ?? 'Circle'} size={13} className="mt-0.5 shrink-0 text-text-quaternary" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px] text-text-secondary">{e.summary}</span>
                <span className="font-mono text-[9.5px] text-text-quaternary">
                  {new Date(e.at).toLocaleTimeString()}
                  {e.agent ? ` · ${e.agent}` : ''}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
