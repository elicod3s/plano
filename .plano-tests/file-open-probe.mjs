// Compare the Files panel file-open cost between two builds.
// Seeds a project with files + an editor panel with one file open, measures:
//  - time from page-ready until CodeMirror renders the file content
//  - rAF frame cost during the mount
//  - time to switch to another file by clicking a tree row
// Usage: node file-open-probe.mjs <exePath> <port>
import { spawn, spawnSync } from 'node:child_process'
import http from 'node:http'
import WebSocket from 'ws'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const EXE = process.argv[2]
const port = Number(process.argv[3])
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
  const UD = join(tmpdir(), 'fileopen-' + RUN)
  const PR = join(tmpdir(), 'fileopen-prj-' + RUN)
  rmSync(UD, { recursive: true, force: true })
  mkdirSync(UD, { recursive: true })
  mkdirSync(PR, { recursive: true })
  mkdirSync(join(PR, 'src'), { recursive: true })
  writeFileSync(join(PR, 'package.json'), '{}')
  const big = Array.from({ length: 600 }, (_, i) => `const line${i} = ${i} * 2; // ${'x'.repeat(60)}`).join('\n')
  writeFileSync(join(PR, 'src', 'a.ts'), big)
  writeFileSync(join(PR, 'src', 'b.ts'), Array.from({ length: 120 }, (_, i) => `export const b${i} = ${i};`).join('\n'))
  writeFileSync(join(PR, 'src', 'c.ts'), 'export const c = 3;\n')
  writeFileSync(join(PR, 'README.md'), '# README\n\nSome docs.\n')
  writeFileSync(
    join(UD, 'workspaces.json'),
    JSON.stringify({
      schemaVersion: 1,
      savedAt: new Date().toISOString(),
      activeId: 's1',
      workspaces: [
        {
          id: 's1',
          name: 'F',
          folderPath: PR,
          viewport: { x: 0, y: 0, zoom: 1 },
          regions: [],
          panels: [
            { id: 'e1', type: 'editor', rect: { x: 60, y: 60, width: 900, height: 560 }, z: 30, title: 'Files', props: { folderPath: PR, filePath: join(PR, 'src', 'a.ts'), sidebarOpen: true } },
            { id: 't1', type: 'terminal', rect: { x: 120, y: 140, width: 210, height: 140 }, z: 1, title: 'Terminal 1', props: { tabs: [{ id: 'tt1' }], activeTabId: 'tt1', terminalNumber: 1 } },
            { id: 't2', type: 'terminal', rect: { x: 350, y: 140, width: 210, height: 140 }, z: 2, title: 'Terminal 2', props: { tabs: [{ id: 'tt2' }], activeTabId: 'tt2', terminalNumber: 2 } },
            { id: 't3', type: 'terminal', rect: { x: 580, y: 140, width: 210, height: 140 }, z: 3, title: 'Terminal 3', props: { tabs: [{ id: 'tt3' }], activeTabId: 'tt3', terminalNumber: 3 } },
            { id: 't4', type: 'terminal', rect: { x: 810, y: 140, width: 210, height: 140 }, z: 4, title: 'Terminal 4', props: { tabs: [{ id: 'tt4' }], activeTabId: 'tt4', terminalNumber: 4 } },
            { id: 't5', type: 'terminal', rect: { x: 120, y: 300, width: 210, height: 140 }, z: 5, title: 'Terminal 5', props: { tabs: [{ id: 'tt5' }], activeTabId: 'tt5', terminalNumber: 5 } },
            { id: 't6', type: 'terminal', rect: { x: 350, y: 300, width: 210, height: 140 }, z: 6, title: 'Terminal 6', props: { tabs: [{ id: 'tt6' }], activeTabId: 'tt6', terminalNumber: 6 } },
            { id: 't7', type: 'terminal', rect: { x: 580, y: 300, width: 210, height: 140 }, z: 7, title: 'Terminal 7', props: { tabs: [{ id: 'tt7' }], activeTabId: 'tt7', terminalNumber: 7 } },
            { id: 't8', type: 'terminal', rect: { x: 810, y: 300, width: 210, height: 140 }, z: 8, title: 'Terminal 8', props: { tabs: [{ id: 'tt8' }], activeTabId: 'tt8', terminalNumber: 8 } },
            { id: 'n1', type: 'sticky', rect: { x: 60, y: 640, width: 260, height: 140 }, z: 9, title: 'Note', props: { text: 'hello', tone: 'yellow' } },
          ],
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
  const packaged = /PLANO\.exe$/i.test(EXE)
  const app = spawn(EXE, packaged ? ['--remote-debugging-port=' + port] : ['.', '--remote-debugging-port=' + port], {
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
  const t0 = Date.now()
  // Wait for the editor to render the big file's content.
  let mountMs = null
  let mountedLen = null
  for (let i = 0; i < 120; i += 1) {
    const info = await ev(`(() => {
      const c = document.querySelector('.cm-content')
      return c ? { len: c.textContent.length, hasTree: !!document.querySelector('[data-panel-type="editor"]') } : null
    })()`).catch(() => null)
    if (info && info.len > 1000) {
      mountMs = Date.now() - t0
      mountedLen = info.len
      break
    }
    await sleep(250)
  }
  // Frame cost while the editor paints (a few frames after mount).
  const frames = await ev(`(async () => {
    const d = []
    let last = performance.now()
    const f = () => { d.push(performance.now() - last); last = performance.now(); if (d.length < 30) requestAnimationFrame(f) }
    requestAnimationFrame(f)
    await new Promise((r) => setTimeout(r, 300))
    return d
  })()`).catch(() => [])
  const sorted = [...(frames || [])].sort((a, b) => a - b)
  const n = sorted.length
  // Switch to another file: click the tree row for b.ts.
  let switchMs = null
  let switchedLen = null
  const s0 = Date.now()
  const clicked = await ev(`(() => {
    const rows = [...document.querySelectorAll('[data-panel-type="editor"] [class*="row"], [data-panel-type="editor"] li, [data-panel-type="editor"] span')]
    const row = rows.find((el) => (el.textContent || '').trim() === 'b.ts')
    if (!row) return 'no-row'
    row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    row.click()
    return 'ok'
  })()`).catch(() => 'err')
  for (let i = 0; i < 60; i += 1) {
    const info = await ev(`(() => { const c = document.querySelector('.cm-content'); return c ? c.textContent.length : null })()`).catch(() => null)
    if (info != null && info < 2000 && info > 0) {
      switchMs = Date.now() - s0
      switchedLen = info
      break
    }
    await sleep(200)
  }
  const result = {
    exe: EXE.split(/[\\/]/).pop(),
    mountMs,
    mountedLen,
    switchMs,
    switchedLen,
    clickResult: clicked,
    frames: n ? { mean: Math.round((sorted.reduce((a, b) => a + b, 0) / n) * 10) / 10, p95: Math.round(sorted[Math.max(0, Math.ceil(0.95 * n) - 1)] * 10) / 10, max: Math.round(sorted[n - 1] * 10) / 10 } : null,
  }
  console.log('RESULT:', JSON.stringify(result))
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
