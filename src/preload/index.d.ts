import type { PlanoApi } from '@shared/ipc/contracts'

declare global {
  interface Window {
    plano: PlanoApi
  }
}

export {}
