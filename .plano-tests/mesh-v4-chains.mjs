// Plan AGENT_MESH_V4 chaining probes C1-C3:
//   C1 happy: A arms when:'i-finish' with an explicit payload → A is stably idle → fires
//             ONCE → B's buffer contains the payload exactly once; chain status 'fired'.
//   C2 false idle: A arms, then produces output every ~1 s → the chain must NOT fire while
//             content keeps changing; after 6 s it is still 'armed'.
//   C3 blocked: A stays awaiting-input (permission prompt) → never fires; with a short
//             timeout it expires (onFailure: notify) instead of firing a half plan.
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
  const UD = path.join(os.tmpdir(), `mesh-v4c-${run}`)
  const PRJ = path.join(os.tmpdir(), `mesh-v4cp-${run}`)
  fs.mkdirSync(UD, { recursive: true })
  fs.mkdirSync(PRJ, { recursive: true })
  fs.writeFileSync(path.join(PRJ, 'package.json'), '{}')
  const panels = ['tA', 'tB'].map((id, i) => ({ id, type: 'terminal', rect: { x: 60 + i * 500, y: 80, width: 440, height: 320 }, z: 1, title: id, props: { folderPath: PRJ, command: '' } }))
  fs.writeFileSync(
    path.join(UD, 'workspaces.json'),
    JSON.stringify({ schemaVersion: 1, savedAt: new Date().toISOString(), activeId: 's1', workspaces: [{ id: 's1', name: 'S', folderPath: PRJ, viewport: { x: 0, y: 0, zoom: 1 }, regions: [], panels }] }),
  )
  fs.writeFileSync(path.join(UD, 'session.json'), JSON.stringify({ folderPath: PRJ }))
  fs.writeFileSync(path.join(UD, 'settings.json'), JSON.stringify(SETTINGS))
  const port = 9720 + (Date.now() % 15)
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
  for (let i = 0; i < 60; i += 1) {
    const n = (await ev(`document.querySelectorAll('.xterm').length`)) || 0
    if (n >= 2) break
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
  const ptyA = sessions.find((s) => s.panelId === 'tA')?.ptyId ?? sessions[0]?.ptyId
  const ptyB = sessions.find((s) => s.panelId === 'tB')?.ptyId ?? sessions[1]?.ptyId
  const webPort = hello?.webPort ?? host.webPort
  const secret = fs.readFileSync(path.join(UD, 'mesh', 'master-secret'), 'utf8').trim()
  const tokenA = createHmac('sha256', secret).update(ptyA).digest('hex')
  await rpc(host, 'reportVerdict', { ptyId: ptyA, verdict: { active: true, kind: 'codex', phase: 'idle', displayName: 'codex' } })
  await rpc(host, 'reportVerdict', { ptyId: ptyB, verdict: { active: true, kind: 'codex', phase: 'idle', displayName: 'codex' } })
  await sleep(500)
  const call = (name, args, t = tokenA) => toolResult(webPort, t, name, args)

  // ---- C1: happy path — fire once ----
  const chainRes = await call('plano_chain', { to: ptyB, payload: 'run the tests now', when: 'i-finish' })
  const chainId = chainRes.chainId
  // Firing is a write → consent toast; click Allow when it appears.
  for (let i = 0; i < 40; i += 1) {
    const clicked = await ev(`(() => { const t=[...document.querySelectorAll('[data-surface-layer="popover"]')].find((x)=>(x.textContent||'').includes('Mesh writes')); if(!t) return false; const b=[...t.querySelectorAll('button')].find((x)=>(x.textContent||'').trim()==='Allow'); b?.click(); return !!b })()`)
    if (clicked) break
    await sleep(250)
  }
  let fired = false
  let occurrences = 0
  for (let i = 0; i < 30 && !fired; i += 1) {
    const buf = ((await rpc(host, 'attach', { ptyId: ptyB }))?.result?.buffer ?? '')
    occurrences = buf.split('run the tests now').length - 1
    if (occurrences >= 1) fired = true
    else await sleep(500)
  }
  await sleep(1500)
  const bufB = ((await rpc(host, 'attach', { ptyId: ptyB }))?.result?.buffer ?? '')
  const finalCount = bufB.split('run the tests now').length - 1
  const chains1 = await call('plano_chains', {})
  const c1 = (chains1.chains ?? []).find((c) => c.id === chainId)

  // ---- C2: false idle — keep A's content changing every ~1 s ----
  const chain2 = await call('plano_chain', { to: ptyB, payload: 'false idle payload', when: 'i-finish' })
  let stillArmed = true
  for (let i = 0; i < 6; i += 1) {
    await rpc(host, 'write', { ptyId: ptyA, data: `echo tick${i}\r` })
    const chains2 = await call('plano_chains', {})
    stillArmed = (chains2.chains ?? []).find((c) => c.id === chain2.chainId)?.status === 'armed'
    if (!stillArmed) break
    await sleep(1000)
  }

  // ---- C3: awaiting-input never counts as finished; short timeout expires it ----
  const chain3 = await call('plano_chain', { to: ptyB, payload: 'half plan', when: 'i-finish', timeoutMs: 6000, onFailure: 'notify' })
  // La guarda de awaiting-input SOLO se evalúa en terminales con agente detectado o reclamadas
  // manualmente (daemon/index.ts: un shell plano se fuerza a idle). Con un `cmd` pelado el caso
  // era inalcanzable, y antes solo "pasaba" porque el consentimiento se colgaba y la cadena
  // caducaba. Reclamar primero lo hace alcanzable; `set /p` bloquea de verdad esperando entrada,
  // así que la cola termina en la pregunta — igual que un agente pidiendo permiso.
  await call('plano_claim', { task: 'blocked on permission' })
  await rpc(host, 'write', { ptyId: ptyA, data: 'set /p ok=Do you want to proceed? \r' })
  let c3status = 'armed'
  for (let i = 0; i < 20 && c3status === 'armed'; i += 1) {
    const chains3 = await call('plano_chains', {})
    c3status = (chains3.chains ?? []).find((c) => c.id === chain3.chainId)?.status ?? 'gone'
    if (c3status === 'armed') await sleep(700)
  }
  const chains3f = await call('plano_chains', {})
  const c3 = (chains3f.chains ?? []).find((c) => c.id === chain3.chainId)
  const bufB3 = ((await rpc(host, 'attach', { ptyId: ptyB }))?.result?.buffer ?? '')
  const c3Delivered = bufB3.includes('half plan')

  console.log(
    'RESULT:',
    JSON.stringify({
      ok: chainRes.ok && chainId && c1?.status === 'fired' && finalCount === 1 && stillArmed && c3status !== 'fired' && !c3Delivered && (c3?.status === 'expired' || c3?.status === 'failed'),
      c1: { armed: chainRes.ok, status: c1?.status, occurrences: finalCount },
      c2: { stillArmedAfter6s: stillArmed, id: chain2.chainId?.slice(0, 8) },
      c3: { status: c3?.status, failReason: c3?.failReason, delivered: c3Delivered },
    }),
  )
  await ev('window.plano.window.close()').catch(() => {})
  await sleep(600)
  try {
    spawnSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore', timeout: 8000 })
  } catch {}
  process.exit(0)
}
main().catch((e) => {
  console.error('ERR', e)
  process.exit(1)
})
