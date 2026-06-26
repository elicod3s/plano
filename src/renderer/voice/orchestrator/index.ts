/**
 * The orchestrator entry point: spoken text → action. Grammar first (instant, local, free); only an
 * `unknown` result falls through to the optional LLM (when the user enabled it in Settings).
 */
import { parseIntent } from './grammar'
import { executeIntent, resetVoiceContext } from './execute'
import { geminiInterpret } from './gemini'
import { llmInterpret } from './llmFallback'
import type { ActionResult } from './types'

/**
 * Spoken text → action. Two-tier for the best of both: the local fuzzy grammar handles the commands
 * it recognizes INSTANTLY and reliably (no network lag — and it's more dependable than a tiny cloud
 * model on structured commands like "abre dos terminales con claude"). Anything it can't place falls
 * through to Gemini, the smart engine, which understands free-form speech and resolves references —
 * so Odla can still "open and move whatever you describe". An optional local LLM is the last resort.
 */
export async function runCommand(text: string): Promise<ActionResult> {
  // 1) Local grammar — instant + reliable for the known command surface.
  const fuzzy = parseIntent(text)
  if (fuzzy.kind !== 'unknown') return executeIntent(fuzzy)

  // 2) Gemini — the intelligence for novel phrasings / complex references the grammar didn't catch.
  const viaGemini = await geminiInterpret(text)
  if (viaGemini && viaGemini.kind !== 'none' && viaGemini.kind !== 'unknown') {
    return executeIntent(viaGemini)
  }

  // 3) Optional OpenAI-compatible fallback (off by default), then give up gracefully.
  const viaLlm = await llmInterpret(text)
  if (viaLlm) return executeIntent(viaLlm)
  return executeIntent(fuzzy)
}

export { resetVoiceContext }
export type { ActionResult } from './types'
