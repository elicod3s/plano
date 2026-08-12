/**
 * Plan F8: one-click mesh-writes consent. When an agent inside the mesh first tries to send
 * messages / spawn agents in a workspace, the daemon asks through main → this toast appears;
 * clicking Allow enables mesh writes for that workspace (remembered), Deny refuses. No JSON,
 * no settings screen — one click, exactly as the plan demands.
 */

import { useEffect, useState } from 'react'
import { Button } from '@/design-system/Button'

export function MeshConsentToast() {
  const [prompt, setPrompt] = useState<{ spaceId: string } | null>(null)

  useEffect(() => window.plano.agentMesh.onConsentRequest(setPrompt), [])

  if (!prompt) return null
  const answer = (ok: boolean): void => {
    void window.plano.agentMesh.respondConsent(ok)
    setPrompt(null)
  }

  return (
    <div
      data-surface-layer="popover"
      className="animate-menu-in surface-layer surface-layer--popover fixed bottom-6 left-1/2 z-[var(--z-toast)] flex -translate-x-1/2 items-center gap-3 rounded-[16px] px-4 py-3"
    >
      <div className="min-w-0">
        <div className="text-[13px] font-medium text-text-1">Mesh writes</div>
        <div className="mt-0.5 text-[12px] leading-snug text-text-3">
          An agent wants to message other agents and spawn new ones in this workspace. Allow it?
        </div>
      </div>
      <Button onClick={() => answer(true)}>Allow</Button>
      <Button variant="ghost" onClick={() => answer(false)}>
        Deny
      </Button>
    </div>
  )
}
