/**
 * Publish a PLANO release to the PUBLIC auto-update repo (zqkra/plano-releases).
 *
 * Every installed build checks this repo for `latest.yml` (Windows) / `latest-mac.yml` (macOS)
 * via electron-updater — no tokens needed on clients because the repo is public. Run this after
 * `npm run dist:win` (or use `npm run release:win` which builds then publishes). The git tag
 * MUST be `v<version>` from package.json (electron-updater resolves the latest release by tag).
 *
 * Usage:
 *   npm run release:win                        # build Windows installer + publish
 *   node scripts/publish-release.mjs           # publish whatever is already in release/
 *   node scripts/publish-release.mjs --platform mac   # publish mac artifacts (dmg + zip + latest-mac.yml)
 *   node scripts/publish-release.mjs --replace        # delete an existing vX release first (re-publish)
 *
 * Requires the GitHub CLI (`gh`) to be installed and authenticated.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, basename } from 'node:path'

const REPO = 'zqkra/plano-releases'
const ROOT = join(import.meta.dirname, '..')
const RELEASE_DIR = join(ROOT, 'release')

const args = process.argv.slice(2)
const platform = args.includes('--platform') ? args[args.indexOf('--platform') + 1] ?? 'win' : 'win'
const replace = args.includes('--replace')
const skipBuild = args.includes('--skip-build')

function fail(message) {
  console.error(`\n✖ ${message}`)
  process.exit(1)
}

function run(cmd, cmdArgs, opts = {}) {
  const res = spawnSync(cmd, cmdArgs, { stdio: 'inherit', ...opts })
  if (res.status !== 0) fail(`${cmd} ${cmdArgs.join(' ')} failed (exit ${res.status ?? 'signal'}).`)
  return res
}

// ── 0. prerequisites ────────────────────────────────────────────────────────────────────────────
try {
  execFileSync('gh', ['--version'], { stdio: 'ignore' })
} catch {
  fail('GitHub CLI (`gh`) not found on PATH. Install it and run `gh auth login` first.')
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const version = pkg.version
if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`Unrecognized version "${version}" in package.json.`)
const tag = `v${version}`

// ── 1. build (unless publishing existing artifacts) ─────────────────────────────────────────────
if (!skipBuild) {
  console.log(`\n› Building ${platform} artifacts…`)
  if (platform === 'win') run('npm', ['run', 'dist:win'], { cwd: ROOT })
  else if (platform === 'mac') run('npm', ['run', 'dist:mac'], { cwd: ROOT })
  else fail(`Unknown --platform "${platform}" (win | mac).`)
}

// ── 2. collect artifacts ────────────────────────────────────────────────────────────────────────
if (!existsSync(RELEASE_DIR)) fail(`No ${RELEASE_DIR}/ directory — run the build first.`)
const files = readdirSync(RELEASE_DIR).filter((f) => existsSync(join(RELEASE_DIR, f)))

const artifacts = []
if (platform === 'win') {
  for (const want of ['latest.yml', 'PLANO-Setup.exe', 'PLANO-Setup.exe.blockmap']) {
    if (!files.includes(want)) fail(`Missing ${want} in release/ — did the Windows build succeed?`)
    artifacts.push(join(RELEASE_DIR, want))
  }
  // Sanity: latest.yml must describe THIS version and a file we are actually uploading.
  const yml = readFileSync(join(RELEASE_DIR, 'latest.yml'), 'utf8')
  const ymlVersion = yml.match(/^version:\s*(.+)$/m)?.[1]?.trim()
  const ymlPath = yml.match(/^path:\s*(.+)$/m)?.[1]?.trim()
  if (ymlVersion !== version)
    fail(`latest.yml says version ${ymlVersion} but package.json says ${version}. Rebuild.`)
  if (!ymlPath || !files.includes(ymlPath))
    fail(`latest.yml points at "${ymlPath}" which is missing from release/. Rebuild.`)
} else if (platform === 'mac') {
  const dmg = files.filter((f) => f.endsWith('.dmg'))
  const zip = files.filter((f) => f.endsWith('.zip'))
  const ymlName = 'latest-mac.yml'
  if (!files.includes(ymlName)) fail(`Missing ${ymlName} in release/ — macOS build must include the zip target.`)
  if (dmg.length === 0 && zip.length === 0) fail('No .dmg or .zip artifacts found in release/.')
  artifacts.push(join(RELEASE_DIR, ymlName), ...dmg.map((f) => join(RELEASE_DIR, f)), ...zip.map((f) => join(RELEASE_DIR, f)))
} else {
  fail(`Unknown --platform "${platform}" (win | mac).`)
}

// ── 3. existing release? ────────────────────────────────────────────────────────────────────────
const view = spawnSync('gh', ['release', 'view', tag, '--repo', REPO], { stdio: 'ignore' })
if (view.status === 0) {
  if (!replace) fail(`Release ${tag} already exists on ${REPO}. Bump the version or pass --replace to delete and re-publish.`)
  console.log(`\n› Replacing existing release ${tag}…`)
  run('gh', ['release', 'delete', tag, '--repo', REPO, '--yes', '--cleanup-tag'], { cwd: ROOT })
}

// ── 4. release notes from the source repo since the last tag ────────────────────────────────────
let notes = ''
try {
  const prev = execFileSync('git', ['describe', '--tags', '--abbrev=0', 'HEAD~1'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
  const log = execFileSync(
    'git',
    ['log', '--oneline', '--no-merges', `${prev}..HEAD`],
    { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  ).trim()
  if (log) notes = `## Changes since ${prev}\n\n${log}\n`
} catch {
  notes = `PLANO ${version} — see the source repo for changes.`
}

// ── 5. create the release ───────────────────────────────────────────────────────────────────────
console.log(`\n› Publishing ${tag} → ${REPO} (${artifacts.map((a) => basename(a)).join(', ')})`)
run(
  'gh',
  ['release', 'create', tag, '--repo', REPO, '--title', `PLANO ${version}`, '--notes', notes, ...artifacts],
  { cwd: ROOT },
)

console.log(`\n✔ ${tag} published. Installed PLANO builds will pick it up on their next check (≤ 4h) or immediately on restart.`)
