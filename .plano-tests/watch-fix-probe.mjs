// Verify the Files-panel watcher fix in dev:
//  - writing an UNRELATED file must NOT re-read the open file (the lag fix)
//  - writing the OPEN file must still live-reload the editor
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import http from 'node:http'
import WebSocket from 'ws'
import { writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const EXE = 'D:/Tools/Plano/node_modules/electron/dist/electron.exe'
const port = 9931
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const getJson = (p, port) =>
  new Promise((res, rej) => {
    http
      .get('http://127.0.0.1:' + port + p, (r) => {
        let d = ''
        r.on('data', (c) => (d += c))
        r.on('end', () => res(JSON.parse(d)))
      })
      .on('error', rej)
  })

async function main() {
  const RUN = Date.now() + Math.random().toString(36).slice(2)
  const UD = join(tmpdir(), 'watchfix-' + RUN)
  const PR = join(tmpdir(), 'watchfix-prj-' + RUN)
  rmSync(UD, { recursive: true, force: true })
  mkdirSync(UD, { recursive: true })
  mkdirSync(PR, { recursive: true })
  writeFileSync(join(PR, 'package.json'), '{}')
  writeFileSync(join(PR, 'open.ts'), 'export const open = 1;\n')
  writeFileSync(join(PR, 'other.ts'), 'export const other = 1;\n')
  writeFileSync(
    join(UD, 'workspaces.json'),
    JSON.stringify({
      schemaVersion: 1,
      savedAt: new Date().toISOString(),
      activeId: 's1',
      workspaces: [
        {
          id: 's1',
          name: 'W',
          folderPath: PR,
          viewport: { x: 0, y: 0, zoom: 1 },
          regions: [],
          panels: [{ id: 'e1', type: 'editor', rect: { x: 60, y: 60, width: 900, height: 560 }, z: 1, title: 'Files', props: { folderPath: PR, filePath: join(PR, 'open.ts'), sidebarOpen: true } }],
        },
      ],
    }),
  )
  writeFileSync(join(UD, 'session.json'), JSON.stringify({ folderPath: PR }))
  writeFileSync(
    join(UD, 'settings.json'),
    JSON.stringify({
      version: 9,
      general: { restoreLastWorkspace: true, restoreAgentSessions: false, showFilesOnLaunch: false, warnBeforeQuit: false, confirmClosePanelWithProcess: false, agentDoneSound: false },
      appearance: { theme: 'monolith', accent: '#FFFFFF', gridStyle: 'dots', gridOpacity: 1, grain: false, reduceMotion: false },
      editor: { fontSize: 13, tabSize: 2, wordWrap: true, lineNumbers: true },
      terminal: { shell: 'cmd', shellPath: '', fontFamily: '', fontSize: 0, lineHeight: 1.4, cursorStyle: 'bar', cursorBlink: false, scrollback: 5000, theme: 'campbell', copyOnSelect: false, predictiveHistory: false, smartActions: false, autoSuspendIdle: true, keepAgentsOnQuit: true },
      canvas: { snapToGrid: true, showMinimap: false, zoomSensitivity: 1, autosave: true },
      browser: {},
      privacy: { telemetry: false, saveTerminalHistory: true },
      advanced: { hardwareAcceleration: true },
      agentMesh: {},
      voice: {},
    }),
  )
  const app = spawn(EXE, ['.', '--remote-debugging-port=' + port], {
    env: { ...process.env, PLANO_USER_DATA_DIR: UD },
    stdio: 'ignore',
    windowsHide: true,
  })
  app.unref()
  let page
  for (let i = 0; i < 120 && !page; i += 1) {
    try {
      const t = await getJson('/json', port)
      page = t.find((x) => x.type === 'page' && x.url.includes('index.html'))
    } catch {}
    await sleep(500)
  }
  if (!page) {
    console.log('NO PAGE')
    process.exit(1)
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.once('open', res)
    ws.once('error', rej)
  })
  let id = 0
  const pend = new Map()
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString())
    if (m.id && pend.has(m.id)) {
      pend.get(m.id)(m)
      pend.delete(m.id)
    }
  })
  const send = (method, params = {}) =>
    new Promise((res) => {
      const i = ++id
      pend.set(i, res)
      ws.send(JSON.stringify({ id: i, method, params }))
    })
  const ev = async (e) =>
    (await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result?.result?.value
  await send('Page.bringToFront', {}).catch(() => {})
  // wait for the editor to mount open.ts
  for (let i = 0; i < 60; i += 1) {
    const len = await ev(`(() => { const c = document.querySelector('.cm-content'); return c ? c.textContent.length : 0 })()`).catch(() => 0)
    if (len > 5) break
    await sleep(300)
  }
  const readEditor = () => ev(`(() => { const c = document.querySelector('.cm-content'); return c ? c.textContent : '' })()`).catch(() => '')
  const before = await readEditor()
  console.log('editor initial:', JSON.stringify(before.slice(0, 60)))

  // 1) write an UNRELATED file → editor must NOT re-read (content + a churn counter stay put)
  await ev(`window.__churn = 0; window.__t0 = performance.now(); 'ok'`)
  writeFileSync(join(PR, 'other.ts'), 'export const other = 2;\n')
  await sleep(1800)
  const afterUnrelated = await readEditor()
  console.log('after unrelated write:', JSON.stringify(afterUnrelated.slice(0, 60)), '| unchanged:', afterUnrelated === before)

  // 2) write the OPEN file → editor MUST live-reload
  writeFileSync(join(PR, 'open.ts'), 'export const open = 99; // changed\n')
  let reloaded = false
  for (let i = 0; i < 30; i += 1) {
    const cur = await readEditor()
    if (cur.includes('changed')) {
      reloaded = true
      break
    }
    await sleep(200)
  }
  console.log('open-file write live-reloaded:', reloaded)
  console.log('RESULT:', JSON.stringify({ unrelatedNoReload: afterUnrelated === before, openReloads: reloaded }))
  await ev('window.plano.window.close()').catch(() => {})
  await sleep(800)
  try {
    spawnSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore', timeout: 8000 })
  } catch {}
  process.exit(0)
}
main().catch((e) => {
  console.error(e)
  process.exit(1)
})
