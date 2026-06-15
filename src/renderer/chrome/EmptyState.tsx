import { Icon } from '@/design-system/Icon'
import { Button } from '@/design-system/Button'
import { addPanelAtCenter } from '@/app/actions'
import { openFolder } from '@/app/workspaceActions'

/** Onboarding shown on an empty canvas. Click-through everywhere except the card. */
export function EmptyState() {
  return (
    <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center">
      <div className="pointer-events-auto flex w-[420px] max-w-[88vw] flex-col items-center gap-5 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-accent text-text-onsolid">
          <Icon name="Frame" size={24} strokeWidth={2} />
        </div>
        <div>
          <h1 className="font-display text-[26px] font-semibold tracking-tightui text-text-primary">
            One screen for everything.
          </h1>
          <p className="mt-2 text-[14px] leading-relaxed text-text-secondary">
            Open a project, then drop terminals, files, browsers and AI agents onto the
            canvas. Right-click anywhere to add a panel.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="primary" onClick={() => void openFolder()}>
            <Icon name="FolderOpen" size={15} />
            Open folder
          </Button>
          <Button variant="secondary" onClick={() => addPanelAtCenter('terminal')}>
            <Icon name="SquareTerminal" size={15} />
            New terminal
          </Button>
        </div>
        <p className="font-mono text-[11px] text-text-quaternary">
          ⌘K command palette · ⌃⇧E library · right-click to add
        </p>
      </div>
    </div>
  )
}
