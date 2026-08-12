/**
 * ptySpawn — the shell-spawning core, shared by the main process client and the detached
 * Agent Host (daemon) that actually owns every PTY. Kept environment-agnostic (pure Node,
 * no Electron APIs) so the daemon — a plain `ELECTRON_RUN_AS_NODE` child — can bundle it.
 *
 * Everything here was historically inline in PtyManager. It owns: shell resolution (with the
 * container-folder project-root refinement), the PowerShell/pwsh startup scripts (UTF-8, OSC-7
 * cwd reporting, predictive history), the fast `cmd /k` agent-launch host, env sanitation (strip
 * npm/CLI-launcher pollution + refresh PATH from the registry), the tolerant node-pty loader
 * (missing native module / `AttachConsole failed` fallback chain), and the readable failure
 * notices streamed into a terminal when a shell can't launch.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { IPty } from 'node-pty'
import { agentToken, meshUrl } from './mesh/identity'

// ── shell resolution ─────────────────────────────────────────────────────────

export function defaultShell(): string {
  if (process.platform === 'win32') return process.env.PLANO_SHELL || 'powershell.exe'
  return process.env.SHELL || '/bin/bash'
}

/**
 * Markers that identify a real project root. Presence of ANY one means "this folder is the thing
 * the user came to work on", so a terminal should start here and `npm`/`git`/etc. resolve to it.
 */
const PROJECT_MARKERS = [
  'package.json',
  '.git',
  'pyproject.toml',
  'requirements.txt',
  'Pipfile',
  'Cargo.toml',
  'go.mod',
  'pom.xml',
  'build.gradle',
  'Gemfile',
  'composer.json',
  'CMakeLists.txt',
]

function hasProjectMarker(dir: string): boolean {
  return PROJECT_MARKERS.some((m) => existsSync(join(dir, m)))
}

/** Folder names that are clearly NOT the live project (backups, archives, copies, dated dumps). */
const NON_PROJECT_DIR =
  /(?:^|[-_ ])(?:backup|backups|bak|archive|archived|old|orig|copy|dump|snapshot)s?(?:[-_ ]|$)|__|\bv?\d{4}-\d{2}-\d{2}\b/i

/** Loose name comparison so a container like "Click-Sync (working)" matches its inner "Click-Sync". */
function namesRelated(a: string, b: string): boolean {
  const na = a.toLowerCase().replace(/[^a-z0-9]/g, '')
  const nb = b.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (na.length < 3 || nb.length < 3) return false
  return na === nb || na.startsWith(nb) || nb.startsWith(na)
}

/**
 * Locate the project root to open a terminal in, given the workspace folder. See the original
 * PtyManager docs: descends only ONE level, ignores backup/archive/copy folders, and when several
 * real subprojects exist only descends if exactly one shares the container's name. Never throws.
 */
export function findProjectRoot(dir: string): string {
  try {
    if (hasProjectMarker(dir)) return dir

    const subdirs = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((name) => !name.startsWith('.') && name !== 'node_modules')

    const candidates = subdirs.filter(
      (name) => !NON_PROJECT_DIR.test(name) && hasProjectMarker(join(dir, name)),
    )
    if (candidates.length === 0) return dir
    if (candidates.length === 1) return join(dir, candidates[0])

    const named = candidates.filter((name) => namesRelated(basename(dir), name))
    return named.length === 1 ? join(dir, named[0]) : dir
  } catch {
    return dir
  }
}

/**
 * Resolve the directory a new shell starts in. Same semantics as the original PtyManager:
 * a requested dir that still exists wins (refined to the project root when autoDetectRoot);
 * anything else falls back to HOME.
 */
export function resolveCwd(requested?: string, autoDetectRoot = false): string {
  if (requested) {
    try {
      if (statSync(requested).isDirectory()) {
        return autoDetectRoot ? findProjectRoot(requested) : requested
      }
    } catch {
      /* requested cwd vanished — fall through to home */
    }
  }
  return homedir()
}

// ── PowerShell startup scripts ───────────────────────────────────────────────

/** Predictive-history init (Warp-style) — see PtyManager's original doc comment. */
const PS_PREDICTIVE_INIT = [
  `try {`,
  `  $m = Get-Module PSReadLine`,
  `  if (-not $m -or $m.Version -lt [version]'2.1.0') {`,
  `    Remove-Module PSReadLine -Force -ErrorAction SilentlyContinue`,
  `    Import-Module PSReadLine -MinimumVersion 2.1.0 -ErrorAction Stop`,
  `  }`,
  `} catch {}`,
  `try { Set-PSReadLineOption -HistoryNoDuplicates -HistorySaveStyle SaveIncrementally -MaximumHistoryCount 8192 } catch {}`,
  `try { Set-PSReadLineOption -PredictionSource History -PredictionViewStyle InlineView } catch {}`,
  `try {`,
  `  Set-PSReadLineKeyHandler -Key Tab -BriefDescription 'PlanoAcceptOrComplete' -LongDescription 'Accept the inline history prediction, otherwise menu-complete' -ScriptBlock {`,
  `    param($key, $arg)`,
  `    $line = $null; $cur = $null`,
  `    [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$line, [ref]$cur)`,
  `    $before = $line`,
  `    [Microsoft.PowerShell.PSConsoleReadLine]::AcceptSuggestion($key, $arg)`,
  `    [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$line, [ref]$cur)`,
  `    if ($line -eq $before) { [Microsoft.PowerShell.PSConsoleReadLine]::MenuComplete($key, $arg) }`,
  `  }`,
  `} catch {}`,
  `try {`,
  `  $global:__planoPending = Join-Path $env:TEMP ('plano_pending_history_' + $PID + '.txt')`,
  `  Register-EngineEvent -SourceIdentifier PowerShell.OnIdle -Action {`,
  `    try {`,
  `      if (Test-Path $global:__planoPending) {`,
  `        $lines = Get-Content -LiteralPath $global:__planoPending -ErrorAction Stop`,
  `        Remove-Item -LiteralPath $global:__planoPending -Force -ErrorAction SilentlyContinue`,
  `        foreach ($l in $lines) { if ($l) { [Microsoft.PowerShell.PSConsoleReadLine]::AddToHistory($l) } }`,
  `      }`,
  `    } catch {}`,
  `  } | Out-Null`,
  `} catch {}`,
].join('\n')

/** Force UTF-8 on a PowerShell-family shell (file encodings + console I/O where safe). */
const PS_UTF8_INIT = [
  `try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch {}`,
  `try { [Console]::InputEncoding  = New-Object System.Text.UTF8Encoding $false } catch {}`,
  `try { $OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch {}`,
  `try { $PSDefaultParameterValues['*:Encoding'] = 'utf8' } catch {}`,
].join('\n')

/** UTF-8 init for ConPTY-backed shells (file encodings only — see PtyManager's notes). */
const PS_UTF8_INIT_CONPTY = [
  `try { $OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch {}`,
  `try { $PSDefaultParameterValues['*:Encoding'] = 'utf8' } catch {}`,
].join('\n')

/** OSC-7 cwd reporting wrapper for PowerShell — powers the live git badge. */
const PS_OSC7_CWD_INIT = [
  `try {`,
  `  if (-not $global:__planoCwdHook) {`,
  `    $global:__planoCwdHook = $true`,
  `    $global:__planoOrigPrompt = $function:prompt`,
  `    function global:prompt {`,
  `      try {`,
  `        $loc = $ExecutionContext.SessionState.Path.CurrentLocation`,
  `        if ($loc -and $loc.Provider.Name -eq 'FileSystem') {`,
  `          $u = $loc.ProviderPath -replace '\\\\','/'`,
  `          [Console]::Write([char]27 + ']7;file:///' + $u + [char]7)`,
  `        }`,
  `      } catch {}`,
  `      if ($global:__planoOrigPrompt) { & $global:__planoOrigPrompt } else { 'PS ' + $PWD.Path + '> ' }`,
  `    }`,
  `  }`,
  `} catch {}`,
].join('\n')

/** PowerShell reads -EncodedCommand as base64 of UTF-16LE — sidesteps all arg-quoting. */
export function encodePwshCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

function buildShellArgs(
  shell: string,
  predictiveHistory: boolean,
  bootCommand: string | undefined,
  useConpty: boolean,
): string[] {
  const base = (shell.split(/[\\/]/).pop() || shell).toLowerCase().replace(/\.exe$/, '')
  if (base === 'powershell' || base === 'pwsh') {
    const utf8Init = useConpty ? PS_UTF8_INIT_CONPTY : PS_UTF8_INIT
    const core = predictiveHistory ? `${utf8Init}\n${PS_PREDICTIVE_INIT}` : utf8Init
    const script = bootCommand
      ? `${core}\n${PS_OSC7_CWD_INIT}\n${bootCommand}`
      : `${core}\n${PS_OSC7_CWD_INIT}`
    return ['-NoLogo', '-NoExit', '-EncodedCommand', encodePwshCommand(script)]
  }
  return []
}

function shellTakesArgsScript(shell: string): boolean {
  const base = (shell.split(/[\\/]/).pop() || shell).toLowerCase().replace(/\.exe$/, '')
  return base === 'powershell' || base === 'pwsh'
}

// ── environment ──────────────────────────────────────────────────────────────

// NO_COLOR / FORCE_COLOR are stripped for the same reason TERM and COLORTERM are SET below: a
// PLANO terminal is always a color-capable TTY, and it must say so no matter what launched the
// app. `NO_COLOR` (no-color.org) disables color in every modern CLI on mere presence, so a PLANO
// started from a shell that had it exported rendered Claude Code — and everything else — flat
// white, while emoji kept their color (they are glyphs, not ANSI). Inheriting a launcher's
// color opt-out and then promising truecolor is a contradiction; the promise wins.
const ENV_STRIP_EXACT = new Set([
  'init_cwd',
  'electron_run_as_node',
  'claudecode',
  'claude_effort',
  'no_color',
  'force_color',
])
const ENV_STRIP_PREFIX = ['npm_', 'claude_code_', 'vscode_']

function readRegValue(root: string, name: string): string {
  try {
    const out = execFileSync('reg', ['query', root, '/v', name], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 4000,
    })
    const m = out.match(/REG_(EXPAND_)?SZ\s+(.*)$/m)
    if (!m) return ''
    const value = m[2].trim()
    return m[1] ? expandWinVars(value) : value
  } catch {
    return ''
  }
}

function expandWinVars(value: string): string {
  return value.replace(/%([^%]+)%/g, (whole, name: string) => {
    const v = process.env[name]
    return typeof v === 'string' ? v : whole
  })
}

function liveWindowsPath(processPath: string): string {
  const machine = readRegValue(
    'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
    'Path',
  )
  const user = readRegValue('HKCU\\Environment', 'Path')
  const registryPath = [machine, user].filter(Boolean).join(';')
  if (!registryPath) return ''

  const seen = new Set<string>()
  const parts: string[] = []
  for (const source of [registryPath, processPath]) {
    for (const raw of source.split(';')) {
      const entry = raw.trim()
      if (!entry) continue
      const key = entry.toLowerCase().replace(/[\\/]+$/, '')
      if (seen.has(key)) continue
      seen.add(key)
      parts.push(entry)
    }
  }
  return parts.join(';')
}

/**
 * Build the environment for a spawned shell: strip launcher/run-context pollution
 * (npm_*, CLAUDE_CODE_*, VS Code, …), set TERM/COLORTERM, and on Windows refresh PATH
 * from the registry so CLIs installed after launch are visible.
 *
 * When an identity is provided (plan F2) the mesh env vars are injected too: every agent
 * spawned inside PLANO knows WHO it is (stable ptyId), WHERE it is (workspace), how to reach
 * the mesh (fixed URL) and presents its own revocable token. Zero manual configuration.
 */
/** The daemon's resolved userData dir (argv `--userData`), used to put the CLI on agent PATHs. */
let userDataDir = ''

/** Called once at daemon boot, before any PTY is spawned. */
export function setUserDataDir(dir: string): void {
  userDataDir = dir || ''
}

export function cleanEnv(identity?: { ptyId: string; spaceId: string; token: string }): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value !== 'string') continue
    const lk = key.toLowerCase()
    if (ENV_STRIP_EXACT.has(lk)) continue
    if (ENV_STRIP_PREFIX.some((p) => lk.startsWith(p))) continue
    out[key] = value
  }
  out.TERM = 'xterm-256color'
  out.COLORTERM = 'truecolor'

  if (identity) {
    out.PLANO_AGENT_ID = identity.ptyId
    out.PLANO_MESH_URL = meshUrl()
    out.PLANO_MESH_TOKEN = identity.token
    out.PLANO_WORKSPACE = identity.spaceId
    out.PLANO_SESSION = 'plano'
  }

  // ONE canonical PATH key for everything below. Windows env vars are case-insensitive, but a
  // JS object is not: writing 'Path' while the inherited env spells it 'PATH' (what every
  // msys/git-bash-launched process gets) leaves TWO keys in the map and the child keeps only
  // one of them — which is how the injected CLI dir silently vanished from agent PATHs.
  const pathKey = Object.keys(out).find((k) => k.toLowerCase() === 'path') ?? (process.platform === 'win32' ? 'Path' : 'PATH')

  if (process.platform === 'win32') {
    const live = liveWindowsPath(out[pathKey] ?? '')
    if (live) out[pathKey] = live
  }

  // Plan F3.2: the mesh fallback CLI (`plano`) lives in <userData>/bin — put it on PATH so any
  // harness that can run commands can participate even without MCP support.
  // The daemon sets this via setUserDataDir(). It used to read PLANO_USER_DATA_DIR straight from
  // the environment, which the app never exports — it passes `--userData <path>` as an argv flag
  // — so in every real install the bin dir silently never made it onto any agent's PATH and
  // `plano` was "not found" for all of them. Only the e2e (which does export the var) saw it.
  const ud = userDataDir || process.env.PLANO_USER_DATA_DIR
  if (ud) {
    const binDir = join(ud, 'bin')
    const current = out[pathKey] ?? ''
    out[pathKey] = current ? `${binDir}${process.platform === 'win32' ? ';' : ':'}${current}` : binDir
  }

  return out
}

// ── node-pty loading (tolerant) ──────────────────────────────────────────────

type PtyModule = typeof import('node-pty')
let ptyModule: PtyModule | null = null
let ptyLoadError: string | null = null

/**
 * Load node-pty. The daemon passes the resolved module path via PLANO_PTY_PATH when it can't
 * resolve node-pty from its own location (packaged: the module lives in app.asar.unpacked and
 * require() from the asar resolves it automatically — but a plain require from a script inside
 * the asar still works, so this is mainly a dev/edge fallback). Returns null on failure.
 */
export function loadPty(ptyPath?: string): PtyModule | null {
  if (ptyModule) return ptyModule
  if (ptyLoadError) return null
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ptyModule = ptyPath
      ? (require(ptyPath) as PtyModule)
      : (require('node-pty') as PtyModule)
    return ptyModule
  } catch (err) {
    ptyLoadError = err instanceof Error ? err.message : String(err)
    return null
  }
}

/** Read the last node-pty load failure, for diagnostics. */
export function ptyLoadErrorMessage(): string | null {
  return ptyLoadError
}

export const PTY_UNAVAILABLE_MESSAGE =
  '\r\n\x1b[2m  PLANO — the terminal engine (node-pty) is not built for Electron yet.\r\n' +
  '  Run \x1b[0m\x1b[1mnpm run rebuild\x1b[0m\x1b[2m (requires the Visual Studio "Desktop development with C++" workload),\r\n' +
  '  then reopen this terminal.\x1b[0m\r\n'

/** Spawn a PTY, swallowing the failure modes that must NOT crash the caller. */
function safeSpawn(
  mod: PtyModule,
  shell: string,
  args: string[],
  opts: Parameters<PtyModule['spawn']>[2],
): IPty | Error {
  try {
    return mod.spawn(shell, args, opts)
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err))
  }
}

function shellFellBackMessage(requested: string, fallback: string, err: string): string {
  return (
    "\r\n\x1b[2m  PLANO — couldn't start \x1b[0m\x1b[1m" +
    requested +
    '\x1b[0m\x1b[2m (' +
    err +
    ').\r\n' +
    '  Using \x1b[0m\x1b[1m' +
    fallback +
    '\x1b[0m\x1b[2m instead — change it in Settings → Terminal → Shell.\x1b[0m\r\n'
  )
}

function shellFailedMessage(shell: string, err: string): string {
  return (
    "\r\n\x1b[2m  PLANO — couldn't start the shell \x1b[0m\x1b[1m" +
    shell +
    '\x1b[0m\x1b[2m.\r\n' +
    '  ' +
    err +
    '\r\n  Check Settings → Terminal → Shell / Shell path, then reopen this terminal.\x1b[0m\r\n'
  )
}

// ── the spawn itself ────────────────────────────────────────────────────────

export interface SpawnShellRequest {
  shell?: string
  cwd?: string
  cols: number
  rows: number
  /** Enable the shell's inline predictive-history engine (PowerShell). */
  predictiveHistory?: boolean
  /** One-shot command launched the instant the shell becomes interactive (e.g. `claude`). */
  bootCommand?: string
  /** When true (plain terminal on the workspace folder), cwd may be refined to the project root. */
  autoDetectRoot?: boolean
  /** Workspace the terminal belongs to — injected as PLANO_WORKSPACE (plan F2). */
  spaceId?: string
}

export interface SpawnShellResult {
  ok: true
  pty: IPty
  /** Shell executable actually used (after the fast-cmd / fallback swaps). */
  shellName: string
  /** Directory the shell actually started in (after project-root resolution). */
  cwd: string
  /** User-facing notice streamed before any shell output (fallback explanations). */
  notice?: string
  /** The exact ptyId this spawn belongs to — used only for error streaming by the caller. */
  forPtyId?: string
}

export interface SpawnShellFailure {
  ok: false
  /** The ptyId the failure is for (so the caller can stream the message to the right terminal). */
  ptyId: string
  /** Message to stream into the terminal (the shell could not be launched at all). */
  message: string
}

/**
 * Spawn a shell exactly like the old PtyManager.create did (fast `cmd /k` host for agent boots,
 * ConPTY with WinPTY fallback, shell fallback, encoded-command PowerShell startup), returning the
 * live IPty. On total failure returns a failure descriptor instead of throwing.
 */
export function spawnShell(
  req: SpawnShellRequest & { ptyId: string },
  ptyPath?: string,
): SpawnShellResult | SpawnShellFailure {
  const shell = req.shell || defaultShell()
  const mod = loadPty(ptyPath)
  if (!mod) {
    return { ok: false, ptyId: req.ptyId, message: PTY_UNAVAILABLE_MESSAGE }
  }

  const cwd = resolveCwd(req.cwd, req.autoDetectRoot)
  const boot = req.bootCommand?.trim() || undefined
  const predictive = boot ? false : (req.predictiveHistory ?? true)

  const psHost = /^(powershell|pwsh)$/i.test((shell.split(/[\\/]/).pop() || shell).replace(/\.exe$/i, ''))
  const fastCmd = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe')
  const fastBoot = !!boot && psHost && existsSync(fastCmd)
  const hostShell = fastBoot ? fastCmd : shell
  const useConpty = process.platform === 'win32' && process.env.PLANO_USE_WINPTY !== '1'
  const hostArgs = (s: string, conpty: boolean): string[] =>
    fastBoot && s === fastCmd
      ? ['/k', conpty ? boot : `chcp 65001>nul & ${boot}`]
      : buildShellArgs(s, predictive, boot, conpty)

  let usedShell = hostShell
  const spawnOpts = {
    name: 'xterm-256color',
    cols: Math.max(2, req.cols || 80),
    rows: Math.max(1, req.rows || 24),
    cwd,
    // Plan F2: every PTY gets its own mesh identity (stable ptyId, derived revocable token,
    // workspace context) so whatever harness runs inside can attribute itself on the bus.
    env: cleanEnv({
      ptyId: req.ptyId,
      spaceId: req.spaceId ?? '',
      token: agentToken(req.ptyId),
    }),
    useConpty,
  }

  let usedShellName = (hostShell.split(/[\\/]/).pop() || hostShell).replace(/\.exe$/i, '')
  let fallbackNotice = ''
  let spawned = safeSpawn(mod, hostShell, hostArgs(hostShell, useConpty), spawnOpts)

  if (useConpty && spawned instanceof Error) {
    const retryConpty = safeSpawn(mod, hostShell, hostArgs(hostShell, true), spawnOpts)
    if (!(retryConpty instanceof Error)) {
      spawned = retryConpty
    } else {
      const retryWinpty = safeSpawn(mod, hostShell, hostArgs(hostShell, false), { ...spawnOpts, useConpty: false })
      if (!(retryWinpty instanceof Error)) {
        fallbackNotice =
          "\r\n\x1b[2m  PLANO — ConPTY unavailable (" +
          spawned.message +
          '); fell back to the WinPTY backend for this terminal.' +
          '\r\n  Emoji/wide characters may not display; restart the terminal to retry.\x1b[0m\r\n'
        spawned = retryWinpty
      }
    }
  }

  if (spawned instanceof Error) {
    const fallback = defaultShell()
    if (fallback.toLowerCase() !== hostShell.toLowerCase()) {
      const retry = safeSpawn(mod, fallback, hostArgs(fallback, useConpty), spawnOpts)
      if (!(retry instanceof Error)) {
        fallbackNotice = shellFellBackMessage(hostShell, fallback, spawned.message)
        usedShellName = (fallback.split(/[\\/]/).pop() || fallback).replace(/\.exe$/i, '')
        usedShell = fallback
        spawned = retry
      }
    }
  }

  if (spawned instanceof Error) {
    return { ok: false, ptyId: req.ptyId, message: shellFailedMessage(shell, spawned.message) }
  }

  const result: SpawnShellResult = {
    ok: true,
    pty: spawned,
    shellName: usedShellName,
    cwd,
    forPtyId: req.ptyId,
  }
  if (fallbackNotice) result.notice = fallbackNotice

  // Shells that don't take a startup script via args (bash/zsh/cmd) get the boot command written
  // to stdin once the shell has had a moment to reach its first prompt.
  if (boot && !((fastBoot && usedShell === fastCmd) || shellTakesArgsScript(usedShell))) {
    setTimeout(() => {
      try {
        spawned.write(`${boot}\r`)
      } catch {
        /* shell may have exited */
      }
    }, 500)
  }

  return result
}
