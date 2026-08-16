/**
 * A dead renderer must not take the app with it.
 *
 * PLANO was closing on its own with many agents open and no error: the renderer crashed, the window
 * closed, `window-all-closed` quit the app. The detached agent host kept every PTY alive, so the
 * agents survived while the window vanished — exactly the reported symptom, and 19 `crashed`
 * entries in the user's log.
 *
 * This crashes the renderer on purpose (CDP `Page.crash`) and asserts the app is still alive and
 * has reloaded itself afterwards.
 *
 * Usage: node tests/e2e/renderer-crash-recovery.mjs [port]
 */
import { spawn, spawnSync } from 'node:child_process'
import http from 'node:http'
import WebSocket from 'ws'
import { writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = Number(process.argv[2] || 9900)
const REPO = 'D:/Tools/Plano'
const EXE = join(REPO, 'node_modules/electron/dist/electron.exe')
const UD = join(tmpdir(), `plano-crash-ud-${PORT}`)
const PROJECT = join(tmpdir(), `plano-crash-prj-${PORT}`)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const getJson = (p) =>
  new Promise((res, rej) => {
    http
      .get(`http://127.0.0.1:${PORT}${p}`, (r) => {
        let d = ''
        r.on('data', (c) => (d += c))
        r.on('end', () => {
          try {
            res(JSON.parse(d))
          } catch (e) {
            rej(e)
          }
        })
      })
      .on('error', rej)
  })

async function findPage() {
  for (let i = 0; i < 120; i += 1) {
    try {
      const t = await getJson('/json')
      const p = t.find((x) => x.type === 'page' && x.url.includes('index.html'))
      if (p) return p
    } catch {}
    await sleep(500)
  }
  return null
}

async function main() {
  rmSync(UD, { recursive: true, force: true })
  mkdirSync(UD, { recursive: true })
  mkdirSync(PROJECT, { recursive: true })
  writeFileSync(join(UD, 'session.json'), JSON.stringify({ folderPath: PROJECT }))

  const app = spawn(EXE, ['.', `--remote-debugging-port=${PORT}`], {
    cwd: REPO,
    env: { ...process.env, PLANO_USER_DATA_DIR: UD },
    stdio: 'ignore',
    windowsHide: false,
  })
  app.unref()
  const appPid = app.pid
  const alive = () => {
    const r = spawnSync('powershell', ['-NoProfile', '-Command', `if (Get-Process -Id ${appPid} -ErrorAction SilentlyContinue) { 'yes' } else { 'no' }`], {
      encoding: 'utf8',
      timeout: 15000,
    })
    return (r.stdout || '').trim() === 'yes'
  }
  const kill = () => {
    try {
      spawnSync('taskkill', ['/PID', String(appPid), '/T', '/F'], { stdio: 'ignore', timeout: 8000 })
    } catch {}
  }

  const page = await findPage()
  if (!page) throw new Error('no CDP page')
  await sleep(4000)

  // Crash it.
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.once('open', res)
    ws.once('error', rej)
  })
  try {
    ws.send(JSON.stringify({ id: 1, method: 'Page.crash', params: {} }))
  } catch {}
  await sleep(1500)
  try {
    ws.close()
  } catch {}

  const survivedImmediately = alive()

  // The handler reloads on the next tick; give it room, then look for a live page again.
  await sleep(9000)
  const stillAlive = alive()
  const recovered = stillAlive ? !!(await findPage()) : false

  let logged = { crash: 0, reload: 0 }
  try {
    const log = readFileSync(join(UD, 'logs', 'plano.log'), 'utf8')
    logged = {
      crash: (log.match(/render-process-gone"/g) || []).length,
      reload: (log.match(/render-process-reloading/g) || []).length,
    }
  } catch {}

  console.log(
    'RESULT:',
    JSON.stringify({
      ok: stillAlive && recovered && logged.reload > 0,
      survivedImmediately,
      stillAlive,
      pageBack: recovered,
      ...logged,
    }),
  )
  kill()
  process.exit(0)
}

main().catch((e) => {
  console.error('ERROR:', e && e.stack ? e.stack : String(e))
  process.exit(1)
})
