// Plan AGENT_MESH_V3 R8 + R10: persistent links in the renderer DOM.
//   R8:  send A→B → one persistent active line (path, opacity 0.35) → ask → waiting dot →
//        reply → done → line fades away (gone after ~2.5 s) → new send → kill the target
//        panel → no ghost line.
//   R10: 6 agents with active links while panning → zero long tasks, line count stable.
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
    http
      .get(`http://127.0.0.1:${port}${p}`, (r) => {
        let d = ''
        r.on('data', (c) => (d += c))
        r.on('end', () => res(JSON.parse(d)))
      })
      .on('error', rej)
  })
const SETTINGS = {
  version: 11,
  general: { restoreLastWorkspace: true, restoreAgentSessions: false, showFilesOnLaunch: false, warnBeforeQuit: false, confirmClosePanelWithProcess: false, agentDoneSound: false },
  appearance: { theme: 'monolith', accent: '#FFFFFF', gridStyle: 'none', gridOpacity: 1, reduceMotion: false, canvasBackground: { kind: 'theme', colors: ['#141414', '#1d1d2b'], angle: 135 }, canvasGlow: 0, gridSize: 'standard' },
  editor: { fontSize: 13, tabSize: 2, wordWrap: true, lineNumbers: true },
  terminal: { shell: 'cmd' },
  canvas: { snapToGrid: true, showMinimap: false, zoomSensitivity: 1, autosave: true },
  browser: {},
  privacy: { telemetry: false, saveTerminalHistory: true },
  advanced: { hardwareAcceleration: true },
  agentMesh: { contextPersistence: false, maxPersistBytes: 524288 },
  voice: { enabled: false },
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
async function main() {
  const run = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  const UD = path.join(os.tmpdir(), `mesh-r8-${run}`)
  const PRJ = path.join(os.tmpdir(), `mesh-r8p-${run}`)
  fs.mkdirSync(UD, { recursive: true })
  fs.mkdirSync(PRJ, { recursive: true })
  fs.writeFileSync(path.join(PRJ, 'package.json'), '{}')
  const panels = ['tA', 'tB', 'tC', 'tD', 'tE', 'tF'].map((id, i) => ({ id, type: 'terminal', rect: { x: 60 + (i % 3) * 480, y: 80 + Math.floor(i / 3) * 380, width: 420, height: 300 }, z: 1, title: id, props: { folderPath: PRJ, command: '' } }))
  fs.writeFileSync(
    path.join(UD, 'workspaces.json'),
    JSON.stringify({ schemaVersion: 1, savedAt: new Date().toISOString(), activeId: 's1', workspaces: [{ id: 's1', name: 'S', folderPath: PRJ, viewport: { x: 0, y: 0, zoom: 1 }, regions: [], panels }] }),
  )
  fs.writeFileSync(path.join(UD, 'session.json'), JSON.stringify({ folderPath: PRJ }))
  fs.writeFileSync(path.join(UD, 'settings.json'), JSON.stringify(SETTINGS))
  const port = 9690 + (Date.now() % 15)
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
    if (n >= 6) break
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
  const ptyA = byPanel('tA') ?? sessions[0]?.ptyId
  const ptyB = byPanel('tB') ?? sessions[1]?.ptyId
  const ptyC = byPanel('tC') ?? sessions[2]?.ptyId
  const webPort = hello?.webPort ?? host.webPort
  const secret = fs.readFileSync(path.join(UD, 'mesh', 'master-secret'), 'utf8').trim()
  const tokenA = createHmac('sha256', secret).update(ptyA).digest('hex')
  const tokenB = createHmac('sha256', secret).update(ptyB).digest('hex')
  for (const [p, kind] of [[ptyA, 'codex'], [ptyB, 'codex'], [ptyC, 'codex']]) {
    await rpc(host, 'reportVerdict', { ptyId: p, verdict: { active: true, kind, phase: 'idle', displayName: kind } })
  }
  await sleep(500)

  const linkCount = () => ev(`document.querySelectorAll('.mesh-link-svg path').length`)
  const hasLine = () => ev(`(() => { const s=[...document.querySelectorAll('svg path')].find(p => (p.getAttribute('stroke')||'').toLowerCase() === '#4f8cf7'); return !!s && s.getAttribute('opacity') === '0.35' })()`)

  // R8a: send A→B → active persistent line.
  const sendP = toolResult(webPort, tokenA, 'plano_send', { to: ptyB, text: 'sync task 1', mode: 'type' })
  for (let i = 0; i < 40; i += 1) {
    const clicked = await ev(`(() => { const t=[...document.querySelectorAll('[data-surface-layer="popover"]')].find((x)=>(x.textContent||'').includes('Mesh writes')); if(!t) return false; const b=[...t.querySelectorAll('button')].find((x)=>(x.textContent||'').trim()==='Allow'); b?.click(); return !!b })()`)
    if (clicked) break
    await sleep(250)
  }
  const sendResult = await sendP
  await sleep(1500)
  const lineActive = await hasLine()
  const dump = await ev(`[...document.querySelectorAll('svg path')].map(p => (p.getAttribute('stroke')||'none').slice(0,14)).join(',')`)
  console.log('R8RAW:', JSON.stringify({ send: sendResult ?? null, dump }))

  // R8b: ask → waiting dot.
  const askP = toolResult(webPort, tokenA, 'plano_ask', { to: ptyB, text: 'status?', timeoutMs: 15000 }).catch((e) => ({ postError: String(e) }))
  await sleep(1500)
  const waitingDot = await ev(`(() => { const c=[...document.querySelectorAll('circle')].find(x => (x.getAttribute('style')||'').includes('mesh-breathe')); return !!c })()`)

  // R8c: reply → done → line disappears.
  let corr = null
  for (let i = 0; i < 40 && !corr; i += 1) {
    const buf = ((await rpc(host, 'attach', { ptyId: ptyB }))?.result?.buffer ?? '')
    const m = buf.match(/#([0-9a-f]{5})/)
    if (m) corr = m[1]
    else await sleep(250)
  }
  if (corr) {
    await sleep(600)
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const r = await toolResult(webPort, tokenB, 'plano_reply', { correlationId: corr, summary: 'all good' })
      if (r.error !== 'no-pending-ask') break
      await sleep(300)
    }
  }
  await askP
  await sleep(2800) // done fade (2.2 s)
  const lineGoneAfterDone = !(await hasLine())

  // R8d: new send → active again → kill target → no ghost line.
  await toolResult(webPort, tokenA, 'plano_send', { to: ptyB, text: 'sync task 2', mode: 'type' })
  await sleep(1500)
  const lineAgain = await hasLine()
  await rpc(host, 'kill', { ptyId: ptyB })
  await sleep(2500)
  const lineGoneAfterKill = !(await hasLine())

  // R10: 6 links + panning → 0 long tasks.
  const pts = [ptyA, ptyB, ptyC]
  const tokenA2 = tokenA
  await rpc(host, 'reportVerdict', { ptyId: ptyA, verdict: { active: true, kind: 'codex', phase: 'idle', displayName: 'codex' } })
  await toolResult(webPort, tokenA2, 'plano_send', { to: ptyC, text: 'perf link', mode: 'type' }).catch(() => {})
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
    return { longTasks, count: document.querySelectorAll('svg path').length }
  })()`)
  const noLongTasks = Array.isArray(perf?.longTasks) && perf.longTasks.length === 0

  console.log(
    'RESULT:',
    JSON.stringify({
      ok: lineActive && waitingDot && lineGoneAfterDone && lineAgain && lineGoneAfterKill && noLongTasks,
      r8: { lineActive, waitingDot, lineGoneAfterDone, lineAgain, lineGoneAfterKill },
      r10: { longTasks: perf?.longTasks ?? null, noLongTasks },
    }),
  )
  await ev('window.plano.window.close()').catch(() => {})
  await sleep(700)
  try {
    spawnSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore', timeout: 8000 })
  } catch {}
  process.exit(0)
}
main().catch((e) => {
  console.error('ERR', e)
  process.exit(1)
})
