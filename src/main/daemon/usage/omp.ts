/**
 * omp adapter — contract-complete null adapter for this pass.
 *
 * Same read() interface as the other providers: return null → the chip is ABSENT (never a
 * zero). Credential-gated by ~/.omp when it lands.
 */

import type { ProviderUsage } from '@shared/domain/usage'

export async function read(): Promise<ProviderUsage | null> {
  return null
}
