/**
 * gemini adapter — contract-complete null adapter for this pass.
 *
 * Same read() interface as claude/codex/opencode: return null → the chip is ABSENT (never a
 * zero). Credential-gated by ~/.gemini when it lands.
 */

import type { ProviderUsage } from '@shared/domain/usage'

export async function read(): Promise<ProviderUsage | null> {
  return null
}
