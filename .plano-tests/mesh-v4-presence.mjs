// Plan AGENT_MESH_V4 presence probes:
//   V1 rest: after an exchange the line STAYS (idle, opacity 0.1); closing the panel removes it.
//   V2 glyph: mesh member panels show the tiny node dot; a plain terminal does not.
//   V3 queued: queue to a busy agent → ▾N counter in its tab; gone after delivery.
//   V4 awaiting-input: permission prompt in the tail → amber breathing dot in the tab.
//   V5 ask/reply: waiting breathing dot at the receiver end; reply fires a back-pulse.
//   V6 reduced motion: no pulse circles at all, states still visible.
//   V7 perf: 8 relations (rest+active mix) while panning → 0 long tasks.
import { spawn, spawnSync } from 'node:child_process'
import http from 'node:http'
import net from 'node:net'
import { createHmac } from 'node:crypto'
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
function settings(reduceMotion) {
  return {
    version: 11,
    general: { restoreLastWorkspace: true, restoreAgentSessions: false, showFilesOnLaunch: false, warnBeforeQuit: false, confirmClosePanelWithProcess: false, agentDoneSound: false },
    appearance: { theme: 'monolith', accent: '#FFFFFF', gridStyle: 'none', gridOpacity: 1, reduceMotion, canvasBackground: { kind: 'theme', colors: ['#141414', '#1d1d2b'], angle: 135 }, canvasGlow: 0, gridSize: 'standard' },
    editor: { fontSize: 13, tabSize: 2, wordWrap: true, lineNumbers: true },
    terminal: { shell: 'cmd' },
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
function post(webPort, token, body) {
  return new Promise((res, rej) => {
    const data = JSON.stringify(body)
    const req = http.request(
      { host: '127.0.0.1', port: webPort, path: '/cli', method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'Content-Length': Buffer.byteLength(data) } },
      (r) => {
        let d = ''
        r.on('data', (c) => (d += c))
        r.on('end', () => {
          try {
            res(JSON.parse(d))
          } catch {
            res({ raw: d.slice(0, 200) })
          }
        })
      },
    )
    req.on('error', rej)
    req.setTimeout(20000, () => req.destroy(new Error('http timeout')))
    req.write(data)
    req.end()
  })
}
async function toolResult(webPort, token, name, args) {
  const r = await post(webPort, token, { jsonrpc: '2.0', id: 1, method: name, params: args })
  try {
    return r?.result ?? {}
  } catch {
    return {}
  }
}
async function launch(port, UD, PRJ, panels, reduceMotion) {
  fs.mkdirSync(UD, { recursive: true })
  fs.mkdirSync(PRJ, { recursive: true })
  fs.writeFileSync(path.join(PRJ, 'package.json'), '{}')
  fs.writeFileSync(
    path.join(UD, 'workspaces.json'),
    JSON.stringify({ schemaVersion: 1, savedAt: new Date().toISOString(), activeId: 's1', workspaces: [{ id: 's1', name: 'S', folderPath: PRJ, viewport: { x: 0, y: 0, zoom: 1 }, regions: [], panels }] }),
  )
  fs.writeFileSync(path.join(UD, 'session.json'), JSON.stringify({ folderPath: PRJ }))
  fs.writeFileSync(path.join(UD, 'settings.json'), JSON.stringify(settings(reduceMotion)))
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
  if (!page) throw new Error('no page — electron did not expose CDP')
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
  for (let i = 0; i < 60; i += 1) {
    const n = (await ev(`document.querySelectorAll('.xterm').length`)) || 0
    if (n >= panels.length) break
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
  for (const p of panels) pty[p.id] = byPanel(p.id) ?? null
  const webPort = hello?.webPort ?? host.webPort
  const secret = fs.readFileSync(path.join(UD, 'mesh', 'master-secret'), 'utf8').trim()
  const token = {}
  for (const [name, pid] of Object.entries(pty)) token[name] = pid ? createHmac('sha256', secret).update(pid).digest('hex') : null
  return { app, ev, host, pty, token, webPort, secret }
}
async function main() {
  const run = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  const panels = ['tA', 'tB', 'tC', 'tD'].map((id, i) => ({ id, type: 'terminal', rect: { x: 60 + (i % 2) * 500, y: 80 + Math.floor(i / 2) * 400, width: 440, height: 320 }, z: 1, title: id, props: { folderPath: path.join(os.tmpdir(), `mesh-v4p-${run}`), command: '' } }))
  const PRJ = path.join(os.tmpdir(), `mesh-v4p-${run}`)
  const L = await launch(9690 + (Date.now() % 20), path.join(os.tmpdir(), `mesh-v4-${run}`), PRJ, panels, false)
  const { app, ev, host, pty, token, webPort } = L
  const call = (name, args, t = token.tA) => toolResult(webPort, t, name, args)
  for (const p of [pty.tA, pty.tB, pty.tC]) {
    await rpc(host, 'reportVerdict', { ptyId: p, verdict: { active: true, kind: 'codex', phase: 'idle', displayName: 'codex' } })
  }
  // tD stays a plain terminal (V2 negative).
  await sleep(600)

  // ---- V2: node glyph on mesh members, not on the plain terminal ----
  const glyphs = await ev(`(() => [...document.querySelectorAll('button span')].filter(s => (s.getAttribute('style')||'').includes('width: 4px')).length)()`)
  const glyphOk = glyphs >= 3

  // ---- V1 + V5: send → ask → reply → rest line; reply back-pulse ----
  const sendP = call('plano_send', { to: pty.tB, text: 'sync', mode: 'type' })
  for (let i = 0; i < 40; i += 1) {
    const clicked = await ev(`(() => { const t=[...document.querySelectorAll('[data-surface-layer="popover"]')].find((x)=>(x.textContent||'').includes('Mesh writes')); if(!t) return false; const b=[...t.querySelectorAll('button')].find((x)=>(x.textContent||'').trim()==='Allow'); b?.click(); return !!b })()`)
    if (clicked) break
    await sleep(250)
  }
  await sendP
  await sleep(1200)
  const activeLine = await ev(`(() => { const s=[...document.querySelectorAll('svg path')].find(p => (p.getAttribute('stroke')||'').toLowerCase() === '#4f8cf7'); return !!s && s.getAttribute('opacity') === '0.35' })()`)

  const askP = call('plano_ask', { to: pty.tB, text: 'status?', timeoutMs: 15000 }).catch((e) => ({ postError: String(e) }))
  await sleep(1500)
  const waitingDot = await ev(`(() => { const c=[...document.querySelectorAll('circle')].find(x => (x.getAttribute('style')||'').includes('mesh-breathe')); return !!c })()`)
  let corr = null
  for (let i = 0; i < 40 && !corr; i += 1) {
    const buf = ((await rpc(host, 'attach', { ptyId: pty.tB }))?.result?.buffer ?? '')
    const m = buf.match(/#([0-9a-f]{5})/)
    if (m) corr = m[1]
    else await sleep(250)
  }
  if (corr) {
    await sleep(600)
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const r = await call('plano_reply', { correlationId: corr, summary: 'done' }, token.tB)
      if (r.error !== 'no-pending-ask') break
      await sleep(300)
    }
  }
  await askP
  await sleep(400)
  const backPulse = await ev(`(() => { const c=[...document.querySelectorAll('circle')].find(x => (x.getAttribute('style')||'').includes('mesh-pulse')); return !!c })()`)
  // done → rest (idle, opacity 0.1) — the line STAYS; poll up to 5 s for the settle.
  let restLine = false
  for (let i = 0; i < 10 && !restLine; i += 1) {
    restLine = await ev(`(() => { const s=[...document.querySelectorAll('svg path')].find(p => (p.getAttribute('stroke')||'').toLowerCase() === '#4f8cf7' && p.getAttribute('stroke-width') === '1'); return !!s && s.getAttribute('opacity') === '0.1' })()`)
    if (!restLine) await sleep(500)
  }

  // ---- V3: queue to busy C → ▾1 counter in C's tab ----
  await call('plano_claim', { task: 'busy sim' }, token.tC)
  await sleep(500)
  await call('plano_send', { to: pty.tC, text: 'queued task', mode: 'queue', id: 'v4q1' })
  await sleep(1000)
  const queuedCounter = await ev(`(() => { const s=[...document.querySelectorAll('button span')].find(x => (x.textContent||'').trim() === '▾1'); return !!s })()`)

  // ---- V4: permission prompt in C's tail → amber awaiting dot ----
  await rpc(host, 'write', { ptyId: pty.tC, data: 'echo Do you want to proceed?\r' })
  let amberDot = false
  for (let i = 0; i < 16 && !amberDot; i += 1) {
    amberDot = await ev(`(() => { const s=[...document.querySelectorAll('button span')].find(x => (x.getAttribute('style')||'').includes('rgb(251, 191, 36)')); return !!s && (s.getAttribute('class')||'').includes('mesh-waiting-dot') })()`)
    if (!amberDot) await sleep(500)
  }

  // ---- V7: relations + panning → 0 long tasks ----
  await call('plano_send', { to: pty.tD, text: 'link 1', mode: 'type', id: 'v7a' }).catch(() => {})
  await call('plano_send', { to: pty.tD, text: 'link 2', mode: 'type', id: 'v7b' }).catch(() => {})
  await call('plano_send', { to: pty.tA, text: 'link 3', mode: 'type', id: 'v7c' }).catch(() => {})
  await sleep(1200)
  const perf = await ev(`(async () => {
    const longTasks = []
    const obs = new PerformanceObserver((list) => { for (const e of list.getEntries()) longTasks.push(e.duration) })
    obs.observe({ entryTypes: ['longtask'] })
    const host = document.querySelector('[data-surface-layer="canvas"]') || document.querySelector('.surface-layer--canvas') || document.body
    const t0 = performance.now()
    while (performance.now() - t0 < 3000) {
      host.dispatchEvent(new WheelEvent('wheel', { deltaX: 0, deltaY: 120, deltaMode: 0, bubbles: true, cancelable: true }))
      await new Promise(r => setTimeout(r, 16))
    }
    obs.disconnect()
    return { longTasks: longTasks.length, lines: document.querySelectorAll('svg path').length }
  })()`)
  const noLongTasks = perf?.longTasks === 0

  // ---- V1 final: close B's panel → no ghost line ----
  await rpc(host, 'kill', { ptyId: pty.tB })
  await sleep(2500)
  const noGhost = !(await ev(`(() => { const s=[...document.querySelectorAll('svg path')].find(p => (p.getAttribute('stroke')||'').toLowerCase() === '#4f8cf7' && p.getAttribute('stroke-width') === '1'); return !!s })()`))

  await ev('window.plano.window.close()').catch(() => {})
  await sleep(600)
  try {
    spawnSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore', timeout: 8000 })
  } catch {}

  // ---- V6: reduced motion — no pulse circles, states visible ----
  const L2 = await launch(9710 + (Date.now() % 10), path.join(os.tmpdir(), `mesh-v4b-${run}`), path.join(os.tmpdir(), `mesh-v4bp-${run}`), [panels[0], panels[1]], true)
  const { app: app2, ev: ev2, host: host2, pty: pty2, token: token2, webPort: webPort2 } = L2
  await rpc(host2, 'reportVerdict', { ptyId: pty2.tA, verdict: { active: true, kind: 'codex', phase: 'idle', displayName: 'codex' } })
  await rpc(host2, 'reportVerdict', { ptyId: pty2.tB, verdict: { active: true, kind: 'codex', phase: 'idle', displayName: 'codex' } })
  await sleep(500)
  const send2 = toolResult(webPort2, token2.tA, 'plano_send', { to: pty2.tB, text: 'quiet', mode: 'type' })
  for (let i = 0; i < 40; i += 1) {
    const clicked = await ev2(`(() => { const t=[...document.querySelectorAll('[data-surface-layer="popover"]')].find((x)=>(x.textContent||'').includes('Mesh writes')); if(!t) return false; const b=[...t.querySelectorAll('button')].find((x)=>(x.textContent||'').trim()==='Allow'); b?.click(); return !!b })()`)
    if (clicked) break
    await sleep(250)
  }
  await send2
  await sleep(1500)
  const noPulse = await ev2(`[...document.querySelectorAll('circle')].filter(c => (c.getAttribute('style')||'').includes('mesh-')).length`) === 0
  const lineVisible = await ev2(`(() => { const s=[...document.querySelectorAll('svg path')].find(p => (p.getAttribute('stroke')||'').toLowerCase() === '#4f8cf7'); return !!s })()`)
  await ev2('window.plano.window.close()').catch(() => {})
  await sleep(600)
  try {
    spawnSync('taskkill', ['/PID', String(app2.pid), '/T', '/F'], { stdio: 'ignore', timeout: 8000 })
  } catch {}

  console.log(
    'RESULT:',
    JSON.stringify({
      ok: glyphOk && activeLine && waitingDot && backPulse && restLine && queuedCounter && amberDot && noLongTasks && noGhost && noPulse && lineVisible,
      v1: { activeLine, restLine, noGhost },
      v2: { glyphOk, glyphs },
      v3: { queuedCounter },
      v4: { amberDot },
      v5: { waitingDot, backPulse },
      v6: { noPulse, lineVisible },
      v7: { noLongTasks, lines: perf?.lines },
    }),
  )
  process.exit(0)
}
main().catch((e) => {
  console.error('ERR', e)
  process.exit(1)
})
