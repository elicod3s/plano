/**
 * Open a harness the curated table has never heard of.
 *
 * AGENT_LAUNCH_COMMANDS (@shared/domain/agentLaunch) is a hand-kept list, so
 * `plano spawn <something-new>` used to die with "unknown harness" even when that agent's CLI
 * was sitting right there on the host. New coding-agent CLIs appear faster than the table is
 * updated, and the user should not have to wait for a PLANO release to open one.
 *
 * So: the table stays the source of truth for harnesses that need a *specific* invocation
 * (`kiro-cli chat`, `cursor-agent`), and anything else falls back to "is a program by that name
 * actually installed here?".
 *
 * SECURITY — this string is typed into a fresh shell, and over the mesh it can come from
 * another agent, so it is NOT a place to be relaxed:
 *   - the name must match SAFE_NAME: no spaces, no path separators, no quotes, and none of
 *     `& | ; $ > < \` ( )` — a spawn request can therefore never smuggle a second command;
 *   - we only ever return a name we resolved to a real executable file on this host, never
 *     the caller's string verbatim.
 */

import { accessSync, constants, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

/** A bare tool name: starts alphanumeric, then alphanumerics, dot, dash, underscore. */
const SAFE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i

/** On Windows a bare name resolves through PATHEXT; elsewhere the name is the file. */
function executableSuffixes(): string[] {
  if (process.platform !== 'win32') return ['']
  const pathext = process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD'
  return ['', ...pathext.split(';').filter(Boolean)]
}

function isExecutableFile(candidate: string): boolean {
  try {
    if (!statSync(candidate).isFile()) return false
    if (process.platform === 'win32') return true
    accessSync(candidate, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Per-user install locations that a freshly spawned PTY does not always inherit on its PATH —
 * Grok (`~/.grok/bin`), npm/bun/cargo globals, and the `%LOCALAPPDATA%\Programs\<name>` shape
 * Electron installers use. Cheap to probe, and it is the difference between "unknown harness"
 * and the agent opening.
 */
function extraDirs(name: string): string[] {
  const home = homedir()
  const local = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local')
  const roaming = process.env.APPDATA ?? join(home, 'AppData', 'Roaming')
  return [
    join(home, `.${name}`, 'bin'),
    join(home, `.${name}`),
    join(home, '.local', 'bin'),
    join(home, 'bin'),
    join(home, '.bun', 'bin'),
    join(home, '.cargo', 'bin'),
    join(local, 'Programs', name, 'bin'),
    join(local, 'Programs', name),
    join(local, name, 'bin'),
    join(local, name),
    join(roaming, 'npm'),
  ]
}

function findIn(dirs: string[], name: string): string | null {
  for (const dir of dirs) {
    if (!dir) continue
    for (const suffix of executableSuffixes()) {
      const candidate = join(dir, `${name}${suffix}`)
      if (isExecutableFile(candidate)) return candidate
    }
  }
  return null
}

/** A path is only safe to type into a shell unquoted when it has no spaces. */
function shellSafe(absolutePath: string): string {
  return /\s/.test(absolutePath) ? `"${absolutePath}"` : absolutePath
}

export interface HarnessProbe {
  /** The command to boot, or null when nothing by that name is installed. */
  command: string | null
  /** Where it came from — for the error message when it is null. */
  searched: string[]
}

/**
 * Probe the host for an agent CLI called `harness`. Returns the bare name when it is on PATH
 * (so the child resolves it the normal way) or an absolute path when it was only found in one
 * of the extra install dirs.
 */
export function probeHarnessOnHost(harness: string): HarnessProbe {
  const name = harness.trim().toLowerCase()
  const pathDirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  const extra = extraDirs(name)
  const searched = ['PATH', ...extra]

  if (!SAFE_NAME.test(name)) return { command: null, searched: ['(rejected: unsafe harness name)'] }

  if (findIn(pathDirs, name)) return { command: name, searched }

  const found = findIn(extra, name)
  return { command: found ? shellSafe(found) : null, searched }
}

/** Convenience wrapper: the command, or null. */
export function resolveHarnessOnHost(harness: string): string | null {
  return probeHarnessOnHost(harness).command
}
