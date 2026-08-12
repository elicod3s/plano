/**
 * claude adapter — Claude Code subscription usage via its `statusLine` hook.
 *
 * Primary source: Claude Code (≥2.1.80) pipes a JSON payload to the configured status-line
 * command on every turn; for Claude.ai-subscriber sessions it carries
 * `rate_limits: { five_hour: { used_percentage, resets_at }, seven_day: { … } }`. This rides
 * existing API responses — free — whereas the OAuth usage endpoint 429s under polling.
 *
 * The hook is installed into `<userData>/bin/plano-statusline.cmd` (+ POSIX twin) and merged
 * into `~/.claude/settings.json` ONLY when the user has no statusLine of their own. If they do,
 * the user's config is never clobbered: the provider is reported `unavailable` with a detail
 * string instead. The hook script writes NO stdout (the user's status line must not change),
 * guards on `rate_limits` before anything else (the hook fires ~3×/s while streaming), throttles
 * to one POST per 15 s per pane, and POSTs the payload to the Agent Host's loopback
 * `/usage/claude` endpoint.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { request as httpsRequest } from 'node:https'
import { homedir, tmpdir } from 'node:os'
import type { ProviderUsage, UsageWindow } from '@shared/domain/usage'

/** The web server port the hook POSTs to (matches FIXED_WEB_PORT in daemon/index.ts). */
const USAGE_ENDPOINT = 'http://127.0.0.1:56780/usage/claude'

/**
 * `%INNER%` is replaced by the user's own statusLine command, or removed when there is none.
 *
 * ASCII ONLY, and written with CRLF (see writeHook). cmd.exe re-seeks the batch file by byte
 * offset between lines: LF-only endings make it resume mid-token (`setlocal` came back as
 * "'ocal' is not recognized"), and a non-ASCII byte in a comment shifts everything after it in
 * the OEM codepage. Both turn this script into noise that never posts.
 */
const CMD_TEMPLATE = `@echo off
setlocal EnableExtensions
rem PLANO statusLine hook - forwards Claude Code rate_limits to the Agent Host.
rem Writes stdout ONLY by passing through the user's own statusLine command (chained below), so
rem the visible status line is byte-for-byte what it was before PLANO touched anything.
set "PANE=default"
if defined CLAUDE_PANE_KEY set "PANE=%CLAUDE_PANE_KEY%"
set "PAYLOAD=%TEMP%\\plano-sl-%PANE%.json"
set "STAMP=%TEMP%\\plano-sl-stamp-%PANE%"
rem Capture the WHOLE payload ("^" matches every line): the chained command needs it verbatim.
findstr "^" > "%PAYLOAD%"
%INNER%
rem Guard: the hook fires ~3x/s while streaming; only a payload carrying rate_limits is worth a POST.
findstr /c:"rate_limits" "%PAYLOAD%" >nul 2>&1
if errorlevel 1 exit /b 0
rem Throttle: one POST per 15 s per pane (stamp file mtime).
powershell -NoProfile -Command "$s='%STAMP%'; $p='%PAYLOAD%'; if (Test-Path $s) { if ((Get-Item $s).LastWriteTime.AddSeconds(15) -gt (Get-Date)) { exit 1 } }; (Get-Item $p).LastWriteTime = Get-Date; Set-Content -Path $s -Value (Get-Date)" >nul 2>&1
if errorlevel 1 exit /b 0
curl -sS -X POST "${USAGE_ENDPOINT}" -H "Content-Type: application/json" -H "X-Claude-Pane: %PANE%" --data-binary "@%PAYLOAD%" >nul 2>&1
exit /b 0
`

const SH_TEMPLATE = `#!/bin/sh
# PLANO statusLine hook — forwards Claude Code rate_limits to the Agent Host.
# Never writes to stdout: the user's own status line must not change.
PANE="\${CLAUDE_PANE_KEY:-default}"
PAYLOAD="\${TMPDIR:-/tmp}/plano-sl-\${PANE}.json"
STAMP="\${TMPDIR:-/tmp}/plano-sl-stamp-\${PANE}"
cat > "\$PAYLOAD"
%INNER%
grep -q '"rate_limits"' "\$PAYLOAD" || exit 0
if [ -f "\$STAMP" ] && [ "\$((\$(date +%s) - \$(stat -c %Y "\$STAMP" 2>/dev/null || echo 0)))" -lt 15 ]; then exit 0; fi
: > "\$STAMP"
curl -sS -X POST "${USAGE_ENDPOINT}" -H "Content-Type: application/json" -H "X-Claude-Pane: \${PANE}" --data-binary "@\$PAYLOAD" >/dev/null 2>&1
exit 0
`

export interface ClaudeHookResult {
  merged: boolean
  /** Non-empty when the merge was skipped (never clobbers a user's config). */
  reason?: string
  /** Path of the installed hook script (the merged command target). */
  hookPath?: string
  /** The user's own statusLine command, now run by ours and passed through verbatim. */
  chained?: string
}

/** True for a userData under the OS temp dir — a probe/dev instance, not the user's install. */
function isThrowawayUserData(userData: string): boolean {
  const norm = (p: string): string => p.replace(/\\/g, '/').toLowerCase()
  return norm(userData).startsWith(norm(tmpdir()))
}

/** Where the user's original statusLine command is recorded, so it survives re-installs. */
function chainedFile(userData: string): string {
  return join(userData, 'bin', 'plano-statusline-chained.txt')
}

function readChainedCommand(userData: string): string {
  try {
    return readFileSync(chainedFile(userData), 'utf8').trim()
  } catch {
    return ''
  }
}

/**
 * Write both hook scripts with the user's command chained in (or nothing when there is none).
 * The chained command receives the SAME payload on stdin and its stdout is not touched, so the
 * status line the user sees is exactly what their own script prints.
 */
function writeHook(cmdPath: string, shPath: string, chained: string): void {
  const cmd = CMD_TEMPLATE.replace('%INNER%', chained ? `type "%PAYLOAD%" | ${chained}` : 'rem no chained statusLine')
  // CRLF + ASCII, or cmd.exe mis-parses the script (see CMD_TEMPLATE). Non-ASCII can only enter
  // through the user's own chained command, so it is stripped here rather than trusted.
  writeFileSync(cmdPath, cmd.replace(/[^\x20-\x7E\n]/g, '').replace(/\n/g, '\r\n'), 'ascii')
  writeFileSync(shPath, SH_TEMPLATE.replace('%INNER%', chained ? `cat "$PAYLOAD" | ${chained}` : '# no chained statusLine'), 'utf8')
}

export function claudeSettingsPath(): string {
  return join(homedir(), '.claude', 'settings.json')
}

function claudeCredentialsPresent(): boolean {
  return existsSync(join(homedir(), '.claude', '.credentials.json'))
}

/** Install the statusLine hook script + merge it into ~/.claude/settings.json (idempotent). */
export function installUsageHook(userData: string): ClaudeHookResult {
  try {
    mkdirSync(join(userData, 'bin'), { recursive: true })
    const cmdPath = join(userData, 'bin', 'plano-statusline.cmd')
    const shPath = join(userData, 'bin', 'plano-statusline')
    const command = process.platform === 'win32' ? `cmd /c "${cmdPath}"` : shPath
    if (!claudeCredentialsPresent()) {
      // No Claude.ai session on this machine — the hook would fire into the void. Absent.
      writeHook(cmdPath, shPath, '')
      return { merged: false, reason: 'no Claude credentials', hookPath: cmdPath }
    }
    // A daemon running out of a THROWAWAY userData (the e2e probes, an isolated dev run) must
    // never touch the machine-wide Claude config: it would repoint the user's statusLine at a
    // script that disappears with the temp directory. It still writes its own hook scripts, so
    // everything downstream of the endpoint stays testable.
    if (isThrowawayUserData(userData)) {
      return { merged: false, reason: 'throwaway userData — global Claude config left untouched', hookPath: cmdPath }
    }
    const settingsPath = claudeSettingsPath()
    let settings: Record<string, unknown> = {}
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>
    } catch {
      /* missing/corrupt — start from an empty doc (never throw) */
    }
    // A statusLine the user wrote is CHAINED, not replaced: our script runs theirs with the same
    // stdin and passes its stdout straight through, so the line they see is unchanged while the
    // quota still reaches PLANO. Refusing to touch it (the previous behaviour) meant anyone with
    // a custom status line simply never got a Claude reading. The original is recorded next to
    // the hook so it can always be restored.
    const existing = settings.statusLine as { command?: unknown } | undefined
    const existingCmd = typeof existing?.command === 'string' ? existing.command : ''
    // NEVER chain another plano hook. A test/dev daemon that found OUR command in the global
    // config used to chain it and point the user's statusLine at its own throwaway script; when
    // its temp userData was deleted the user's status line pointed at a file that no longer
    // existed. Any plano-statusline command is ours to replace, never to wrap.
    const isOurs = /plano-statusline/i.test(existingCmd)
    const chained = existingCmd && !isOurs ? existingCmd : readChainedCommand(userData)
    writeHook(cmdPath, shPath, chained)
    if (existingCmd === command) return { merged: true, hookPath: cmdPath, chained: chained || undefined }
    if (chained) writeFileSync(join(userData, 'bin', 'plano-statusline-chained.txt'), chained, 'utf8')
    settings.statusLine = { type: 'command', command }
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8')
    return { merged: true, hookPath: cmdPath, chained: chained || undefined }
  } catch (err) {
    // The hook must never take the Agent Host down: report why it couldn't install.
    return { merged: false, reason: `hook install failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}

/** Last POSTed claude usage (push-driven: the statusLine hook is the refresh). */
let lastPost: ProviderUsage | null = null

/** Parse a `resets_at` that may be epoch seconds OR an ISO string. Null when unparseable. */
function parseResetsAt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e12 ? value : value * 1000 // epoch seconds → ms
  }
  if (typeof value === 'string' && value) {
    const t = Date.parse(value)
    return Number.isFinite(t) ? t : null
  }
  return null
}

/** One rate-limit window from the payload; null when neither percent nor reset parses. */
function parseWindow(value: unknown, fallbackMinutes: number): UsageWindow | null {
  if (!value || typeof value !== 'object') return null
  const o = value as Record<string, unknown>
  const usedRaw =
    typeof o.used_percentage === 'number' ? o.used_percentage : typeof o.utilization === 'number' ? o.utilization : NaN
  if (!Number.isFinite(usedRaw)) return null
  // `utilization` is a 0..1 fraction in some payloads; `used_percentage` is already 0..100.
  const usedPercent = usedRaw > 1 ? usedRaw : usedRaw * 100
  const windowMinutes = typeof o.window_minutes === 'number' && o.window_minutes > 0 ? o.window_minutes : fallbackMinutes
  return {
    usedPercent: Math.min(100, Math.max(0, usedPercent)),
    windowMinutes,
    resetsAt: parseResetsAt(o.resets_at),
  }
}

/**
 * Tolerant parser for the statusLine payload the hook POSTs. Accepts `used_percentage` OR
 * `utilization`, and `resets_at` as epoch seconds OR ISO string. Drops a window when neither
 * parses. Returns null when no window survived.
 */
export function parseClaudePayload(raw: unknown): ProviderUsage | null {
  const rateLimits = (raw as { rate_limits?: unknown } | null)?.rate_limits
  if (!rateLimits || typeof rateLimits !== 'object') return null
  const rl = rateLimits as Record<string, unknown>
  const session = parseWindow(rl.five_hour ?? rl.fiveHour, 300)
  const weekly = parseWindow(rl.seven_day ?? rl.sevenDay, 10080)
  // The premium-model weekly allowance is its own budget (the CLI ships `seven_day_opus`, with
  // `seven_day_sonnet` as the sibling); a subscriber usually exhausts it before the general one,
  // so folding it into `weekly` would hide the number that actually bites.
  const premiumWeekly = parseWindow(rl.seven_day_opus ?? rl.sevenDayOpus, 10080)
  if (!session && !weekly && !premiumWeekly) return null
  return {
    provider: 'claude',
    status: 'ok',
    session,
    weekly,
    premiumWeekly,
    premiumLabel: premiumWeekly ? 'Fable' : undefined,
    monthly: null,
    source: 'statusline',
    updatedAt: Date.now(),
  }
}

/**
 * Fallback source: Claude's own OAuth usage endpoint.
 *
 * The statusLine hook is the fast path but it only fires on a turn — and Claude Code reads
 * `settings.json` at session START, so a session that was already open when PLANO installed the
 * hook never reports at all. Polling the endpoint the CLI itself uses closes that gap. It is
 * rate-limited (Orca documents 429s under tight polling), so the collector calls this on a slow
 * cadence and the hook keeps providing the live updates.
 *
 * Credentials come from `~/.claude/.credentials.json` → `claudeAiOauth.accessToken`; an expired
 * token is reported, never refreshed here (the refresh flow belongs to Claude Code).
 */
const OAUTH_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const OAUTH_BETA = 'oauth-2025-04-20'

interface ClaudeOauthCreds {
  accessToken: string
  expiresAt: number
}

function readOauthCreds(): ClaudeOauthCreds | null {
  try {
    const raw = JSON.parse(readFileSync(join(homedir(), '.claude', '.credentials.json'), 'utf8')) as {
      claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown }
    }
    const token = raw.claudeAiOauth?.accessToken
    if (typeof token !== 'string' || !token) return null
    const expiresAt = typeof raw.claudeAiOauth?.expiresAt === 'number' ? raw.claudeAiOauth.expiresAt : 0
    return { accessToken: token, expiresAt }
  } catch {
    return null
  }
}

/** Read the quota from the OAuth endpoint. Returns null when there is nothing to report. */
export async function readOauthUsage(): Promise<ProviderUsage | null> {
  const creds = readOauthCreds()
  if (!creds) return null
  if (creds.expiresAt && creds.expiresAt < Date.now()) return null // stale token: let the hook win
  const body = await new Promise<unknown>((resolve, reject) => {
    const req = httpsRequest(
      OAUTH_USAGE_URL,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${creds.accessToken}`,
          'anthropic-beta': OAUTH_BETA,
          Accept: 'application/json',
        },
        timeout: 10_000,
      },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += c))
        res.on('end', () => {
          if ((res.statusCode ?? 0) >= 400) {
            reject(new Error(`usage endpoint ${String(res.statusCode)}`))
            return
          }
          try {
            resolve(JSON.parse(data))
          } catch {
            reject(new Error('usage endpoint returned non-JSON'))
          }
        })
      },
    )
    req.on('timeout', () => req.destroy(new Error('usage endpoint timeout')))
    req.on('error', reject)
    req.end()
  })
  const doc = (body ?? {}) as Record<string, unknown>
  // `limits[]` is the authoritative list and the ONLY place the premium window appears: on this
  // account `seven_day_opus` comes back null while limits carries
  // `{kind:'weekly_scoped', percent:74, scope:{model:{display_name:'Fable'}}}`. The label is read
  // from the response, never hardcoded — it is a model name Anthropic can change.
  const fromLimits = parseLimitsArray(doc.limits)
  if (fromLimits) return fromLimits
  // Older/leaner responses: the same window names as the statusLine payload, at the top level or
  // under `rate_limits`. Accept both rather than betting on one shape.
  const parsed = parseClaudePayload(doc.rate_limits ? doc : { rate_limits: doc })
  return parsed ? { ...parsed, source: 'api' } : null
}

/** Map the endpoint's `limits[]` entries onto our windows. Returns null when it carries none. */
function parseLimitsArray(raw: unknown): ProviderUsage | null {
  if (!Array.isArray(raw)) return null
  let session: UsageWindow | null = null
  let weekly: UsageWindow | null = null
  let premiumWeekly: UsageWindow | null = null
  let premiumLabel: string | undefined
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const entry = item as { kind?: unknown; percent?: unknown; resets_at?: unknown; scope?: unknown }
    const percent = typeof entry.percent === 'number' ? entry.percent : NaN
    if (!Number.isFinite(percent)) continue
    const kind = String(entry.kind ?? '')
    const windowMinutes = kind === 'session' ? 300 : 10080
    const w: UsageWindow = {
      usedPercent: Math.min(100, Math.max(0, percent)),
      windowMinutes,
      resetsAt: parseResetsAt(entry.resets_at),
    }
    if (kind === 'session') session = w
    else if (kind === 'weekly_all') weekly = w
    else if (kind === 'weekly_scoped') {
      premiumWeekly = w
      const model = (entry.scope as { model?: { display_name?: unknown } } | undefined)?.model?.display_name
      premiumLabel = typeof model === 'string' && model ? model : 'scoped'
    }
  }
  if (!session && !weekly && !premiumWeekly) return null
  return {
    provider: 'claude',
    status: 'ok',
    session,
    weekly,
    premiumWeekly,
    premiumLabel,
    monthly: null,
    source: 'api',
    updatedAt: Date.now(),
  }
}

/** The daemon calls this when a POST /usage/claude lands (loopback, hook-originated). */
export function postClaudePayload(raw: unknown): ProviderUsage | null {
  const parsed = parseClaudePayload(raw)
  if (parsed) lastPost = parsed
  return parsed
}

/** Adapter contract: the collector asks each provider for its live state. */
export async function read(): Promise<ProviderUsage | null> {
  return lastPost
}

/** Whether the claude provider should exist at all on this machine (credential gate). */
export function credentialsPresent(): boolean {
  return claudeCredentialsPresent()
}
