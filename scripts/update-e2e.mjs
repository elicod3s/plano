/**
 * End-to-end driver for the auto-update flow against an INSTALLED PLANO build.
 *
 * Launches PLANO.exe with Chromium remote debugging, then watches `window.plano.update.getState()`
 * over CDP: logs every phase transition and, with `--install`, triggers quitAndInstall once the
 * update is downloaded (proving the whole download → restart loop).
 *
 * Usage:
 *   node scripts/update-e2e.mjs --exe "<path to PLANO.exe>" [--port 9223] [--install]
 *                               [--timeout 300] [--expect-downloaded]
 */

import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import WebSocket from 'ws'

const args = process.argv.slice(2)
const exe = args[args.indexOf('--exe') + 1]
const port = Number(args[args.indexOf('--port') + 1] ?? 9223)
// Isolate userData so a test instance never fights the installed app's single-instance lock
// (userData-derived) or clobbers its settings. E.g. --user-data <tmpdir>.
const userData = args[args.indexOf('--user-data') + 1]
const install = args.includes('--install')
const expectDownloaded = args.includes('--expect-downloaded')
const screenshotPath = args[args.indexOf('--screenshot') + 1]
const timeoutSec = Number(args[args.indexOf('--timeout') + 1] ?? 300)

if (!exe) {
  console.error('usage: node scripts/update-e2e.mjs --exe <PLANO.exe> [--port N] [--install] [--timeout S]')
  process.exit(2)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── launch the installed app ────────────────────────────────────────────────────────────────────
console.log(`› launching ${exe}`)
const child = spawn(exe, [`--remote-debugging-port=${port}`], {
  detached: false,
  stdio: 'ignore',
  env: userData ? { ...process.env, PLANO_USER_DATA_DIR: userData } : process.env,
})
child.on('exit', (code) => {
  console.log(`app exited (code ${code})`)
})

// ── find the page target ────────────────────────────────────────────────────────────────────────
async function findPage() {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`).catch(() => null)
  if (!res || !res.ok) return null
  const targets = await res.json().catch(() => [])
  return targets.find((t) => t.type === 'page' && !t.url.startsWith('devtools://')) ?? null
}

const deadline = Date.now() + timeoutSec * 1000
let page
while (Date.now() < deadline) {
  page = await findPage()
  if (page) break
  await sleep(500)
}
if (!page) {
  console.error('✖ no CDP page target — did the app launch?')
  process.exit(1)
}
console.log(`› page: ${page.title ?? ''} (${page.url})`)

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  ws.once('open', resolve)
  ws.once('error', reject)
})

let msgId = 0
const pending = new Map()
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString())
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg)
    pending.delete(msg.id)
  }
})
function send(method, params = {}) {
  const id = ++msgId
  return new Promise((resolve) => {
    pending.set(id, resolve)
    ws.send(JSON.stringify({ id, method, params }))
  })
}
async function evaluate(expression) {
  const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  return res.result?.result?.value
}

// ── poll the updater state ──────────────────────────────────────────────────────────────────────
let last = ''
const startedAt = Date.now()
let installed = false
let screenshotTaken = false
while (Date.now() < deadline) {
  const state = await evaluate('window.plano.update ? window.plano.update.getState() : null').catch(() => null)
  if (state) {
    const key = `${state.phase}|${state.version ?? ''}|${state.percent ?? ''}`
    if (key !== last) {
      last = key
      console.log(`[+${((Date.now() - startedAt) / 1000).toFixed(1)}s] phase=${state.phase} version=${state.version ?? '-'} percent=${state.percent ?? '-'}${state.message ? ` message=${state.message}` : ''}`)
    }
    // Capture the banner on screen (once) — mid-download shows the progress bar; 'downloaded'
    // shows the Restart action. Wait a beat for React to paint, retry on empty frames.
    const bannerVisible =
      (state.phase === 'downloading' && (state.percent ?? 0) >= 15) || state.phase === 'downloaded'
    if (bannerVisible && screenshotPath && !screenshotTaken) {
      screenshotTaken = true
      await sleep(1200)
      for (let attempt = 0; attempt < 4; attempt++) {
        const shot = await send('Page.captureScreenshot', { format: 'png' }).catch((e) => {
          console.error(`› screenshot error: ${e.message ?? e}`)
          return null
        })
        if (shot?.result?.result?.data) {
          writeFileSync(screenshotPath, Buffer.from(shot.result.result.data, 'base64'))
          console.log(`› screenshot → ${screenshotPath}`)
          break
        }
        console.log(`› screenshot empty (attempt ${attempt + 1}), retrying…`)
        await sleep(800)
      }
    }
    if (install && state.phase === 'downloaded' && !installed) {
      installed = true
      console.log('› triggering quitAndInstall…')
      await evaluate('window.plano.update.install()')
      break
    }
    if (expectDownloaded && state.phase === 'downloaded') break
    if (state.phase === 'error' && state.message?.includes('No published versions')) {
      console.error('✖ no published release on the feed — publish first.')
      process.exit(1)
    }
  }
  await sleep(1000)
}

ws.close()
if (expectDownloaded && !installed) {
  const final = await evaluate('window.plano.update.getState()').catch(() => null)
  console.log(`final state: ${JSON.stringify(final)}`)
  process.exit(final?.phase === 'downloaded' ? 0 : 1)
}
process.exit(0)
