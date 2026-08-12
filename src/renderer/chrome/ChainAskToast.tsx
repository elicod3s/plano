/**
 * v4 B3: chained-task Fire / Cancel toast. When an armed chain hits onFailure 'ask-user'
 * (the watched agent ended in error/exited/awaiting-input-past-umbral), the daemon asks
 * through main → this toast appears; Fire executes the chain anyway, Cancel fails it.
 */

import { useEffect, useState } from 'react'
import { Button } from '@/design-system/Button'

export function ChainAskToast() {
  const [prompt, setPrompt] = useState<{ chainId: string; from: string; to: string } | null>(null)

  useEffect(() => window.plano.agentMesh.onChainAskRequest(setPrompt), [])

  if (!prompt) return null
  const answer = (ok: boolean): void => {
    void window.plano.agentMesh.respondChainAsk(ok)
    setPrompt(null)
  }

  return (
    <div
      data-surface-layer="popover"
      className="animate-menu-in surface-layer surface-layer--popover fixed bottom-6 left-1/2 z-[var(--z-toast)] flex -translate-x-1/2 items-center gap-3 rounded-[16px] px-4 py-3"
    >
      <div className="min-w-0">
        <div className="text-[13px] font-medium text-text-1">Chained task ready</div>
        <div className="mt-0.5 text-[12px] leading-snug text-text-3">
          A chained task is about to fire but its trigger didn&apos;t end cleanly. Fire it anyway?
        </div>
      </div>
      <Button onClick={() => answer(true)}>Fire</Button>
      <Button variant="ghost" onClick={() => answer(false)}>
        Cancel
      </Button>
    </div>
  )
}
