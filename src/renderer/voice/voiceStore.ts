import { create } from 'zustand'
import type { VoiceStatus } from '@shared/ipc/contracts'

/** The HUD state machine. Energy (the live mic level) is NOT here — it's written straight to a CSS
 *  var each frame to avoid re-rendering React 60×/s; only these discrete phases drive the UI. */
export type VoicePhase = 'idle' | 'listening' | 'transcribing' | 'executing' | 'result' | 'error'

interface VoiceUiState {
  phase: VoicePhase
  /** Live/last recognized text (shown as the caption while transcribing/after). */
  transcript: string
  /** Outcome caption, e.g. "Opened 2 Terminals". */
  summary: string
  errorMsg: string
  /** Engine + bundled-model availability (polled on enable). */
  engine: VoiceStatus | null
  /** True once the user denied the mic permission (HUD nudges them). */
  micDenied: boolean
  set: (patch: Partial<Omit<VoiceUiState, 'set'>>) => void
}

export const useVoiceStore = create<VoiceUiState>((set) => ({
  phase: 'idle',
  transcript: '',
  summary: '',
  errorMsg: '',
  engine: null,
  micDenied: false,
  set: (patch) => set(patch),
}))
