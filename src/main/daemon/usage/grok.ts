/**
 * grok adapter — Grok Build (x.ai) subscription usage.
 *
 * Credentials: ~/.grok/auth.json (honours GROK_HOME), keyed `"https://auth.x.ai::<uuid>"` with
 * the OAuth JWT under `key`, `expires_at` (ISO), `user_id`, `email`.
 *
 * Endpoint (NOT guessed — extracted from the shipped main bundle, the same "read the
 * binary" move that settled the Claude schema, and verified live on this machine):
 *   GET https://cli-chat-proxy.grok.com/v1/billing?format=credits
 *   headers: Authorization: Bearer <JWT>, X-XAI-Token-Auth: xai-grok-cli, x-userid: <user_id>
 *   → { config: { creditUsagePercent, currentPeriod: { type, start, end },
 *                 billingPeriodStart, billingPeriodEnd, monthlyLimit?: { val }, used?: { val } } }
 * Live result on this machine (2026-08-12): creditUsagePercent 46, weekly period ending
 * 2026-08-15T19:35Z. Monthly usage is a fallback via /billing (no ?format) when the credits
 * response carries monthlyLimit/used.
 *
 * Mapping: weekly = creditUsagePercent (10080 min, resets at period end); monthly = used/limit
 * (43200 min). A missing/expired/invalid credential → the row EXISTS with the reason; no
 * auth.json at all → absent (never a 0 % meter).
 */

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { ProviderUsage, UsageWindow } from '@shared/domain/usage'

const PROXY_BASE = (process.env.GROK_CLI_CHAT_PROXY_BASE_URL?.trim() || 'https://cli-chat-proxy.grok.com/v1').replace(/\/+$/, '')
const BILLING_CREDITS_URL = `${PROXY_BASE}/billing?format=credits`
const BILLING_DEFAULT_URL = `${PROXY_BASE}/billing`
const TIMEOUT_MS = 10_000
const GROK_CLI_AUTH_HEADER = 'xai-grok-cli'
/** Tokens within 5 min of expiry are treated as expired (provider skew). */
const TOKEN_SKEW_MS = 300_000
const WEEKLY_MIN = 10_080
const MONTHLY_MIN = 43_200
const PREFERRED_ISSUER = 'https://auth.x.ai'

export function grokHome(): string {
  return process.env.GROK_HOME?.trim() || join(homedir(), '.grok')
}

export function grokAuthPath(): string {
  return join(grokHome(), 'auth.json')
}

interface GrokSession {
  accessToken: string
  userId: string | null
  email: string | null
  expiresAtMs: number | null
}

function parseExpiresAtMs(value: unknown): number | null {
  if (typeof value !== 'string' || !value) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

function sessionFromEntry(entry: Record<string, unknown>): GrokSession | null {
  if (typeof entry.key !== 'string' || entry.key.length === 0) return null
  return {
    accessToken: entry.key,
    userId: typeof entry.user_id === 'string' ? entry.user_id : null,
    email: typeof entry.email === 'string' ? entry.email : null,
    expiresAtMs: parseExpiresAtMs(entry.expires_at),
  }
}

function isFresh(session: GrokSession): boolean {
  return session.expiresAtMs === null || session.expiresAtMs - Date.now() > TOKEN_SKEW_MS
}

type AuthRead =
  | { status: 'missing' }
  | { status: 'error'; error: string }
  | { status: 'ok'; session: GrokSession }

/** Read ~/.grok/auth.json — preferred (auth.x.ai) keys first, fresh ones win. */
export function readGrokAuth(): AuthRead {
  try {
    if (!existsSync(grokAuthPath())) return { status: 'missing' }
    const parsed = JSON.parse(readFileSync(grokAuthPath(), 'utf8')) as Record<string, unknown>
    if (typeof parsed !== 'object' || parsed === null) return { status: 'error', error: 'Grok auth file is invalid' }
    let preferredSeen = false
    let expiredPreferred: GrokSession | null = null
    let fallback: GrokSession | null = null
    for (const [key, value] of Object.entries(parsed)) {
      const isPreferred = key === PREFERRED_ISSUER || key.startsWith(`${PREFERRED_ISSUER}::`)
      preferredSeen ||= isPreferred
      const entry = value as Record<string, unknown> | null
      const session = typeof entry === 'object' && entry !== null ? sessionFromEntry(entry) : null
      if (!session) continue
      if (isPreferred) {
        if (isFresh(session)) return { status: 'ok', session }
        expiredPreferred ??= session
        continue
      }
      if (!fallback) fallback = session
    }
    const selected = expiredPreferred ?? (preferredSeen ? null : fallback)
    if (selected) return { status: 'ok', session: selected }
    return { status: 'missing' }
  } catch (err) {
    return { status: 'error', error: err instanceof SyntaxError ? 'Grok auth file is invalid' : 'Unable to read Grok auth file' }
  }
}

/** Tolerant parse of the billing credits config → weekly + monthly windows. Exported for the probe. */
export function parseGrokBillingConfig(config: Record<string, unknown> | null | undefined): { weekly: UsageWindow | null; monthly: UsageWindow | null } {
  if (!config || typeof config !== 'object') return { weekly: null, monthly: null }
  const periodEnd = typeof config.currentPeriod === 'object' && config.currentPeriod !== null
    ? (config.currentPeriod as Record<string, unknown>).end
    : config.billingPeriodEnd
  const resetsAt = typeof periodEnd === 'string' && periodEnd ? Date.parse(periodEnd) : NaN
  const resetMs = Number.isFinite(resetsAt) ? resetsAt : null

  // Weekly: the unified credit percentage; a confirmed weekly period with no number reads as 0.
  const period = config.currentPeriod as Record<string, unknown> | null
  const weeklyConfirmed =
    period?.type === 'USAGE_PERIOD_TYPE_WEEKLY' &&
    typeof period.start === 'string' &&
    typeof period.end === 'string' &&
    period.start === config.billingPeriodStart &&
    period.end === config.billingPeriodEnd
  const usedPercent =
    typeof config.creditUsagePercent === 'number' ? config.creditUsagePercent : weeklyConfirmed ? 0 : NaN
  const weekly =
    Number.isFinite(usedPercent)
      ? { usedPercent: Math.min(100, Math.max(0, usedPercent)), windowMinutes: WEEKLY_MIN, resetsAt: resetMs }
      : null

  // Monthly: used/limit from { val } money fields.
  const moneyVal = (v: unknown): number | null => {
    if (typeof v !== 'object' || v === null) return null
    const raw = (v as Record<string, unknown>).val
    const num = typeof raw === 'string' ? Number.parseFloat(raw) : typeof raw === 'number' ? raw : NaN
    return Number.isFinite(num) ? num : null
  }
  const limit = moneyVal(config.monthlyLimit)
  const used = moneyVal(config.used)
  const monthly =
    limit !== null && used !== null && limit > 0
      ? { usedPercent: Math.min(100, Math.max(0, (used / limit) * 100)), windowMinutes: MONTHLY_MIN, resetsAt: resetMs }
      : null

  return { weekly, monthly }
}

function unavailable(detail: string): ProviderUsage {
  return { provider: 'grok', status: 'unavailable', session: null, weekly: null, monthly: null, source: 'api', updatedAt: Date.now(), detail }
}

/** GET the billing endpoint with the grok CLI's own headers. */
async function fetchBilling(url: string, session: GrokSession): Promise<{ kind: 'data'; data: Record<string, unknown> } | { kind: 'result'; provider: ProviderUsage }> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${session.accessToken}`,
    'X-XAI-Token-Auth': GROK_CLI_AUTH_HEADER,
    Accept: 'application/json',
  }
  if (session.userId) headers['x-userid'] = session.userId
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (res.status === 401 || res.status === 403) return { kind: 'result', provider: unavailable(`Grok usage request unauthorized (HTTP ${res.status})`) }
  if (!res.ok) return { kind: 'result', provider: unavailable(`Grok usage request failed (HTTP ${res.status})`) }
  const data = (await res.json()) as Record<string, unknown>
  return { kind: 'data', data: typeof data === 'object' && data !== null ? data : {} }
}

/** Adapter contract. Never throws into the collector. */
export async function read(): Promise<ProviderUsage | null> {
  const auth = readGrokAuth()
  if (auth.status === 'missing') return null // no credentials → absent, not zero
  if (auth.status === 'error') return unavailable(auth.error)
  const session = auth.session
  if (!isFresh(session)) return unavailable('Grok sign-in expired — run grok login')
  try {
    const outcome = await fetchBilling(BILLING_CREDITS_URL, session)
    if (outcome.kind === 'result') return outcome.provider
    const config = (outcome.data.config as Record<string, unknown> | undefined) ?? (typeof outcome.data.creditUsagePercent === 'number' ? outcome.data : null)
    if (!config) return unavailable('Grok billing response did not include config')
    const { weekly, monthly } = parseGrokBillingConfig(config)
    if (weekly) {
      const monthlyFallback = monthly ?? (await fetchBilling(BILLING_DEFAULT_URL, session).then((o) => (o.kind === 'data' ? parseGrokBillingConfig(o.data.config as Record<string, unknown> | undefined ?? o.data).monthly : null)).catch(() => null))
      return { provider: 'grok', status: 'ok', session: null, weekly, monthly: monthlyFallback, source: 'api', updatedAt: Date.now() }
    }
    if (monthly) return { provider: 'grok', status: 'ok', session: null, weekly: null, monthly, source: 'api', updatedAt: Date.now() }
    return unavailable('Grok billing response did not include credit usage')
  } catch (err) {
    return unavailable(err instanceof Error ? err.message : 'Grok usage request failed')
  }
}
