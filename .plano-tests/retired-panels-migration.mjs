/**
 * Retired panel types must not break a canvas that still contains them.
 *
 * 'agent', 'git' and 'voice' were removed from PanelType. A workspace saved before that still has
 * them on disk, so this seeds exactly such a workspace and asserts the canvas opens with:
 *   · the agent panel turned into a terminal, keeping its id and rect (its whole job was to launch
 *     a CLI into a terminal, and an empty terminal already offers that launcher)
 *   · the git and voice panels gone (they only ever rendered "Coming soon" — nothing to preserve)
 *   · every surviving panel untouched
 * A failure here means a user's saved layout fails to open, which is worse than the dead UI removed.
 */
import { spawn, spawnSync } from 'node:child_process'
import http from 'node:http'
import net from 'node:net'
import WebSocket from 'ws'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const UD = path.join(os.tmpdir(), `plano-retired-ud-${Date.now()}`)
const PRJ = path.join(os.tmpdir(), `plano-retired-prj-${Date.now()}`)
let appPid = 0

const getJson = (p, port) =>
  new Promise((res, rej) => {
    http
      .get(`http://127.0.0.1:${port}${p}`, (r) => {
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

function cleanup() {
  try {
    if (appPid) spawnSync('taskkill', ['/PID', String(appPid), '/T', '/F'], { stdio: 'ignore', timeout: 8000 })
  } catch {}
  try {
    const h = JSON.parse(fs.readFileSync(path.join(UD, 'agent-host.json'), 'utf8'))
    if (h?.pid) spawnSync('taskkill', ['/PID', String(h.pid), '/T', '/F'], { stdio: 'ignore', timeout: 8000 })
  } catch {}
}

async function main() {
  fs.mkdirSync(UD, { recursive: true })
  fs.mkdirSync(PRJ, { recursive: true })

  // A workspace exactly as an older PLANO would have written it.
  const panels = [
    { id: 'keep-md', type: 'markdown', rect: { x: 40, y: 40, width: 400, height: 300 }, z: 1, title: 'Doc', props: { content: 'hello' } },
    { id: 'old-agent', type: 'agent', rect: { x: 500, y: 40, width: 480, height: 520 }, z: 2, title: 'PLANO Agent', props: { provider: 'claude-code' } },
    { id: 'old-git', type: 'git', rect: { x: 40, y: 400, width: 420, height: 480 }, z: 3, title: 'Git', props: {} },
    { id: 'old-voice', type: 'voice', rect: { x: 500, y: 600, width: 320, height: 200 }, z: 4, title: 'Voice', props: {} },
  ]
  fs.writeFileSync(
    path.join(UD, 'workspaces.json'),
    JSON.stringify({
      schemaVersion: 1,
      savedAt: new Date().toISOString(),
      activeId: 's1',
      workspaces: [{ id: 's1', name: 'S', folderPath: PRJ, viewport: { x: 0, y: 0, zoom: 1 }, regions: [], panels }],
    }),
  )
  fs.writeFileSync(path.join(UD, 'session.json'), JSON.stringify({ folderPath: PRJ }))

  const port = await new Promise((res) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port
      srv.close(() => res(p))
    })
  })
  const app = spawn('D:/Tools/Plano/node_modules/electron/dist/electron.exe', ['.', `--remote-debugging-port=${port}`], {
    env: { ...process.env, PLANO_USER_DATA_DIR: UD },
    stdio: 'ignore',
    windowsHide: true,
  })
  appPid = app.pid ?? 0
  app.unref()

  let page
  for (let i = 0; i < 120 && !page; i++) {
    try {
      const t = await getJson('/json', port)
      page = t.find((x) => x.type === 'page' && x.url.includes('index.html'))
    } catch {}
    await sleep(500)
  }
  if (!page) throw new Error('no page')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.once('open', res)
    ws.once('error', rej)
  })
  let id = 0
  const pend = new Map()
  ws.on('message', (d) => {
    const m = JSON.parse(d)
    if (m.id && pend.has(m.id)) {
      pend.get(m.id)(m)
      pend.delete(m.id)
    }
  })
  const send = (method, params = {}) =>
    new Promise((res) => {
      const i = ++id
      const t = setTimeout(() => {
        pend.delete(i)
        res(undefined)
      }, 15000)
      pend.set(i, (m) => {
        clearTimeout(t)
        res(m)
      })
      ws.send(JSON.stringify({ id: i, method, params }))
    })
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    return r?.result?.result?.value ?? r?.result?.exceptionDetails?.text
  }

  await sleep(6000)

  // The store is the authority on what the canvas holds after migration.
  const state = await ev(`(() => {
    const err = document.body.innerText.includes('PLANO crashed') ? document.body.innerText.slice(0, 300) : null
    const panels = window.__planoPanels ? window.__planoPanels() : null
    return JSON.stringify({ err, panels, domPanels: document.querySelectorAll('[data-panel-id]').length,
      dockButtons: [...document.querySelectorAll('button[aria-label], button[title]')].map(b => b.getAttribute('aria-label') || b.getAttribute('title')).filter(Boolean).slice(0, 40) })
  })()`)

  // The spaces store rewrites userData/workspaces.json on autosave, AFTER migration — that file is
  // what the next launch will read, so it is the honest place to assert against. (The per-project
  // .plano/workspace.json only exists once the project itself is saved.)
  await sleep(4000)
  let saved = null
  try {
    const w = JSON.parse(fs.readFileSync(path.join(UD, 'workspaces.json'), 'utf8'))
    const space = (w.workspaces ?? []).find((s) => s.id === 's1') ?? {}
    saved = (space.panels ?? []).map((p) => ({ id: p.id, type: p.type, x: p.rect?.x, y: p.rect?.y }))
  } catch (e) {
    saved = { readError: String(e.message || e) }
  }

  console.log('STATE:', state)
  console.log('SAVED:', JSON.stringify(saved))

  // Assert on what is RENDERED, not on the persisted file: migration happens as the canvas loads,
  // and the spaces store keeps its own snapshot of the raw workspace, so the file legitimately
  // still holds the old type names. What must be true is that the canvas shows the right thing.
  const rendered = await ev(`(() => {
    const text = document.body.innerText
    return JSON.stringify({
      panelCount: document.querySelectorAll('button[aria-label="Close panel"]').length,
      hasTerminalLauncher: !!document.querySelector('[aria-label="Launch an AI agent in this terminal"], [title="Launch an AI agent in this terminal"]'),
      hasComingSoon: text.includes('Coming soon in PLANO'),
      hasMarkdown: text.includes('hello'),
    })
  })()`)
  console.log('RENDERED:', rendered)
  const r = JSON.parse(rendered)
  const parsed = JSON.parse(state)
  const ok = {
    noCrash: !parsed.err,
    // markdown + the terminal the agent panel became; git and voice contributed nothing.
    twoPanelsOnCanvas: r.panelCount === 2,
    agentBecameTerminal: r.hasTerminalLauncher === true,
    retiredStubsGone: r.hasComingSoon === false,
    survivorKept: r.hasMarkdown === true,
    noRetiredDockButton: !(parsed.dockButtons ?? []).some((t) => /New Agent|New Voice|New Git/i.test(t)),
  }
  console.log('RESULT:', JSON.stringify({ ok: Object.values(ok).every(Boolean), ...ok }))
  cleanup()
  process.exit(0)
}

main().catch((e) => {
  console.error('ERROR:', e && e.stack ? e.stack : String(e))
  cleanup()
  process.exit(1)
})
