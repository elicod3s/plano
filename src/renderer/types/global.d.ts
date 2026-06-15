import type { PlanoApi } from '@shared/ipc/contracts'

/** The bridge exposed by the preload — visible to the renderer's type project. */
declare global {
  interface Window {
    plano: PlanoApi
  }
}

export {}
