/**
 * GitService — read-only git metadata for a folder (a terminal's cwd, the workspace root).
 *
 * Narrow and benign: it only ever READS by running `git` with an argument array (never a shell
 * string, so no injection) inside an existing directory. Every command is wrapped so a missing
 * git / non-repo / empty repo degrades to a clean "not a repo" result instead of throwing — the
 * callers (the terminal git badge, the close-terminal dialog) just show what they can.
 */

import { execFile } from 'node:child_process'
import { statSync } from 'node:fs'
import type { GitRemoteInfo, GitStatusRequest, GitStatusResult } from '@shared/ipc/contracts'

const NOT_A_REPO: GitStatusResult = {
  isRepo: false,
  branch: null,
  detached: false,
  dirty: false,
  ahead: 0,
  behind: 0,
  hasUpstream: false,
  added: 0,
  removed: 0,
  filesChanged: 0,
  remote: null,
}

function run(args: string[], cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['--no-optional-locks', ...args],
      { cwd, windowsHide: true, timeout: 4000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => resolve(err ? null : stdout),
    )
  })
}

function isExistingDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/**
 * Parse a git remote URL into a host/owner/repo identity we can label and open on the web.
 * Handles the three shapes git uses: `https://host/owner/repo(.git)`, scp-style
 * `git@host:owner/repo(.git)`, and `ssh://git@host/owner/repo(.git)`. Returns null for anything
 * that isn't a recognizable two-segment remote (e.g. a local path remote).
 */
function parseRemote(url: string | null): GitRemoteInfo | null {
  if (!url) return null
  const u = url.trim().replace(/\.git\/?$/i, '').replace(/\/+$/, '')
  if (!u) return null

  let host: string | undefined
  let path: string | undefined
  let m: RegExpMatchArray | null
  if ((m = u.match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i))) {
    host = m[1]
    path = m[2]
  } else if ((m = u.match(/^(?:[^@]+@)?([^/:]+):(.+)$/))) {
    host = m[1]
    path = m[2]
  }
  if (!host || !path) return null

  const parts = path.split('/').filter(Boolean)
  if (parts.length < 2) return null
  const owner = parts[parts.length - 2]
  const repo = parts[parts.length - 1]
  const h = host.toLowerCase()
  const isGitHub = h === 'github.com' || h.endsWith('.github.com')
  return { host: h, owner, repo, webUrl: `https://${h}/${owner}/${repo}`, isGitHub }
}

export class GitService {
  async status(req: GitStatusRequest): Promise<GitStatusResult> {
    const cwd = typeof req?.cwd === 'string' ? req.cwd.trim() : ''
    if (!cwd || !isExistingDir(cwd)) return NOT_A_REPO

    // One machine-readable call gives branch + upstream ahead/behind + dirtiness. A failure here
    // (not a repo, no git) returns null → treat the folder as not-a-repo.
    const porcelain = await run(['status', '--porcelain=v2', '--branch'], cwd)
    if (porcelain === null) return NOT_A_REPO

    let branch: string | null = null
    let detached = false
    let ahead = 0
    let behind = 0
    let hasUpstream = false
    let dirty = false
    let oid: string | null = null
    for (const line of porcelain.split(/\r?\n/)) {
      if (!line) continue
      if (line.startsWith('# branch.head ')) {
        const h = line.slice('# branch.head '.length).trim()
        if (h === '(detached)') detached = true
        else branch = h
      } else if (line.startsWith('# branch.oid ')) {
        const o = line.slice('# branch.oid '.length).trim()
        if (o && o !== '(initial)') oid = o.slice(0, 7)
      } else if (line.startsWith('# branch.ab ')) {
        const ab = line.slice('# branch.ab '.length).trim().match(/^\+(\d+)\s+-(\d+)$/)
        if (ab) {
          ahead = Number(ab[1])
          behind = Number(ab[2])
          hasUpstream = true
        }
      } else if (!line.startsWith('#')) {
        // Any non-header line is a changed / untracked / unmerged entry → working tree is dirty.
        dirty = true
      }
    }
    if (detached && !branch) branch = oid // show the short sha for a detached HEAD

    // `diff --numstat HEAD` covers staged + unstaged tracked changes vs the last commit (line
    // deltas the badge/close-dialog show). Empty repos (no HEAD) return null → stats stay 0.
    const numstat = await run(['diff', '--numstat', 'HEAD'], cwd)
    let added = 0
    let removed = 0
    let filesChanged = 0
    if (numstat) {
      for (const line of numstat.split(/\r?\n/)) {
        if (!line.trim()) continue
        const [a, d] = line.split('\t')
        filesChanged++
        // Binary files report "-\t-"; count the file but not its (unknowable) line delta.
        const ai = Number(a)
        const di = Number(d)
        if (Number.isFinite(ai)) added += ai
        if (Number.isFinite(di)) removed += di
      }
    }

    const remoteUrl = await run(['remote', 'get-url', 'origin'], cwd)
    const remote = parseRemote(remoteUrl)

    return { isRepo: true, branch, detached, dirty, ahead, behind, hasUpstream, added, removed, filesChanged, remote }
  }
}
