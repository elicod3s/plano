/**
 * opencode-go adapter — OpenCode Go subscription usage via opencode.ai's SST/TanStack
 * server-fn protocol (NOT a REST path; `https://opencode.ai/api/usage` was a guess and is gone).
 *
 * Protocol (extracted from Orca's shipped main bundle — its own working implementation — and
 * live-tested on this machine):
 *   1. Workspaces: GET https://opencode.ai/_server?id=<WORKSPACES_SERVER_ID> with
 *      X-Server-Id / X-Server-Instance headers → a script whose text contains `id: "wrk_…"`.
 *   2. Usage:     GET https://opencode.ai/workspace/<id>/go (an HTML page) → embedded
 *      `rollingUsage` / `weeklyUsage` / `monthlyUsage` objects with `usagePercent` + `resetInSec`.
 *
 * Credentials, in order:
 *   - the pasted cookie (Settings → Usage, `usage.opencodeCookie`): a bare `Fe26.2**…` token
 *     (wrapped as `auth=…`) or a full cookie header — this is the ONLY credential that
 *     authenticates the web console (live-verified: the sk- API key gets "actor of type public").
 *   - `~/.local/share/opencode/auth.json` → `opencode-go.key`: the CLI's API key. It
 *     authenticates the MODEL api, NOT the web console — so with only this key the row EXISTS
 *     and explains that the web-session cookie is required. (Preferred for DETECTION — the
 *     plan's "prefer the auth file" — while the cookie remains the working fetch credential.)
 *
 * Rule: credentials present but quota unreadable → the row EXISTS with the reason; credentials
 * absent → no row. Never a 0 % meter.
 */

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import type { ProviderUsage, UsageWindow } from '@shared/domain/usage'

const BASE_URL = (process.env.OPENCODE_BASE_URL?.trim() || 'https://opencode.ai').replace(/\/+$/, '')
const SERVER_URL = `${BASE_URL}/_server`
/** The server-fn id Orca calls for the workspace list (stable across releases). */
const WORKSPACES_SERVER_ID = 'def39973159c7f0483d8793a822b8dbb10d067e12c65455fcb4608459ba0234f'
const TIMEOUT_MS = 15_000

export function openCodeAuthPath(): string {
  return join(homedir(), '.local', 'share', 'opencode', 'auth.json')
}

/** The CLI's API key for the `opencode-go` provider (auth.json), or ''. */
export function apiKeyFromAuthFile(): string {
  try {
    const doc = JSON.parse(readFileSync(openCodeAuthPath(), 'utf8')) as { 'opencode-go'?: { key?: unknown } }
    return typeof doc['opencode-go']?.key === 'string' ? doc['opencode-go'].key : ''
  } catch {
    return ''
  }
}

/** Read the cookie from <userData>/settings.json (tolerant). */
export function cookieFromSettings(userData: string): string {
  try {
    const doc = JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8')) as { usage?: { opencodeCookie?: unknown } }
    return typeof doc.usage?.opencodeCookie === 'string' ? doc.usage.opencodeCookie : ''
  } catch {
    return ''
  }
}

/** Accept a bare `Fe26.2**…` token (→ `auth=…`), an `auth=`/`__Host-auth=` pair, or a full header. */
export function normalizeCookie(raw: string): string {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) return ''
  if (trimmed.includes(';') || /^(?:auth|__Host-auth)=/i.test(trimmed)) return trimmed
  if (trimmed.startsWith('Fe26.2**') || /^[a-zA-Z0-9.\-_]+$/.test(trimmed)) return `auth=${trimmed}`
  return trimmed
}

/** Workspace ids from the server-fn response text (`id: "wrk_…"` / `wk_…`). Exported for the probe. */
export function parseWorkspaceIds(text: string): string[] {
  const ids: string[] = []
  for (const match of text.matchAll(/\bid\s*:\s*["']((?:wrk|wk)_[a-zA-Z0-9]+)["']/g)) {
    const id = match[1]
    if (id && !ids.includes(id)) ids.push(id)
  }
  return ids
}

/** First top-level numeric field of a `{…}` block (depth-1 aware, like Orca). */
function extractTopLevelNumber(objText: string, fieldName: string): number | null {
  const fieldRegex = new RegExp(`\\b${fieldName}\\b\\s*:\\s*(-?[0-9]+(?:\\.[0-9]+)?)`)
  let depth = 0
  for (let i = 0; i < objText.length; i += 1) {
    const ch = objText[i]
    if (ch === '{') {
      depth += 1
      continue
    }
    if (ch === '}') {
      depth -= 1
      continue
    }
    if (depth === 1) {
      const slice = objText.slice(i, i + fieldName.length + 30)
      const m = fieldRegex.exec(slice)
      if (m && m.index === 0) {
        const n = Number.parseFloat(m[1])
        return Number.isFinite(n) ? n : null
      }
    }
  }
  return null
}

/** Find `key: {…}` with top-level `usagePercent` + `resetInSec` (mirrors Orca's parser). */
function extractUsageBlock(text: string, key: string): string | null {
  const keyRegex = new RegExp(`\\b${key}\\b\\s*:`, 'g')
  let keyMatch: RegExpExecArray | null
  while ((keyMatch = keyRegex.exec(text)) !== null) {
    const searchStart = keyMatch.index + keyMatch[0].length
    const braceOffset = text.slice(searchStart, searchStart + 30).indexOf('{')
    if (braceOffset === -1) continue
    const openBrace = searchStart + braceOffset
    let depth = 0
    let block: string | null = null
    for (let i = openBrace; i < text.length; i += 1) {
      if (text[i] === '{') depth += 1
      else if (text[i] === '}') {
        depth -= 1
        if (depth === 0) {
          block = text.slice(openBrace, i + 1)
          break
        }
      }
    }
    if (!block) continue
    if (extractTopLevelNumber(block, 'usagePercent') !== null && extractTopLevelNumber(block, 'resetInSec') !== null) return block
  }
  return null
}

/** Parse the /workspace/<id>/go page → session (rolling 5h) / weekly / monthly. Exported for the probe. */
export function parseOpenCodePage(text: string): { session: UsageWindow | null; weekly: UsageWindow | null; monthly: UsageWindow | null } | null {
  if (!text || text.length > 10_000_000) return null
  const rollingBlock = extractUsageBlock(text, 'rollingUsage')
  const weeklyBlock = extractUsageBlock(text, 'weeklyUsage')
  const monthlyBlock = extractUsageBlock(text, 'monthlyUsage')
  const rollingPercent = rollingBlock !== null ? extractTopLevelNumber(rollingBlock, 'usagePercent') : null
  const rollingReset = rollingBlock !== null ? extractTopLevelNumber(rollingBlock, 'resetInSec') : null
  const weeklyPercent = weeklyBlock !== null ? extractTopLevelNumber(weeklyBlock, 'usagePercent') : null
  const weeklyReset = weeklyBlock !== null ? extractTopLevelNumber(weeklyBlock, 'resetInSec') : null
  if (rollingPercent === null || rollingReset === null || weeklyPercent === null || weeklyReset === null) return null
  const make = (percent: number, resetInSec: number, minutes: number): UsageWindow => ({
    usedPercent: Math.min(100, Math.max(0, percent)),
    windowMinutes: minutes,
    resetsAt: Date.now() + resetInSec * 1000,
  })
  const monthlyPercent = monthlyBlock !== null ? extractTopLevelNumber(monthlyBlock, 'usagePercent') : null
  const monthlyReset = monthlyBlock !== null ? extractTopLevelNumber(monthlyBlock, 'resetInSec') : null
  return {
    session: make(rollingPercent, rollingReset, 300),
    weekly: make(weeklyPercent, weeklyReset, 10_080),
    monthly: monthlyPercent !== null && monthlyReset !== null ? make(monthlyPercent, monthlyReset, 43_200) : null,
  }
}

function unavailable(detail: string): ProviderUsage {
  return { provider: 'opencode-go', status: 'unavailable', session: null, weekly: null, monthly: null, source: 'api', updatedAt: Date.now(), detail }
}

interface FetchAuth {
  cookieHeader: string
  apiKey: string
}

function authHeaders(auth: FetchAuth): Record<string, string> {
  const headers: Record<string, string> = { Origin: BASE_URL, Referer: BASE_URL }
  if (auth.cookieHeader) headers.Cookie = auth.cookieHeader
  else if (auth.apiKey) headers.Authorization = `Bearer ${auth.apiKey}`
  return headers
}

/** Workspaces server-fn call → workspace ids. */
async function fetchWorkspaceIds(auth: FetchAuth): Promise<string[]> {
  const instanceId = `server-fn:${randomUUID()}`
  const res = await fetch(`${SERVER_URL}?id=${WORKSPACES_SERVER_ID}`, {
    method: 'GET',
    headers: {
      'X-Server-Id': WORKSPACES_SERVER_ID,
      'X-Server-Instance': instanceId,
      Accept: 'text/javascript, application/json;q=0.9, */*;q=0.8',
      ...authHeaders(auth),
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`Workspaces fetch failed (${res.status})`)
  return parseWorkspaceIds(await res.text())
}

/** The /workspace/<id>/go page (HTML with embedded usage objects). */
async function fetchUsagePage(id: string, auth: FetchAuth): Promise<string> {
  const res = await fetch(`${BASE_URL}/workspace/${id}/go`, {
    method: 'GET',
    headers: { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', ...authHeaders(auth) },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`Usage page fetch failed (${res.status})`)
  return res.text()
}

/** Adapter contract. `cookie` is the pasted Settings cookie (may be ''). Never throws. */
export async function read(cookie: string): Promise<ProviderUsage | null> {
  const apiKey = apiKeyFromAuthFile()
  const cookieHeader = normalizeCookie(cookie)
  if (!apiKey && !cookieHeader) return null // no credentials → absent, not zero
  const auth: FetchAuth = { cookieHeader, apiKey }
  try {
    const ids = await fetchWorkspaceIds(auth)
    if (ids.length === 0) {
      // Live-verified: the sk- API key alone reaches the server-fn as a "public" actor — the
      // web console requires the session cookie. State that, never invent a number.
      return unavailable(
        cookieHeader
          ? 'No workspace ID found — the cookie may have expired; paste a fresh one from opencode.ai DevTools'
          : 'Quota requires the opencode.ai web-session cookie — paste it in Settings → Usage (the API key alone cannot read usage)',
      )
    }
    let lastError = ''
    for (const id of ids) {
      try {
        const parsed = parseOpenCodePage(await fetchUsagePage(id, auth))
        if (parsed) {
          return {
            provider: 'opencode-go',
            status: 'ok',
            session: parsed.session,
            weekly: parsed.weekly,
            monthly: parsed.monthly,
            source: 'api',
            updatedAt: Date.now(),
          }
        }
        lastError = 'Could not parse usage data from page'
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err)
      }
    }
    return unavailable(lastError || 'Could not parse usage data from any available workspace')
  } catch (err) {
    return unavailable(err instanceof Error ? err.message : 'Unknown error')
  }
}

/** Retry-After handling (kept for the collector's backoff; the server-fn path rarely sends it). */
export function retryAfterSeconds(err: unknown): number | null {
  const ra = (err as { retryAfter?: string } | null)?.retryAfter
  if (!ra) return null
  const n = Number(ra)
  return Number.isFinite(n) && n > 0 ? Math.min(900, n) : null
}

export function hasCredentials(): boolean {
  return Boolean(normalizeCookie(cookieFromSettings(''))) || apiKeyFromAuthFile() !== ''
}

export function hasCookie(userData: string): boolean {
  return existsSync(join(userData, 'settings.json')) && normalizeCookie(cookieFromSettings(userData)) !== ''
}
