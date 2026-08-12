// Plan AGENT_AWARENESS probes — real agent detection via codex-sim node scripts:
//   W1: a working agent in another workspace → status dot in its row; gone when it rests.
//   W2: a plain terminal (no agent) does NOT count toward the agent number.
//   W3: awaiting-input → amber dot, outranking working.
//   N1: finishes in the NON-active workspace → one toast; click jumps.
//   N2: finishes in the ACTIVE workspace → no redundant toast.
//   N3: three at once → ONE grouped toast ("3 agents finished").
//   N4: agentDoneNotify off → no toast at all.
//   N5: awaiting toast persists; finished toast auto-dismisses.
//   N6: reduceMotion → no breathing dot.
//   N7: no system emoji in the toast UI.
//   F1/F2: font slider (legacy 0 → 13; drag → live).
import { spawn, spawnSync } from 'node:child_process'
import http from 'node:http'
import net from 'node:net'
import WebSocket from 'ws'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const getJson = (p, port) =>
  new Promise((res, rej) => {
    const req = http
      .get(`http://127.0.0.1:${port}${p}`, (r) => {
        let d = ''
        r.on('data', (c) => (d += c))
        r.on('end', () => res(JSON.parse(d)))
      })
      .on('error', rej)
    req.setTimeout(4000, () => req.destroy(new Error('json timeout')))
  })
function settings(extra, reduceMotion = false) {
  return {
    version: 11,
    general: { restoreLastWorkspace: true, restoreAgentSessions: false, showFilesOnLaunch: false, warnBeforeQuit: false, confirmClosePanelWithProcess: false, agentDoneSound: false, agentDoneNotify: true, ...extra },
    appearance: { theme: 'monolith', accent: '#FFFFFF', gridStyle: 'none', gridOpacity: 1, reduceMotion, canvasBackground: { kind: 'theme', colors: ['#141414', '#1d1d2b'], angle: 135 }, canvasGlow: 0, gridSize: 'standard' },
    editor: { fontSize: 13, tabSize: 2, wordWrap: true, lineNumbers: true },
    terminal: { shell: 'cmd', fontSize: 0, fontFamily: '', lineHeight: 1, cursorStyle: 'bar', cursorBlink: false, scrollback: 10000, copyOnSelect: false, predictiveHistory: false, theme: 'default' },
    canvas: { snapToGrid: true, showMinimap: false, zoomSensitivity: 1, autosave: true },
    browser: {},
    privacy: { telemetry: false, saveTerminalHistory: true },
    advanced: { hardwareAcceleration: true },
    agentMesh: { contextPersistence: false, maxPersistBytes: 524288 },
    voice: { enabled: false },
  }
}
function rpc(host, method, params) {
  return new Promise((res, rej) => {
    const socket = net.connect(host.port, '127.0.0.1')
    const timer = setTimeout(() => {
      socket.destroy()
      rej(new Error('tcp timeout ' + method))
    }, 10000)
    let buf = ''
    let sent = false
    let helloResult = null
    socket.on('connect', () => socket.write(JSON.stringify({ id: 1, method: 'hello', params: { token: host.token } }) + '\n'))
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8')
      for (const line of buf.split('\n').filter(Boolean)) {
        let msg
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }
        if (msg.id === 1) {
          helloResult = msg.result
          if (!sent) {
            sent = true
            socket.write(JSON.stringify({ id: 2, method, params }) + '\n')
          }
          continue
        }
        if (msg.id === 2) {
          clearTimeout(timer)
          socket.destroy()
          res({ result: msg.result, hello: helloResult })
          return
        }
      }
    })
    socket.on('error', rej)
  })
}
async function launch(UD, PRJ, port, spaces, extraSettings, reduceMotion = false) {
  fs.mkdirSync(UD, { recursive: true })
  fs.mkdirSync(PRJ, { recursive: true })
  fs.writeFileSync(path.join(PRJ, 'package.json'), '{}')
  fs.mkdirSync(path.join(PRJ, 'node_modules', 'codex-sim'), { recursive: true })
  fs.writeFileSync(
    path.join(PRJ, 'node_modules', 'codex-sim', 'index.js'),
    `const fs=require('fs');const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const main=async()=>{ for(let i=0;i<300;i++){ if(fs.existsSync('START')) break; await sleep(100); }
for(let i=0;i<12;i++){ process.stdout.write('\\rWorking... '+i); await sleep(250); } process.exit(0); };
main();`,
  )
  // Longer script — finishes alone, AFTER the 3 s group.
  fs.writeFileSync(
    path.join(PRJ, 'node_modules', 'codex-sim', 'index9.js'),
    `const fs=require('fs');const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const main=async()=>{ for(let i=0;i<300;i++){ if(fs.existsSync('START')) break; await sleep(100); }
for(let i=0;i<36;i++){ process.stdout.write('\\rWorking... '+i); await sleep(250); } process.exit(0); };
main();`,
  )
  fs.writeFileSync(
    path.join(UD, 'workspaces.json'),
    JSON.stringify({ schemaVersion: 1, savedAt: new Date().toISOString(), activeId: spaces[0].id, workspaces: spaces }),
  )
  fs.writeFileSync(path.join(UD, 'session.json'), JSON.stringify({ folderPath: PRJ }))
  fs.writeFileSync(path.join(UD, 'settings.json'), JSON.stringify(settings(extraSettings, reduceMotion)))
  const app = spawn('D:/Tools/Plano/node_modules/electron/dist/electron.exe', ['.', `--remote-debugging-port=${port}`], {
    env: { ...process.env, PLANO_USER_DATA_DIR: UD },
    stdio: 'ignore',
    windowsHide: true,
  })
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
  const ev = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })
    return r?.result?.result?.value ?? r?.result?.exceptionDetails?.text
  }
  await send('Page.bringToFront', {}).catch(() => {})
  let total = 0
  for (const s of spaces) total += s.panels.length
  for (let i = 0; i < 60; i += 1) {
    const n = (await ev(`document.querySelectorAll('.xterm').length`)) || 0
    if (n >= total) break
    await sleep(500)
  }
  let host
  for (let i = 0; i < 30 && !host; i += 1) {
    try {
      host = JSON.parse(fs.readFileSync(path.join(UD, 'agent-host.json'), 'utf8'))
    } catch {}
    await sleep(400)
  }
  const hello = (await rpc(host, 'ping', {})).hello ?? (await rpc(host, 'ping', {})).result
  const sessions = hello?.sessions ?? []
  const byPanel = (p) => sessions.find((s) => s.panelId === p)?.ptyId
  const pty = {}
  for (const s of spaces) for (const p of s.panels) pty[p.id] = byPanel(p.id) ?? null
  return { app, ev, host, pty }
}
const mkPanel = (id, x) => ({ id, type: 'terminal', rect: { x, y: 80, width: 400, height: 300 }, z: 1, title: id, props: { folderPath: '', command: '' } })
const mkSpace = (id, name, panels) => ({ id, name, folderPath: '', viewport: { x: 0, y: 0, zoom: 1 }, regions: [], panels })
const SCRIPT = (prj, dur = '') => `node "${path.join(prj, 'node_modules', 'codex-sim', dur ? `index${dur}.js` : 'index.js').replace(/"/g, '')}"`

async function main() {
  const run = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  const PRJ = path.join(os.tmpdir(), `mesh-awp-${run}`)
  const s1 = mkSpace('s1', 'Alpha', [mkPanel('t1a', 60), mkPanel('t1b', 480)])
  const s2 = mkSpace('s2', 'Beta', [mkPanel('t2a', 60), mkPanel('t2b', 480), mkPanel('t2c', 900), mkPanel('t2d', 1320), mkPanel('t2e', 1740)])
  const L = await launch(path.join(os.tmpdir(), `mesh-aw-${run}`), PRJ, 9760 + (Date.now() % 15), [s1, s2], {})
  const { app, ev, host, pty } = L

  const toasts = () => ev(`[...document.querySelectorAll('[role="status"]')].map(t => t.textContent || '')`)
  const openMenu = async () => {
    await ev(`document.querySelector('button[aria-label="Switch workspace"]')?.click()`)
    await sleep(400)
  }
  const closeMenu = async () => {
    await ev(`document.querySelector('[data-surface-layer="popover"]')?.click()`).catch(() => {})
    await sleep(200)
  }
  const switchTo = async (name) => {
    await openMenu()
    await ev(`(() => { const r=[...document.querySelectorAll('[role="option"]')].find(x => (x.textContent||'').includes('${name}')); r?.click() })()`)
    await sleep(1500)
  }

  // Mount the s2 panels so the daemon spawns their terminals, then return to s1 (they hibernate
  // but keep running — the supervisor keeps posting verdicts).
  await switchTo('Beta')
  // Re-capture the s2 ptys (they did not exist at launch).
  const hello2 = (await rpc(host, 'ping', {})).hello ?? (await rpc(host, 'ping', {})).result
  const sessions2 = hello2?.sessions ?? []
  const byPanel2 = (p) => sessions2.find((s) => s.panelId === p)?.ptyId
  for (const id of ['t2a', 't2b', 't2c', 't2d', 't2e']) pty[id] = byPanel2(id) ?? null
  console.log('PTY:', JSON.stringify(Object.fromEntries(Object.entries(pty).map(([k, v]) => [k, v ? v.slice(0, 8) : null]))))

  // ── F2/F1: font slider (legacy 0 → 13 shown; drag → live apply) ──
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: ',', ctrlKey: true, bubbles: true, cancelable: true }))`)
  await sleep(600)
  const sliderValue = await ev(`(() => { const i=[...document.querySelectorAll('input[type="range"]')].find(x => x.min === '10' && x.max === '24'); return i ? i.value : null })()`)
  const f1 = await ev(`(async () => {
    const i=[...document.querySelectorAll('input[type="range"]')].find(x => x.min === '10' && x.max === '24')
    if (!i) return null
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(i, '18')
    i.dispatchEvent(new Event('input', { bubbles: true }))
    i.dispatchEvent(new Event('change', { bubbles: true }))
    await new Promise(r => setTimeout(r, 500))
    return { value: i.value, xterms: document.querySelectorAll('.xterm').length }
  })()`)
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`)
  await sleep(300)

  // Launch the codex-sim scripts: 3 s for the group, 9 s for t2e (finishes alone).
  for (const p of [pty.t1a, pty.t2a, pty.t2b, pty.t2c, pty.t2d]) {
    await rpc(host, 'write', { ptyId: p, data: `${SCRIPT(PRJ)}\r` })
  }
  await rpc(host, 'write', { ptyId: pty.t2e, data: `${SCRIPT(PRJ, 9)}\r` })
  await sleep(1500)
  fs.writeFileSync(path.join(PRJ, 'START'), 'go')
  await sleep(1200) // scripts running (3 s) — working dots live now
  await openMenu()

  // ── W1: working dot in s2's row (s2 is the active workspace → roster sees it) ──
  const w1dot = await ev(`(() => { const r=[...document.querySelectorAll('[role="option"]')].find(x => (x.textContent||'').includes('Beta')); if(!r) return false; const s=[...r.querySelectorAll('span')].find(x => (x.getAttribute('style')||'').includes('width: 6px') && !(x.getAttribute('style')||'').includes('251, 191, 36')); return !!s })()`)

  // ── W2: plain terminal (t1b) does not count; the Alpha row shows 1 agent (t1a) ──
  const s1row = ((await ev(`[...document.querySelectorAll('[role="option"]')].map(r => r.textContent || '')`)) || []).find((r) => r.includes('Alpha')) ?? ''
  const w2ok = !s1row.includes('2 agent') && s1row.includes('1 agent')
  await closeMenu()

  // Back to Alpha — s2 hibernate (ptys keep running in the daemon).
  await switchTo('Alpha')

  // The 3 s scripts finish (~4.5 s post-START) → confirms at ~8.5 s.
  await sleep(7000)
  // ── N2: t1a finished in the ACTIVE workspace → no toast ──
  const n2ok = !(await toasts()).some((t) => t.includes('finished'))

  // ── N3: t2b/t2c/t2d finished together (~8.5 s) → ONE grouped toast ──
  let n3toasts = []
  for (let i = 0; i < 15 && n3toasts.length === 0; i += 1) {
    n3toasts = await toasts()
    if (n3toasts.length === 0) await sleep(400)
  }
  const n3ok = n3toasts.filter((t) => t.includes('agents finished')).length === 1 && n3toasts.filter((t) => t.includes('finished')).length === 1

  // ── W3: permission prompt in t2a → amber dot (priority) + awaiting toast persists (N5a) ──
  await rpc(host, 'write', { ptyId: pty.t2a, data: 'echo Do you want to proceed?\r' })
  let w3amber = false
  for (let i = 0; i < 16 && !w3amber; i += 1) {
    await openMenu()
    w3amber = await ev(`(() => { const r=[...document.querySelectorAll('[role="option"]')].find(x => (x.textContent||'').includes('Beta')); if(!r) return false; const s=[...r.querySelectorAll('span')].find(x => (x.getAttribute('style')||'').includes('251, 191, 36')); return !!s })()`)
    await closeMenu()
    if (!w3amber) await sleep(600)
  }
  const awaitingToast = (await toasts()).some((t) => t.includes('waiting for your input'))

  // ── N1: t2e finishes alone (~13.5 s) → toast; click jumps ──
  let n1toast = ''
  for (let i = 0; i < 30 && !n1toast; i += 1) {
    const all = await toasts()
    n1toast = all.find((t) => t.includes('finished') && !t.includes('agents finished')) ?? ''
    if (!n1toast) await sleep(500)
  }
  const n1ok = n1toast.includes('Codex finished')
  await ev(`(() => { const t=[...document.querySelectorAll('[role="status"]')].find(x => (x.textContent||'').includes('Codex finished')); t?.click() })()`)
  await sleep(800)
  const activeSpace = await ev(`document.querySelector('button[aria-label="Switch workspace"]')?.textContent || ''`)
  const n1jump = activeSpace.includes('Beta')

  // ── N5b: finished toasts auto-dismiss; awaiting toast persists (N5a) ──
  await sleep(7000)
  const n5b = !(await toasts()).some((t) => t.includes('finished'))
  const n5a = (await toasts()).some((t) => t.includes('waiting for your input'))

  // ── N7: no system emoji ──
  const n7 = await ev(`(() => { const t=[...document.querySelectorAll('[role="status"]')]; return !t.some(x => (x.textContent||'').includes('📱')) })()`)

  await ev('window.plano.window.close()').catch(() => {})
  await sleep(600)
  try {
    spawnSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore', timeout: 8000 })
  } catch {}

  // ── N4: agentDoneNotify off → no toast ──
  const UD4 = path.join(os.tmpdir(), `mesh-awb-${run}`)
  const L4 = await launch(UD4, PRJ, 9790 + (Date.now() % 10), [s1], { agentDoneNotify: false })
  const { app: app4, ev: ev4, host: host4, pty: pty4 } = L4
  await rpc(host4, 'write', { ptyId: pty4.t1a, data: `${SCRIPT(PRJ)}\r` })
  await sleep(1500)
  fs.writeFileSync(path.join(PRJ, 'START'), 'go')
  await sleep(9000)
  const n4ok = (await ev4(`document.querySelectorAll('[role="status"]').length`)) === 0
  await ev4('window.plano.window.close()').catch(() => {})
  await sleep(600)
  try {
    spawnSync('taskkill', ['/PID', String(app4.pid), '/T', '/F'], { stdio: 'ignore', timeout: 8000 })
  } catch {}

  // ── N6: reduceMotion → no breathing dot (opacity-only) ──
  const UD6 = path.join(os.tmpdir(), `mesh-awd-${run}`)
  const L6 = await launch(UD6, PRJ, 9820 + (Date.now() % 10), [s1], {}, true)
  const { app: app6, ev: ev6, host: host6, pty: pty6 } = L6
  await rpc(host6, 'write', { ptyId: pty6.t1a, data: `${SCRIPT(PRJ)}\r` })
  await sleep(1500)
  fs.writeFileSync(path.join(PRJ, 'START'), 'go')
  await sleep(7000)
  await rpc(host6, 'write', { ptyId: pty6.t1a, data: 'echo Do you want to proceed?\r' })
  await sleep(4000)
  const n6dot = await ev6(`(() => { const t=[...document.querySelectorAll('[role="status"]')].find(x => (x.textContent||'').includes('waiting')); if(!t) return 'no-toast'; const dot=[...t.querySelectorAll('span')].find(x => (x.getAttribute('class')||'').includes('mesh-waiting-dot')); return dot ? 'dot' : 'no-dot' })()`)
  const n6ok = n6dot === 'no-dot' || n6dot === 'no-toast'
  await ev6('window.plano.window.close()').catch(() => {})
  await sleep(600)
  try {
    spawnSync('taskkill', ['/PID', String(app6.pid), '/T', '/F'], { stdio: 'ignore', timeout: 8000 })
  } catch {}

  console.log(
    'RESULT:',
    JSON.stringify({
      ok: sliderValue === '13' && f1?.value === '18' && f1?.xterms > 0 && w2ok && w1dot && w3amber && n2ok && n3ok && n1ok && n1jump && n5a && n5b && n7 && n4ok && n6ok,
      f: { sliderValue, f1 },
      w: { w2ok, s1row: s1row.slice(0, 70), w1dot, w3amber },
      n: { n2ok, n3ok, n3toasts: n3toasts.slice(0, 3), n1ok, n1jump, activeSpace, awaitingToast, n5a, n5b, n7, n4ok, n6: n6dot },
    }),
  )
  process.exit(0)
}
main().catch((e) => {
  console.error('ERR', e)
  process.exit(1)
})
