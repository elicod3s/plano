/**
 * TerminalCloseDialog — the confirmation shown before closing a terminal that has a detected
 * AI agent running. Monolith voice: monochrome, NO icon, actions stacked vertically, red kept
 * to an absolute minimum (only the destructive action's label is tinted).
 *
 * "Show running processes" reveals a small, Warp-style summary of THIS terminal: its working
 * folder, the git branch + how many lines changed (+added / −removed), and the agent that's
 * running — matched with the same signatures as agent-mode detection, so it only ever shows
 * the agent CLI, never the surrounding OS process noise. The git folder falls back to the open
 * project when the terminal itself wasn't started inside a repo, so the change counts still show.
 *
 * Mounted once; driven imperatively via promptTerminalClose() / useTerminalClosePrompt.
 */
import { useEffect, useRef, useState } from 'react'
import type { GitStatusResult, TerminalProcessInfo } from '@shared/ipc/contracts'
import { useTerminalClosePrompt } from '@/stores/useTerminalClosePrompt'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useWorkspaceStore } from '@/stores/useWorkspaceStore'
import { Icon } from '@/design-system/Icon'
import { cn } from '@/lib/cn'

export function TerminalCloseDialog() {
  const open = useTerminalClosePrompt((s) => s.open)
  const options = useTerminalClosePrompt((s) => s.options)
  const respond = useTerminalClosePrompt((s) => s.respond)
  const patchSettings = useSettingsStore((s) => s.patch)
  const workspaceFolder = useWorkspaceStore((s) => s.folderPath)
  const confirmRef = useRef<HTMLButtonElement>(null)

  const [expanded, setExpanded] = useState(false)
  const [dontShow, setDontShow] = useState(false)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const [procs, setProcs] = useState<TerminalProcessInfo[] | null>(null)
  const [git, setGit] = useState<GitStatusResult | null>(null)
  const [repoDir, setRepoDir] = useState<string | null>(null)

  const confirmClose = (): void => {
    if (dontShow) patchSettings('general', { confirmClosePanelWithProcess: false })
    respond(true)
  }

  // Fresh state every time the dialog opens.
  useEffect(() => {
    if (!open) return
    setExpanded(false)
    setDontShow(false)
    setLoading(false)
    setFailed(false)
    setProcs(null)
    setGit(null)
    setRepoDir(null)
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        respond(false)
      } else if (e.key === 'Enter') {
        e.preventDefault()
        confirmClose()
      }
    }
    window.addEventListener('keydown', onKey)
    requestAnimationFrame(() => confirmRef.current?.focus())
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, dontShow])

  if (!open || !options) return null
  const { agentName, agentIcon, ptyId, cwd } = options

  // Prefer the terminal's own cwd; fall back to the open project so the change counts still
  // show when the terminal was started outside a repo (e.g. Home).
  const resolveGit = async (): Promise<{ git: GitStatusResult | null; dir: string | null }> => {
    const dirs = [cwd, workspaceFolder].filter((d): d is string => !!d && !!d.trim())
    let fallback: { git: GitStatusResult | null; dir: string | null } = { git: null, dir: dirs[0] ?? null }
    const seen = new Set<string>()
    for (const d of dirs) {
      if (seen.has(d) || !window.plano.git?.status) continue
      seen.add(d)
      try {
        const g = await window.plano.git.status({ cwd: d })
        if (g.isRepo) return { git: g, dir: d }
        if (!fallback.git) fallback = { git: g, dir: d }
      } catch {
        /* try the next candidate */
      }
    }
    return fallback
  }

  // Each source is fetched independently so one failure never blocks the other or leaves the
  // view stuck "loading".
  const loadSession = async (): Promise<void> => {
    setLoading(true)
    setFailed(false)
    try {
      const procP =
        ptyId && window.plano.terminal.listProcesses
          ? window.plano.terminal
              .listProcesses(ptyId)
              .then((r) => r.processes)
              .catch(() => [] as TerminalProcessInfo[])
          : Promise.resolve([] as TerminalProcessInfo[])
      const [p, g] = await Promise.all([procP, resolveGit()])
      setProcs(p)
      setGit(g.git)
      setRepoDir(g.dir)
    } catch {
      setFailed(true)
    } finally {
      setLoading(false)
    }
  }

  const toggleExpand = (): void => {
    const next = !expanded
    setExpanded(next)
    if (next && procs === null && !loading) void loadSession()
  }

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center p-6"
      style={{ background: 'var(--scrim)', backdropFilter: 'blur(12px)' }}
      onPointerDown={() => respond(false)}
    >
      <div
        className="animate-palette-in flex max-h-[85vh] w-[420px] max-w-[92vw] flex-col overflow-hidden rounded-xl border border-strong shadow-overlay"
        style={{ background: 'var(--bg-base)' }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        {/* content */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pt-5">
          <h2 className="text-[15px] font-semibold text-text-primary">Close agent terminal</h2>
          <p className="mt-1.5 text-[13px] leading-relaxed text-text-secondary">
            {agentName} is running in this terminal. Closing it will end the session.
          </p>

          {/* don't show again */}
          <button
            type="button"
            onClick={() => setDontShow((v) => !v)}
            className="app-no-drag mt-4 flex items-center gap-2.5 text-[13px] text-text-secondary transition-colors hover:text-text-primary"
          >
            <span
              className={cn(
                'flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] border transition-colors',
                dontShow ? 'border-strong bg-accent text-text-onsolid' : 'border-default text-transparent',
              )}
            >
              <Icon name="Check" size={12} strokeWidth={3} />
            </span>
            Don&apos;t show again
          </button>

          {expanded && (
            <div className="mt-3">
              {loading && (
                <div className="flex items-center gap-2 px-1 py-3 text-[12px] text-text-tertiary">
                  <Icon name="LoaderCircle" size={14} className="animate-spin" />
                  Reading session…
                </div>
              )}
              {failed && !loading && (
                <div className="px-1 py-3 text-[12px] text-text-tertiary">
                  Couldn&apos;t read this session.
                </div>
              )}
              {!loading && !failed && (
                <SessionCard
                  agentName={agentName}
                  agentIcon={agentIcon}
                  repoDir={repoDir}
                  git={git}
                  procs={procs ?? []}
                />
              )}
            </div>
          )}
        </div>

        {/* actions — stacked vertically; red kept to the destructive label only */}
        <div className="flex shrink-0 flex-col gap-2 px-5 pb-5 pt-4">
          <button
            ref={confirmRef}
            type="button"
            onClick={confirmClose}
            className="app-no-drag inline-flex h-9 w-full items-center justify-center rounded-md border border-strong bg-surface-3 text-[13px] font-semibold text-destructive-hover transition-colors hover:bg-surface-4 focus-caliper"
          >
            Close terminal
          </button>
          <button
            type="button"
            onClick={toggleExpand}
            className={cn(
              'app-no-drag inline-flex h-9 w-full items-center justify-center rounded-md border text-[13px] font-medium text-text-primary transition-colors',
              expanded
                ? 'border-strong bg-surface-2'
                : 'border-default bg-surface-1 hover:border-strong hover:bg-surface-2',
            )}
          >
            {expanded ? 'Hide running processes' : 'Show running processes'}
          </button>
          <button
            type="button"
            onClick={() => respond(false)}
            className="app-no-drag inline-flex h-9 w-full items-center justify-center rounded-md text-[13px] font-medium text-text-secondary transition-colors hover:bg-accent-soft hover:text-text-primary focus-caliper"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

/** A small Warp-style session card: folder + git change counts + the running agent. */
function SessionCard({
  agentName,
  agentIcon,
  repoDir,
  git,
  procs,
}: {
  agentName: string
  agentIcon?: string
  repoDir: string | null
  git: GitStatusResult | null
  procs: TerminalProcessInfo[]
}) {
  const folder = repoDir ? repoDir.split(/[\\/]/).filter(Boolean).pop() || repoDir : 'Terminal'
  const command = procs[0]?.cmd || procs[0]?.name || ''

  return (
    <div className="overflow-hidden rounded-lg border border-subtle bg-surface-1">
      {/* folder + status */}
      <div className="p-3">
        <div className="flex items-center gap-2">
          <Icon name="FolderGit2" size={15} className="shrink-0 text-text-secondary" />
          <span className="truncate text-[13px] font-semibold text-text-primary" title={repoDir || undefined}>
            {folder}
          </span>
          <span className="ml-auto inline-flex shrink-0 items-center gap-1.5 text-[12px] text-text-primary">
            <span
              className="animate-status-pulse h-1.5 w-1.5 rounded-pill"
              style={{ background: 'var(--status-active)' }}
            />
            Running
          </span>
        </div>

        {git?.isRepo && (
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12px]">
            {git.branch && (
              <span className="inline-flex items-center gap-1 text-text-secondary">
                <Icon name="GitBranch" size={13} className="text-text-tertiary" />
                <span className="font-mono">{git.branch}</span>
              </span>
            )}
            {git.filesChanged > 0 ? (
              <span className="inline-flex items-center gap-2 font-mono">
                <span className="inline-flex items-center gap-1 text-text-tertiary">
                  <Icon name="FileDiff" size={13} />
                  {git.filesChanged}
                </span>
                <span style={{ color: 'var(--diff-added)' }}>+{git.added}</span>
                <span style={{ color: 'var(--diff-removed)' }}>−{git.removed}</span>
              </span>
            ) : (
              <span className="text-text-tertiary">No uncommitted changes</span>
            )}
          </div>
        )}
      </div>

      {/* the running agent (matched, never raw OS noise) */}
      <div className="flex items-center gap-2.5 border-t border-subtle p-3">
        <Icon name={agentIcon || 'Bot'} size={16} className="shrink-0 text-text-primary" />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-text-primary">{agentName}</div>
          {command && (
            <div className="truncate font-mono text-[11px] text-text-tertiary" title={command}>
              {command}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
