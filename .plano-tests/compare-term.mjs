// Compare the terminal rendering chain (composition ancestors + mouse-move frame cost)
// between two PLANO builds. Usage: node compare-term.mjs <exePath> <seedUserData> <port>
import { spawn, spawnSync } from 'node:child_process'
import http from 'node:http'
import WebSocket from 'ws'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const EXE = process.argv[2]
const UD = process.argv[3]
const port = Number(process.argv[4])
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
  const PR = join(tmpdir(), 'cmp-prj-' + Date.now())
  rmSync(UD, { recursive: true, force: true })
  mkdirSync(PR, { recursive: true })
  mkdirSync(UD, { recursive: true })
  writeFileSync(join(PR, 'package.json'), '{}')
  writeFileSync(
    join(UD, 'workspaces.json'),
    JSON.stringify({
      schemaVersion: 1,
      savedAt: new Date().toISOString(),
      activeId: 's1',
      workspaces: [
        {
          id: 's1',
          name: 'C',
          folderPath: PR,
          viewport: { x: 0, y: 0, zoom: 1 },
          regions: [],
          panels: [{ id: 'p1', type: 'terminal', rect: { x: 100, y: 80, width: 900, height: 520 }, z: 1, title: 'Terminal', props: { tabs: [{ id: 't1' }], activeTabId: 't1', terminalNumber: 1 } }],
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
      editor: {},
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
  await sleep(9000)
  // Wait for the terminal to mount
  for (let i = 0; i < 60; i += 1) {
    const ok = await ev(`!!document.querySelector('.xterm')`)
    if (ok) break
    await sleep(500)
  }
  const dump = await ev(`(() => {
    const xterm = document.querySelector('.xterm')
    if (!xterm) return { error: 'no xterm' }
    const chain = []
    let el = xterm
    for (let i = 0; i < 12 && el; i += 1) {
      const cs = getComputedStyle(el)
      const r = el.getBoundingClientRect()
      chain.push({
        tag: el.tagName,
        cls: (el.className || '').toString().slice(0, 60),
        transform: cs.transform,
        opacity: cs.opacity,
        willChange: cs.willChange,
        filter: cs.filter,
        backdrop: cs.backdropFilter,
        mixBlend: cs.mixBlendMode,
        boxShadow: cs.boxShadow.slice(0, 60),
        overflow: cs.overflow,
        w: Math.round(r.width),
        h: Math.round(r.height),
      })
      el = el.parentElement
    }
    // canvas info
    const canvas = xterm.querySelector('canvas')
    const ctx = canvas ? { w: canvas.width, h: canvas.height, cw: canvas.clientWidth, ch: canvas.clientHeight } : null
    // mouse-move frame cost: move the real cursor over the terminal, measure rAF deltas
    return { chain, canvas: ctx }
  })()`)
  console.log('TREE:', JSON.stringify(dump, null, 1))
  console.log('FRAMES: skipped');
  await ev('window.plano.window.close()').catch(() => {});
  await sleep(800);
  try { spawnSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore', timeout: 8000 }) } catch {}
  process.exit(0)
}
main().catch((e) => {
  console.error(e)
  process.exit(1)
})
