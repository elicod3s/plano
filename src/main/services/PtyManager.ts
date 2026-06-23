/**
 * PtyManager — owns every node-pty process and bridges it to the renderer.
 *
 * For each terminal it: spawns a ConPTY/PTY shell, streams output to the renderer AND
 * to AgentDetectionService (same bytes), forwards keystrokes/resizes, and tree-kills
 * cleanly on close. It is the source of each shell's PID (the root for agent detection).
 */

import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { IPty } from 'node-pty'
import { CH } from '@shared/ipc/channels'
import type {
  TerminalCreateRequest,
  TerminalCreateResult,
  TerminalAttachResult,
  TerminalProcessInfo,
} from '@shared/ipc/contracts'
import type { AgentDetectionService } from './AgentDetectionService'
import type { AgentSessionService } from './AgentSessionService'
import type { TerminalHistoryService } from './TerminalHistoryService'
import type { DevUrlService } from './DevUrlService'

type Post = (channel: string, payload: unknown) => void

interface PtyDeps {
  post: Post
  detection: AgentDetectionService
  history: TerminalHistoryService
  devUrls: DevUrlService
  agentSession: AgentSessionService
}

interface PtyEntry {
  pty: IPty
  panelId: string
  shellName: string
  /**
   * Whether a renderer panel is currently mounted on this PTY. A terminal whose panel lives
   * in another workspace ("space") is DETACHED: its shell keeps running, output is buffered,
   * but nothing is streamed to the renderer until the panel remounts and reattaches.
   */
  attached: boolean
  /** Set once the shell process exits; the entry lingers (with its buffer) until kill(). */
  exited: boolean
  exitCode?: number
  exitSignal?: number
  /** Bounded ring buffer of recent raw output, replayed on reattach (chunks + total length). */
  buffer: string[]
  bufferLen: number
}

// Recent output kept per terminal so a panel returning from another space can replay it.
// Generous enough to reconstruct an agent's scrollback; bounded so background terminals
// can't grow without limit. Trimmed whole-chunk from the front on overflow.
const REPLAY_BUFFER_MAX = 2_000_000

function defaultShell(): string {
  if (process.platform === 'win32') return process.env.PLANO_SHELL || 'powershell.exe'
  return process.env.SHELL || '/bin/bash'
}

/**
 * Markers that identify a real project root. Presence of ANY one means "this folder is the thing
 * the user came to work on", so a terminal should start here and `npm`/`git`/etc. resolve to it.
 * Kept broad across ecosystems; each is checked as a direct child of the folder.
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

/**
 * Folder names that are clearly NOT the live project — backups, archives, copies, dated dumps.
 * Skipped when auto-locating the project inside a container folder so a terminal never lands in
 * someone's `…-BACKUP-2026…` / `__OLD__` copy. Matched case-insensitively.
 */
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
 * Locate the project root to open a terminal in, given the workspace folder. The common case —
 * the workspace folder IS the project (it has a package.json/.git/…) — returns it unchanged. The
 * case this fixes: the user opened a *container* folder (e.g. `…\Click-Sync (working)\`, full of
 * backups + zips) whose actual code lives one level down (`…\Click-Sync\`). Then `npm`/`git` typed
 * at the workspace root fail with "no package.json here". So when the root has no project marker we
 * look one level down for a single, unambiguous subproject and start there instead.
 *
 * Conservative by design: descends only ONE level, ignores backup/archive/copy folders, and when
 * several real subprojects exist only descends if exactly one shares the container's name —
 * otherwise it stays at the workspace folder rather than guess wrong. Never throws.
 */
function findProjectRoot(dir: string): string {
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

    // Several real subprojects — only descend if exactly one is named like the container folder.
    const named = candidates.filter((name) => namesRelated(basename(dir), name))
    return named.length === 1 ? join(dir, named[0]) : dir
  } catch {
    return dir
  }
}

/**
 * Resolve the directory a new shell starts in. A terminal carries the open workspace/folder
 * path when there is one; otherwise we default to the user's HOME — exactly where a fresh
 * Windows terminal (or Warp) opens — so per-directory tools run inside it (notably
 * `claude --resume`) see the SAME session history as a normal terminal.
 *
 * When `autoDetectRoot` is set (a plain terminal opened on the workspace folder — NOT one a user
 * explicitly rooted at a folder they picked in the Files panel) we refine that folder to the
 * actual project root inside it via findProjectRoot, so `npm`/`git`/etc. just work with no manual
 * `cd` even when the opened folder is a container holding the real project in a subfolder.
 *
 * We deliberately NEVER fall back to the Electron process cwd: in the packaged app that is
 * PLANO's install folder (…\Programs\PLANO), which silently made `/resume` list a different,
 * empty "project". A requested path that no longer exists also falls back to HOME so a stale
 * folder reference can't stop a terminal from spawning.
 */
function resolveCwd(requested?: string, autoDetectRoot = false): string {
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

/**
 * Startup script injected into PowerShell-family shells to deliver the Warp-style inline
 * predictive history (`predictiveHistory` setting). It enables PSReadLine's history
 * predictor (inline ghost text), rebinds Tab to "accept the suggestion, else complete", and
 * registers an OnIdle drain that lets PLANO inject remembered commands (e.g. an AI CLI's
 * `claude --resume <id>`, captured by TerminalHistoryService) into the LIVE session's history
 * with no echo — so they're predicted in the very terminal they appeared in.
 *
 * Each step is wrapped on its own so a non-VT console (which rejects PredictionViewStyle)
 * still gets the rest. PSReadLine ≥ 2.1 is required for prediction; on 5.1's bundled 2.0.0
 * we force-load a newer side-by-side copy before the first prompt (the proven $PROFILE
 * trick). History persistence works on every version, so this only ever adds capability.
 */
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
  // OnIdle drain: while at an idle prompt, fold any commands PLANO captured (keyed to this
  // shell's PID) into the in-memory history so they're predicted immediately, without echo.
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

/**
 * Force UTF-8 on a PowerShell-family shell: console I/O, the pipeline to native programs, AND the
 * DEFAULT file encoding for Set-Content / Out-File / Add-Content / `>`. Windows PowerShell 5.1
 * otherwise falls back to the legacy OEM/ANSI code page, which turns accents and emoji into
 * mojibake whenever a tool writes or round-trips a UTF-8 file — e.g. `Set-Content` mangled
 * "número café 🚀" into "n�mero caf� ??". This is applied to EVERY PowerShell terminal (not just
 * when predictive history is on), since correct encoding is fundamental, not optional.
 *
 * Each line is wrapped on its own so one rejection (e.g. a host that refuses to set InputEncoding)
 * can't skip the rest. The `$false` constructor arg selects UTF-8 WITHOUT a BOM.
 */
const PS_UTF8_INIT = [
  `try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch {}`,
  `try { [Console]::InputEncoding  = New-Object System.Text.UTF8Encoding $false } catch {}`,
  `try { $OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch {}`,
  `try { $PSDefaultParameterValues['*:Encoding'] = 'utf8' } catch {}`,
].join('\n')

/**
 * Make a PowerShell shell report its working directory on every prompt via OSC 7
 * (`ESC ] 7 ; file:///<path> BEL`) — the same mechanism Windows Terminal / iTerm use. PLANO's
 * xterm consumes the sequence (it's never displayed) and updates that terminal's git badge, so the
 * badge follows a live `cd` between repos. We WRAP the existing prompt (saving and calling the
 * original) instead of replacing it, so a user's custom prompt (posh-git, Starship, …) is kept; the
 * OSC is written as a side effect BEFORE the prompt string, so it can't affect PSReadLine's width
 * math. Guarded against double-wrapping, and every step is in try/catch so it can never break a shell.
 */
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
function encodePwshCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

/**
 * Extra spawn args for the resolved shell. PowerShell/pwsh ALWAYS gets the UTF-8 startup script
 * (PS_UTF8_INIT) so file + console encoding is correct; when predictive history is on we append
 * the PSReadLine prediction setup (PS_PREDICTIVE_INIT) too. Both run via -EncodedCommand (so
 * quoting can't bite) and we keep the session interactive with -NoExit. Other shells handle UTF-8
 * and history natively → no args.
 */
function buildShellArgs(shell: string, predictiveHistory: boolean): string[] {
  const base = (shell.split(/[\\/]/).pop() || shell).toLowerCase().replace(/\.exe$/, '')
  if (base === 'powershell' || base === 'pwsh') {
    const core = predictiveHistory ? `${PS_UTF8_INIT}\n${PS_PREDICTIVE_INIT}` : PS_UTF8_INIT
    // OSC-7 cwd reporting is always on (independent of predictive history) so the git badge tracks `cd`.
    const script = `${core}\n${PS_OSC7_CWD_INIT}`
    return ['-NoLogo', '-NoExit', '-EncodedCommand', encodePwshCommand(script)]
  }
  return []
}

/**
 * Names (exact) injected by a launching process that must NOT leak into a fresh shell.
 * Compared case-insensitively (Windows env vars are case-insensitive).
 */
const ENV_STRIP_EXACT = new Set(['init_cwd', 'electron_run_as_node', 'claudecode', 'claude_effort'])
/**
 * Name PREFIXES injected by a launcher that must NOT leak into a fresh shell.
 * - `npm_`     → npm's run-context (npm_config_*, npm_lifecycle_*, npm_package_*, npm_execpath …)
 * - `claude_code_` → an AI CLI's child-session identity (CLAUDE_CODE_CHILD_SESSION, _SESSION_ID …)
 * - `vscode_`  → "launched from VS Code" markers
 */
const ENV_STRIP_PREFIX = ['npm_', 'claude_code_', 'vscode_']

/**
 * Build the environment for a spawned shell.
 *
 * PLANO is very often started via `npm run dev` and/or from inside another tool's session
 * (an AI coding CLI, VS Code, …). Node/npm and those launchers inject a pile of context vars
 * into OUR process — and a naive copy of `process.env` would leak ALL of them into every
 * terminal we spawn, making the shell behave like it's still running inside that launcher
 * instead of being a fresh, normal terminal. This has concretely bitten us:
 *   - npm's run-context (`npm_config_local_prefix`, `npm_lifecycle_*`, `INIT_CWD`, …) made an
 *     `npm install` typed in a PLANO terminal target PLANO's project / a stale prefix instead
 *     of the folder the user is actually in — so it appeared to "do nothing".
 *   - An AI CLI's child-session markers (CLAUDECODE / CLAUDE_CODE_*) made an agent launched
 *     INSIDE a PLANO terminal believe it was a nested/sandboxed child session, so it refused
 *     network + file operations.
 *
 * So we strip the known launcher/run-context pollution. Everything else (PATH, user config,
 * auth tokens, etc.) is preserved, so the terminal behaves exactly like one the user opens
 * from their desktop. node-pty also wants a string→string env with no undefined values.
 */
function cleanEnv(): Record<string, string> {
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

  // Windows: refresh PATH from the registry so a terminal sees CLIs installed AFTER PLANO launched
  // (see liveWindowsPath). Overwrite whichever case-variant key already holds PATH so we never end
  // up with both `Path` and `PATH`. A failed/empty read leaves the inherited PATH untouched.
  if (process.platform === 'win32') {
    let pathKey = 'Path'
    let current = ''
    for (const k of Object.keys(out)) {
      if (k.toLowerCase() === 'path') {
        pathKey = k
        current = out[k]
        break
      }
    }
    const live = liveWindowsPath(current)
    if (live) out[pathKey] = live
  }

  return out
}

/**
 * Read a registry string value (REG_SZ / REG_EXPAND_SZ) via `reg query`. Returns '' if the value
 * is absent or `reg` fails — callers must treat '' as "unknown", never as "empty PATH". Synchronous
 * by design: it runs once per terminal spawn (a discrete user action), and `reg.exe` is a fast
 * native query, so the brief block is imperceptible and keeps the env build straight-line.
 */
function readRegValue(root: string, name: string): string {
  try {
    const out = execFileSync('reg', ['query', root, '/v', name], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 4000,
    })
    // `reg` prints: "    <name>    REG_EXPAND_SZ    <value>" — the value may contain spaces and ';',
    // so anchor on the type token and take the rest of that line.
    const m = out.match(/REG_(EXPAND_)?SZ\s+(.*)$/m)
    if (!m) return ''
    const value = m[2].trim()
    // Only REG_EXPAND_SZ carries `%VAR%` references Windows expands; a plain REG_SZ is literal
    // (so a path that legitimately contains a `%…%` pair isn't mangled).
    return m[1] ? expandWinVars(value) : value
  } catch {
    return ''
  }
}

/** Expand `%VAR%` references against the current process env (lookups are case-insensitive on Windows). */
function expandWinVars(value: string): string {
  return value.replace(/%([^%]+)%/g, (whole, name: string) => {
    const v = process.env[name]
    return typeof v === 'string' ? v : whole
  })
}

/**
 * The PATH a freshly-opened Windows terminal would have: Machine PATH followed by User PATH, read
 * LIVE from the registry (HKLM/HKCU Environment) and expanded. PLANO's own `process.env.PATH` is
 * captured at launch and goes stale — when the user installs a CLI (Kiro, etc.) its installer
 * appends to the registry PATH and broadcasts WM_SETTINGCHANGE, but our long-running process never
 * sees it, so the CLI "is not recognized" in a PLANO terminal even though a NEW OS terminal finds
 * it. Re-reading the registry per spawn makes a new PLANO terminal behave like a new OS terminal.
 *
 * Merge order: the live registry PATH first (matching real launch order), then any entry still in
 * our process PATH that isn't already present (appended). So we ADD newly-installed locations
 * without ever LOSING one that already resolved (e.g. a path a launcher injected only into our
 * process). Returns '' if BOTH registry reads fail → the caller keeps the inherited PATH untouched,
 * so a terminal that worked before never breaks.
 */
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
      // Dedupe case-insensitively, ignoring a trailing slash, so the same dir isn't listed twice.
      const key = entry.toLowerCase().replace(/[\\/]+$/, '')
      if (seen.has(key)) continue
      seen.add(key)
      parts.push(entry)
    }
  }
  return parts.join(';')
}

/**
 * node-pty is a native module that must be built against Electron's ABI. We load it
 * lazily and tolerate failure so the whole app still launches if it hasn't been built
 * yet (e.g. `npm run rebuild` not run / no C++ build tools) — terminals then show guidance
 * instead of crashing the main process.
 */
type PtyModule = typeof import('node-pty')
let ptyModule: PtyModule | null = null
let ptyLoadError: string | null = null

function loadPty(): PtyModule | null {
  if (ptyModule) return ptyModule
  if (ptyLoadError) return null
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ptyModule = require('node-pty') as PtyModule
    return ptyModule
  } catch (err) {
    ptyLoadError = err instanceof Error ? err.message : String(err)
    return null
  }
}

const PTY_UNAVAILABLE_MESSAGE =
  '\r\n\x1b[2m  PLANO — the terminal engine (node-pty) is not built for Electron yet.\r\n' +
  '  Run \x1b[0m\x1b[1mnpm run rebuild\x1b[0m\x1b[2m (requires the Visual Studio "Desktop development with C++" workload),\r\n' +
  '  then reopen this terminal.\x1b[0m\r\n'

/**
 * Spawn a PTY, swallowing the failure modes that must NOT crash the IPC handler: a missing or
 * mistyped shell executable (e.g. a Shell setting of `pwsh`/`bash` on a machine without it, or a
 * bad explicit shell path), and node-pty's known ConPTY `AttachConsole failed` throw on Windows
 * (see CLAUDE.md). Returns the live IPty on success or the Error on failure, so the caller can fall
 * back to the platform default and surface a readable message instead of rejecting the call.
 */
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

/** Notice streamed when a requested shell can't launch but the default could (we swapped it in). */
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

/** Message streamed when no shell at all could be launched (the terminal then reports exit). */
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

export class PtyManager {
  private readonly entries = new Map<string, PtyEntry>()

  constructor(private readonly deps: PtyDeps) {}

  create(req: TerminalCreateRequest): TerminalCreateResult {
    const shell = req.shell || defaultShell()
    const shellName = (shell.split(/[\\/]/).pop() || shell).replace(/\.exe$/i, '')
    const ptyId = randomUUID()

    const mod = loadPty()
    if (!mod) {
      // Degrade gracefully: stream a guidance message, then report exit.
      queueMicrotask(() => {
        this.deps.post(CH.terminalData, { ptyId, data: PTY_UNAVAILABLE_MESSAGE })
        this.deps.post(CH.terminalExit, { ptyId, exitCode: 1 })
      })
      return { ptyId, pid: -1, shellName: 'unavailable', cwd: '' }
    }

    const cwd = resolveCwd(req.cwd, req.autoDetectRoot)
    const predictive = req.predictiveHistory ?? true
    const spawnOpts = {
      name: 'xterm-256color',
      cols: Math.max(2, req.cols || 80),
      rows: Math.max(1, req.rows || 24),
      cwd,
      env: cleanEnv(),
      // ConPTY on Windows 10 1809+; node-pty falls back automatically if unavailable.
      useConpty: process.platform === 'win32',
    }

    let usedShellName = shellName
    let fallbackNotice = ''
    let spawned = safeSpawn(mod, shell, buildShellArgs(shell, predictive), spawnOpts)

    // A requested shell that can't launch (missing pwsh, a bad explicit shell path, …) must not
    // kill the terminal: retry once with the platform default so the user still gets a working
    // shell, with a one-line note explaining the swap.
    if (spawned instanceof Error) {
      const fallback = defaultShell()
      if (fallback.toLowerCase() !== shell.toLowerCase()) {
        const retry = safeSpawn(mod, fallback, buildShellArgs(fallback, predictive), spawnOpts)
        if (!(retry instanceof Error)) {
          fallbackNotice = shellFellBackMessage(shell, fallback, spawned.message)
          usedShellName = (fallback.split(/[\\/]/).pop() || fallback).replace(/\.exe$/i, '')
          spawned = retry
        }
      }
    }

    // Nothing launched (the default shell failed too, or it WAS the requested one): degrade like the
    // node-pty-missing path — stream a clear message and report exit instead of rejecting the IPC.
    if (spawned instanceof Error) {
      const message = shellFailedMessage(shell, spawned.message)
      queueMicrotask(() => {
        this.deps.post(CH.terminalData, { ptyId, data: message })
        this.deps.post(CH.terminalExit, { ptyId, exitCode: 1 })
      })
      return { ptyId, pid: -1, shellName: 'unavailable', cwd }
    }

    const pty = spawned
    const entry: PtyEntry = {
      pty,
      panelId: req.panelId,
      shellName: usedShellName,
      attached: true,
      exited: false,
      buffer: [],
      bufferLen: 0,
    }
    this.entries.set(ptyId, entry)

    // Surface the fallback note first (buffered too, so a reattach from another space still shows it).
    if (fallbackNotice) {
      this.appendBuffer(entry, fallbackNotice)
      this.deps.post(CH.terminalData, { ptyId, data: fallbackNotice })
    }

    // Agent detection roots at this shell's PID; emit verdicts only on change. The renderer keeps the
    // xterm instance alive in its registry across space/tab switches and never detaches there, so
    // `attached` stays true for the session's life and verdicts stream continuously (the panel in any
    // space stays correctly morphed). The `attached` gate only closes during a dev HMR reload window.
    this.deps.detection.register(ptyId, pty.pid, (verdict) => {
      if (entry.attached) this.deps.post(CH.agentSignal, { ptyId, verdict })
    })

    // Track the agent CLI's resumable conversation under this shell, for workspace-reopen restore.
    this.deps.agentSession.register(ptyId, pty.pid)

    // Remember "resume" commands an AI CLI prints on exit (gated by the same setting).
    this.deps.history.register(ptyId, usedShellName, pty.pid, predictive)

    // Watch output for a local dev-server URL → renderer opens it inside PLANO (only when the
    // terminal is on-screen; we don't auto-open browsers for background-space terminals).
    this.deps.devUrls.register(ptyId, (url) => {
      if (entry.attached) this.deps.post(CH.terminalUrlDetected, { ptyId, panelId: entry.panelId, url })
    })

    pty.onData((data) => {
      // Always buffer + feed detection so an agent keeps being tracked. The renderer Terminal
      // persists across space/tab switches (off-screen but live), so `attached` is normally true and
      // output streams to it continuously — keeping it a perfect mirror, so a return is a pure DOM
      // re-parent with no replay. The buffer is consumed only on a dev HMR reload (renderer registry
      // reset while the PTY survived) via attach().
      this.appendBuffer(entry, data)
      if (entry.attached) this.deps.post(CH.terminalData, { ptyId, data })
      this.deps.detection.feed(ptyId, data)
      this.deps.history.feed(ptyId, data)
      this.deps.devUrls.feed(ptyId, data)
    })

    pty.onExit(({ exitCode, signal }) => {
      entry.exited = true
      entry.exitCode = exitCode
      entry.exitSignal = signal
      if (entry.attached) this.deps.post(CH.terminalExit, { ptyId, exitCode, signal })
      // The live process is gone, so stop tracking it — but KEEP the entry (with its replay
      // buffer + exited flag) so a panel returning from another space still sees the final
      // output and the "[process exited]" notice. The entry is cleared only by kill()/dispose.
      this.deps.detection.unregister(ptyId)
      this.deps.agentSession.unregister(ptyId)
      this.deps.history.unregister(ptyId)
      this.deps.devUrls.unregister(ptyId)
    })

    return { ptyId, pid: pty.pid, shellName: usedShellName, cwd }
  }

  /** Append output to the replay buffer, trimming whole chunks off the front past the cap. */
  private appendBuffer(entry: PtyEntry, data: string): void {
    entry.buffer.push(data)
    entry.bufferLen += data.length
    while (entry.bufferLen > REPLAY_BUFFER_MAX && entry.buffer.length > 1) {
      entry.bufferLen -= entry.buffer.shift()!.length
    }
  }

  /**
   * Re-bind to a PTY that kept running while the renderer-side xterm instance was gone. With the
   * renderer registry persisting the Terminal across space/tab switches, this is now reached ONLY on
   * a dev HMR reload — the renderer registry was reset while a PTY (and its store entry) survived, so
   * a brand-new Terminal needs main's buffered output replayed once to reconstruct the screen. Returns
   * the buffer (rather than posting it) so a StrictMode throwaway mount can discard it. Re-syncs the
   * current agent verdict.
   */
  attach(ptyId: string): TerminalAttachResult {
    const entry = this.entries.get(ptyId)
    if (!entry) return { ok: false, exited: true, buffer: '' }
    entry.attached = true
    // Verdict changes were suppressed while detached — push the current one so the panel morphs.
    this.deps.post(CH.agentSignal, { ptyId, verdict: this.deps.detection.currentVerdict(ptyId) })
    return { ok: true, exited: entry.exited, buffer: entry.buffer.join('') }
  }

  /** Stop streaming to the renderer while keeping the shell running. No longer called on a space/tab
   *  switch (the renderer keeps its Terminal attached and mirroring); retained for completeness and
   *  any future caller that genuinely wants main to buffer instead of stream. */
  detach(ptyId: string): void {
    const entry = this.entries.get(ptyId)
    if (entry) entry.attached = false
  }

  write(ptyId: string, data: string): void {
    const entry = this.entries.get(ptyId)
    if (!entry || entry.exited) return
    try {
      entry.pty.write(data)
    } catch {
      /* pty died between frames; ignore */
    }
  }

  resize(ptyId: string, cols: number, rows: number): void {
    const entry = this.entries.get(ptyId)
    if (!entry || entry.exited) return
    try {
      entry.pty.resize(Math.max(2, cols), Math.max(1, rows))
      this.deps.detection.ping(ptyId)
    } catch {
      /* resize can throw if the pty died between frames; ignore */
    }
  }

  ping(ptyId: string): void {
    this.deps.detection.ping(ptyId)
  }

  /**
   * The AI-agent CLI process(es) running in this terminal — delegated to agent detection so
   * it's matched with the same signatures (no raw OS process tree, no unrelated noise).
   */
  listProcesses(ptyId: string): Promise<TerminalProcessInfo[]> {
    if (!this.entries.has(ptyId)) return Promise.resolve([])
    return this.deps.detection.listAgentProcesses(ptyId)
  }

  kill(ptyId: string): { ok: boolean } {
    const entry = this.entries.get(ptyId)
    if (!entry) return { ok: false }
    try {
      entry.pty.kill()
    } catch {
      /* already gone */
    }
    this.deps.detection.unregister(ptyId)
    this.deps.agentSession.unregister(ptyId)
    this.deps.history.unregister(ptyId)
    this.deps.devUrls.unregister(ptyId)
    this.entries.delete(ptyId)
    return { ok: true }
  }

  disposeAll(): void {
    for (const id of [...this.entries.keys()]) this.kill(id)
    // Also tear down agent detection so its shared process-enumeration worker (a long-lived
    // powershell.exe on Windows) is killed rather than orphaned when the app quits.
    this.deps.detection.disposeAll()
  }
}
