import { useEffect, useState } from 'react'
import { Icon } from '@/design-system/Icon'
import { BrandMark } from '@/design-system/BrandMark'
import { Button } from '@/design-system/Button'
import { addPanelAtCenter } from '@/app/actions'
import { openFolder, openWorkspaceFolder } from '@/app/workspaceActions'
import { fmtKeys } from '@/lib/hotkeys'
import type { RecentWorkspace } from '@shared/domain/workspace'

/** "2h ago"-style relative time for a recent workspace row. */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const diff = Math.max(0, Date.now() - then)
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d === 1) return 'Yesterday'
  return `${d}d ago`
}

/** Last path segment (for the row name fallback). */
const basename = (p: string): string => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p

/** Onboarding shown on an empty canvas. Click-through everywhere except the card. */
export function EmptyState() {
  const [recents, setRecents] = useState<RecentWorkspace[]>([])

  useEffect(() => {
    let alive = true
    void window.plano.workspace
      .listRecent()
      .then((r) => {
        if (alive) setRecents(r.recents.slice(0, 3))
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])

  return (
    <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center pt-6">
      <div className="pointer-events-auto flex w-[480px] max-w-[88vw] flex-col items-center gap-5 text-center">
        {/* logo — the original PLANO mark, no box */}
        <BrandMark size={52} title="PLANO" className="text-text-1" />

        <div>
          <h1 className="font-display text-[28px] font-semibold tracking-tightui text-text-1">
            One screen for everything.
          </h1>
          <p className="mt-2 text-[14px] leading-relaxed text-text-2">
            Open a project, then drop terminals, files and agents onto the canvas.
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          <Button variant="primary" onClick={() => void openFolder()}>
            <Icon name="FolderOpen" size={15} />
            Open folder
          </Button>
          <Button variant="secondary" onClick={() => addPanelAtCenter('terminal')}>
            <Icon name="SquareTerminal" size={15} />
            New terminal
          </Button>
        </div>

        {/* recent workspaces */}
        {recents.length > 0 && (
          <div
            data-surface-layer="chrome"
            className="surface-layer surface-layer--chrome w-full overflow-hidden rounded-[20px] py-1.5"
          >
            <div className="flex h-6 items-center px-2.5 font-mono text-[10.5px] font-medium uppercase tracking-[0.08em] text-text-4">
              Recent
            </div>
            {recents.map((r) => (
              <button
                key={r.path}
                type="button"
                onClick={() => void openWorkspaceFolder(r.path)}
                className="flex h-[38px] w-full items-center gap-2.5 rounded-[10px] px-2.5 text-left transition-colors hover:bg-glass-hover focus-caliper"
              >
                <Icon name="Folder" size={14} className="shrink-0 text-text-3" />
                <span className="truncate text-[13px] text-text-1">{r.name || basename(r.path)}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-text-4">{r.path}</span>
                <span className="shrink-0 font-mono text-[10.5px] text-text-4">{relativeTime(r.lastOpened)}</span>
              </button>
            ))}
          </div>
        )}

        <p className="flex flex-wrap items-center justify-center gap-x-2 gap-y-0.5 font-mono text-[11px] text-text-4">
          <span className="whitespace-nowrap">{fmtKeys('Ctrl+K')} palette</span>
          <span aria-hidden>·</span>
          <span className="whitespace-nowrap">{fmtKeys('Ctrl+Shift+E')} library</span>
          <span aria-hidden>·</span>
          <span className="whitespace-nowrap">right-click to add</span>
        </p>
      </div>
    </div>
  )
}
