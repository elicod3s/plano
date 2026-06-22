import { useEffect } from 'react'
import { useTerminalStore } from '@/stores/useTerminalStore'
import { useGitStore } from '@/stores/useGitStore'
import { Icon } from '@/design-system/Icon'

/** How often a visible terminal re-checks git (cheap `git --no-optional-locks` calls, deduped per repo). */
const REFRESH_MS = 5000

/**
 * Compact git/GitHub chip that lives in the terminal panel's HEADER, right after the title — panel
 * metadata belongs in the chrome, never floating over the terminal content. Shows branch + dirty ●
 * + ahead↑/behind↓ and the GitHub repo (click → opens it). The cwd is the terminal's live OSC-7
 * directory, so it follows a `cd`. Reads git LOCAL — no auth. Renders nothing until cwd is a repo.
 */
export function TerminalGitChip({ termId }: { termId: string }) {
  const cwd = useTerminalStore((s) => s.byPanel[termId]?.cwd)
  const status = useGitStore((s) => (cwd ? s.byCwd[cwd]?.status : undefined))
  const refresh = useGitStore((s) => s.refresh)

  useEffect(() => {
    if (!cwd) return
    refresh(cwd, true)
    const id = window.setInterval(() => {
      if (!document.hidden) refresh(cwd) // don't poll git while the window is minimized
    }, REFRESH_MS)
    const onFocus = () => refresh(cwd, true)
    window.addEventListener('focus', onFocus)
    return () => {
      window.clearInterval(id)
      window.removeEventListener('focus', onFocus)
    }
  }, [cwd, refresh])

  if (!cwd || !status?.isRepo) return null

  const branch = status.branch ?? 'HEAD'
  const repo = status.remote

  return (
    <div
      className="app-no-drag flex min-w-0 shrink items-center gap-1.5 font-mono text-[11px] text-text-tertiary"
      title={cwd}
    >
      {/* a faint divider so the chip reads as metadata after the title, not part of it */}
      <span className="h-3.5 w-px shrink-0 bg-[var(--border-subtle)]" aria-hidden />

      <span className="flex shrink-0 items-center gap-1 text-text-secondary">
        <Icon name="GitBranch" size={12} />
        <span className="max-w-[120px] truncate" title={`Branch: ${branch}`}>
          {branch}
        </span>
      </span>

      {status.dirty && (
        <span className="shrink-0 text-accent" title="Uncommitted changes" aria-label="Uncommitted changes">
          ●
        </span>
      )}
      {status.hasUpstream && status.ahead > 0 && (
        <span className="flex shrink-0 items-center" title={`${status.ahead} ahead of upstream`}>
          <Icon name="ArrowUp" size={11} />
          {status.ahead}
        </span>
      )}
      {status.hasUpstream && status.behind > 0 && (
        <span className="flex shrink-0 items-center" title={`${status.behind} behind upstream`}>
          <Icon name="ArrowDown" size={11} />
          {status.behind}
        </span>
      )}

      {repo && (
        <button
          type="button"
          onClick={() => void window.plano.shell.openExternal(repo.webUrl)}
          className="flex min-w-0 shrink items-center gap-1 transition-colors hover:text-text-primary"
          title={`Open ${repo.owner}/${repo.repo} on ${repo.host}`}
        >
          <Icon name={repo.isGitHub ? 'Github' : 'ExternalLink'} size={12} className="shrink-0" />
          <span className="truncate">
            {repo.owner}/{repo.repo}
          </span>
        </button>
      )}
    </div>
  )
}
