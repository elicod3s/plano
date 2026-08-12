// Plan AGENT_MESH_V3 R7: agent control. On a codex target (simulated by a cmd + verdict):
//   - 'gpt-5; rm -rf /'           → invalid-model (injection guard)
//   - 'claude-sonnet-4-5'          → unknown-model (wrong family for codex)
//   - 'gpt-5'                      → ok, verified by tail (the /model echo lands)
//   - compact on codex             → unsupported-harness
// On an opencode target: set_model → unsupported-harness; interrupt → interrupt-sent.
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
  const UD = path.join(os.tmpdir(), `mesh-r7-${run}`)
  const PRJ = path.join(os.tmpdir(), `mesh-r7p-${run}`)
  fs.mkdirSync(UD, { recursive: true })
  fs.mkdirSync(PRJ, { recursive: true })
  fs.writeFileSync(path.join(PRJ, 'package.json'), '{}')
  const panels = ['tA', 'tB', 'tC'].map((id, i) => ({ id, type: 'terminal', rect: { x: 60 + i * 460, y: 80, width: 420, height: 300 }, z: 1, title: id, props: { folderPath: PRJ, command: '' } }))
  fs.writeFileSync(
    path.join(UD, 'workspaces.json'),
    JSON.stringify({ schemaVersion: 1, savedAt: new Date().toISOString(), activeId: 's1', workspaces: [{ id: 's1', name: 'S', folderPath: PRJ, viewport: { x: 0, y: 0, zoom: 1 }, regions: [], panels }] }),
  )
  fs.writeFileSync(path.join(UD, 'session.json'), JSON.stringify({ folderPath: PRJ }))
  fs.writeFileSync(path.join(UD, 'settings.json'), JSON.stringify(SETTINGS))
  const port = 9680 + (Date.now() % 15)
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
    if (n >= 3) break
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
  await rpc(host, 'reportVerdict', { ptyId: ptyA, verdict: { active: true, kind: 'codex', phase: 'idle', displayName: 'codex' } })
  await rpc(host, 'reportVerdict', { ptyId: ptyB, verdict: { active: true, kind: 'codex', phase: 'idle', displayName: 'codex' } })
  await rpc(host, 'reportVerdict', { ptyId: ptyC, verdict: { active: true, kind: 'opencode', phase: 'idle', displayName: 'opencode' } })
  await sleep(500)

  const call = (name, args) => toolResult(webPort, tokenA, name, args)
  // First write blocks on consent → Allow.
  const first = call('plano_set_model', { agentId: ptyB, model: 'gpt-5' })
  for (let i = 0; i < 40; i += 1) {
    const clicked = await ev(`(() => { const t=[...document.querySelectorAll('[data-surface-layer="popover"]')].find((x)=>(x.textContent||'').includes('Mesh writes')); if(!t) return false; const b=[...t.querySelectorAll('button')].find((x)=>(x.textContent||'').trim()==='Allow'); b?.click(); return !!b })()`)
    if (clicked) break
    await sleep(250)
  }
  const firstResult = await first

  const inject = await call('plano_set_model', { agentId: ptyB, model: 'gpt-5; rm -rf /' })
  const wrongFamily = await call('plano_set_model', { agentId: ptyB, model: 'claude-sonnet-4-5' })
  const good = await call('plano_set_model', { agentId: ptyB, model: 'gpt-5' })
  const compactCodex = await call('plano_compact', { agentId: ptyB })
  const setModelOpencode = await call('plano_set_model', { agentId: ptyC, model: 'gpt-5' })
  const interruptOpencode = await call('plano_interrupt', { agentId: ptyC })

  console.log(
    'RESULT:',
    JSON.stringify({
      ok: inject.error === 'invalid-model' && wrongFamily.error === 'unknown-model' && good.ok === true && good.status === 'verified' && compactCodex.error === 'unsupported-harness' && setModelOpencode.error === 'unsupported-harness' && interruptOpencode.ok === true,
      inject: { error: inject.error },
      wrongFamily: { error: wrongFamily.error },
      good: { ok: good.ok, status: good.status, error: good.error },
      compactCodex: { error: compactCodex.error },
      setModelOpencode: { error: setModelOpencode.error },
      interruptOpencode: { ok: interruptOpencode.ok, error: interruptOpencode.error },
      firstResult: { ok: firstResult.ok, status: firstResult.status, error: firstResult.error },
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
