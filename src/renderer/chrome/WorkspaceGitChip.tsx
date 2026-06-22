import { useEffect } from 'react'
import { useWorkspaceStore } from '@/stores/useWorkspaceStore'
import { useGitStore } from '@/stores/useGitStore'
import { Icon } from '@/design-system/Icon'

/** How often the top-bar chip re-checks the workspace repo (deduped/throttled by the git store). */
const REFRESH_MS = 8000

/**
 * Top-bar git/GitHub indicator for the OPEN WORKSPACE folder: branch + dirty/ahead/behind and the
 * GitHub repo (click → opens it). Mirrors the per-terminal badge but for the project as a whole.
 * Reads git LOCAL — no auth. Renders nothing unless the workspace folder is itself a repo.
 */
export function WorkspaceGitChip() {
  const folderPath = useWorkspaceStore((s) => s.folderPath)
  const status = useGitStore((s) => (folderPath ? s.byCwd[folderPath]?.status : undefined))
  const refresh = useGitStore((s) => s.refresh)

  useEffect(() => {
    if (!folderPath) return
    refresh(folderPath, true)
    const id = window.setInterval(() => {
      if (!document.hidden) refresh(folderPath) // don't poll git while the window is minimized
    }, REFRESH_MS)
    const onFocus = () => refresh(folderPath, true)
    window.addEventListener('focus', onFocus)
    return () => {
      window.clearInterval(id)
      window.removeEventListener('focus', onFocus)
    }
  }, [folderPath, refresh])

  if (!folderPath || !status?.isRepo) return null

  const repo = status.remote
  return (
    <div
      className="app-no-drag flex shrink-0 items-center gap-1.5 rounded-pill border border-subtle px-2 py-1 font-mono text-[11px] leading-none text-text-secondary"
      style={{ background: 'var(--accent-soft)' }}
      title={`${repo ? `${repo.owner}/${repo.repo} · ` : ''}${status.branch ?? 'HEAD'}`}
    >
      <Icon name="GitBranch" size={13} className="text-text-primary" />
      <span className="max-w-[160px] truncate text-text-primary">{status.branch ?? 'HEAD'}</span>

      {status.dirty && (
        <span className="text-accent" title="Uncommitted changes">
          ●
        </span>
      )}
      {status.hasUpstream && status.ahead > 0 && (
        <span className="flex items-center" title={`${status.ahead} ahead of upstream`}>
          <Icon name="ArrowUp" size={11} />
          {status.ahead}
        </span>
      )}
      {status.hasUpstream && status.behind > 0 && (
        <span className="flex items-center" title={`${status.behind} behind upstream`}>
          <Icon name="ArrowDown" size={11} />
          {status.behind}
        </span>
      )}

      {repo && (
        <button
          type="button"
          onClick={() => void window.plano.shell.openExternal(repo.webUrl)}
          className="flex items-center gap-1 text-text-tertiary transition-colors hover:text-text-primary"
          title={`Open ${repo.owner}/${repo.repo} on ${repo.host}`}
        >
          <Icon name={repo.isGitHub ? 'Github' : 'ExternalLink'} size={12} />
        </button>
      )}
    </div>
  )
}
