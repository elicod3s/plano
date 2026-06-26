/** Intent model — the structured meaning the grammar extracts from a spoken transcript. */
import type { PanelType } from '@shared/domain/panel'
import type { AgentKind } from '@shared/domain/agent'

/** Which existing panel(s) a close/focus command refers to. */
export type Target =
  | { sel: 'type'; type: PanelType; scope: 'one' | 'all' }
  | { sel: 'number'; n: number } //   a terminal by its visible badge number ("terminal 2")
  | { sel: 'agent'; kind: AgentKind } // the terminal running a given agent ("the Claude terminal")
  | { sel: 'all' } //    every floating panel ("close everything")
  | { sel: 'last' } //   "it" / "this" / "the last one" / "eso" / "lo" — the panel we just touched
  | { sel: 'front' } //  the focused / front-most panel

export type Intent =
  | {
      kind: 'create'
      type: PanelType
      count: number
      /** Free text for sticky/label/region/markdown content. */
      text?: string
      /** One-shot command to run in a new terminal (e.g. an agent CLI like `claude`). */
      bootCommand?: string
      /** URL to open in a new browser panel. */
      url?: string
      /** Caption noun override (e.g. "Claude Code" instead of "Terminal"). */
      noun?: string
    }
  | { kind: 'close'; target: Target }
  | { kind: 'focus'; target: Target }
  /** Type free text into a specific terminal's shell (e.g. give a prompt to the agent running there):
   *  "Terminal 1, create a React component" → writes that into terminal 1. */
  | { kind: 'prompt'; target: Target; text: string }
  | { kind: 'view'; action: 'fit' | 'reset' | 'zoomIn' | 'zoomOut' }
  | { kind: 'workspace'; action: 'new' | 'open' | 'save' | 'close' }
  | { kind: 'toggle'; what: 'minimap' | 'snapping' | 'palette' | 'settings' }
  | { kind: 'arrange' } //              tidy the canvas into a balanced grid
  /** Launch an agent CLI in EVERY open terminal ("corre claude en todas las terminales"). */
  | { kind: 'launchAll'; command: string; noun: string }
  /** Workspace/space control by voice: switch (next/prev/goto N), create, or close the current one. */
  | { kind: 'space'; op: 'next' | 'prev' | 'goto' | 'new' | 'close'; index?: number }
  /** Revert the last undoable command ("deshaz eso" / "undo"). */
  | { kind: 'undo' }
  | { kind: 'query'; what: 'agents' | 'panels' }
  | { kind: 'command'; id: string } //  direct match against the command registry
  | { kind: 'none' } //                 nothing intelligible was said
  | { kind: 'unknown'; text: string } // understood words, no matching action (→ LLM fallback)

/** Outcome of executing an intent, surfaced in the HUD caption (and optionally spoken). */
export interface ActionResult {
  ok: boolean
  /** Short English caption shown in the HUD, e.g. "Opened 2 Terminals". */
  summary: string
  /** What to speak when "speak responses" is on (defaults to summary). */
  spoken?: string
}
