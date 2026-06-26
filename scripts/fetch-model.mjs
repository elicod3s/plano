/**
 * fetch-model.mjs — download + stage the bundled voice model so the installer can ship it.
 *
 * PLANO's voice orchestrator runs NVIDIA Parakeet TDT 0.6B v3 (multilingual, int8) locally via
 * sherpa-onnx. The model is ~640 MB, so we don't commit it to git — instead this script fetches it
 * into `resources/models/parakeet/` (gitignored), and electron-builder's `extraResources` copies
 * that folder into the packaged app. Idempotent: it no-ops if the model is already staged.
 *
 * Runs automatically before `npm run dev` and `npm run dist`. Cross-platform: download is pure Node
 * (follows GitHub's redirects); extraction shells out to `tar` (bsdtar ships on Win10+/macOS/Linux
 * and handles .tar.bz2).
 */

import { createWriteStream, existsSync, mkdirSync, copyFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import https from 'node:https'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const MODELS_DIR = join(ROOT, 'resources', 'models')
const DEST = join(MODELS_DIR, 'parakeet')
const TMP = join(MODELS_DIR, '_dl')

const MODEL = 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8'
const URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${MODEL}.tar.bz2`
// Files the recognizer actually needs (we drop test_wavs etc. to keep the installer lean).
const KEEP = [/^encoder.*\.onnx$/i, /^decoder.*\.onnx$/i, /^joiner.*\.onnx$/i, /^tokens\.txt$/i]

function log(msg) {
  process.stdout.write(`[fetch-model] ${msg}\n`)
}

/** Already staged? (tokens.txt + at least one encoder onnx present) */
function isStaged() {
  if (!existsSync(join(DEST, 'tokens.txt'))) return false
  return readdirSync(DEST).some((f) => /^encoder.*\.onnx$/i.test(f))
}

function download(url, file, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 8) return reject(new Error('Too many redirects'))
    https
      .get(url, { headers: { 'User-Agent': 'plano-build', Accept: 'application/octet-stream' } }, (res) => {
        const { statusCode, headers } = res
        if (statusCode && statusCode >= 300 && statusCode < 400 && headers.location) {
          res.resume()
          return resolve(download(headers.location, file, redirects + 1))
        }
        if (statusCode !== 200) {
          res.resume()
          return reject(new Error(`HTTP ${statusCode} for ${url}`))
        }
        const total = Number(headers['content-length'] || 0)
        let got = 0
        let lastPct = -1
        const out = createWriteStream(file)
        res.on('data', (chunk) => {
          got += chunk.length
          if (total) {
            const pct = Math.floor((got / total) * 100)
            if (pct !== lastPct && pct % 5 === 0) {
              lastPct = pct
              log(`downloading ${MODEL}: ${pct}% (${(got / 1e6).toFixed(0)}/${(total / 1e6).toFixed(0)} MB)`)
            }
          }
        })
        res.pipe(out)
        out.on('finish', () => out.close(() => resolve()))
        out.on('error', reject)
      })
      .on('error', reject)
  })
}

async function main() {
  if (isStaged()) {
    log(`model already present at ${DEST} — skipping`)
    return
  }
  mkdirSync(MODELS_DIR, { recursive: true })
  mkdirSync(TMP, { recursive: true })

  const archiveName = `${MODEL}.tar.bz2`
  const archive = join(TMP, archiveName)
  // Reuse a previously-downloaded archive (the download is the slow part); re-fetch only if absent/tiny.
  if (existsSync(archive) && statSync(archive).size > 400e6) {
    log(`reusing cached archive (${(statSync(archive).size / 1e6).toFixed(0)} MB)`)
  } else {
    log(`fetching ${URL}`)
    await download(URL, archive)
    log(`downloaded ${(statSync(archive).size / 1e6).toFixed(0)} MB`)
  }
  log('extracting…')
  // Extract from inside TMP with a relative name: a "D:\…" path makes GNU tar treat the drive
  // letter as a remote host ("Cannot connect to D"). bsdtar auto-detects bzip2; -xf works everywhere.
  execFileSync('tar', ['-xf', archiveName], { cwd: TMP, stdio: 'inherit' })

  // The archive expands to a single top folder named after the model.
  const inner = join(TMP, MODEL)
  const srcDir = existsSync(inner) ? inner : TMP
  rmSync(DEST, { recursive: true, force: true })
  mkdirSync(DEST, { recursive: true })
  let copied = 0
  for (const name of readdirSync(srcDir)) {
    if (KEEP.some((re) => re.test(name))) {
      copyFileSync(join(srcDir, name), join(DEST, name))
      copied++
    }
  }
  rmSync(TMP, { recursive: true, force: true })
  if (copied < 4 || !isStaged()) {
    throw new Error(`Staging failed — expected encoder/decoder/joiner/tokens, copied ${copied} files`)
  }
  log(`staged ${copied} files into ${DEST}`)
}

main().catch((err) => {
  process.stderr.write(`[fetch-model] ERROR: ${err.message}\n`)
  process.exit(1)
})
