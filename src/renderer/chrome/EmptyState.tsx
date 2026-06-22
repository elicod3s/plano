import { Icon } from '@/design-system/Icon'
import { BrandMark } from '@/design-system/BrandMark'
import { Button } from '@/design-system/Button'
import { addPanelAtCenter } from '@/app/actions'
import { openFolder } from '@/app/workspaceActions'
import { fmtKeys } from '@/lib/hotkeys'

/** Onboarding shown on an empty canvas. Click-through everywhere except the card. */
export function EmptyState() {
  return (
    <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center">
      <div className="pointer-events-auto flex w-[420px] max-w-[88vw] flex-col items-center gap-5 text-center">
        <BrandMark size={52} title="PLANO" className="text-text-primary" />
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
        <p className="flex flex-wrap items-center justify-center gap-x-2 gap-y-0.5 font-mono text-[11px] text-text-quaternary">
          <span className="whitespace-nowrap">{fmtKeys('Ctrl+K')} command palette</span>
          <span aria-hidden>·</span>
          <span className="whitespace-nowrap">{fmtKeys('Ctrl+Shift+E')} library</span>
          <span aria-hidden>·</span>
          <span className="whitespace-nowrap">right-click to add</span>
        </p>
      </div>
    </div>
  )
}
