// Plan AGENT_MESH_V4 chaining probes C4-C10:
//   C4 death: kill the armed agent → chain 'failed' peer-exited, never fires.
//   C5 restart: arm, kill the app (daemon restarts), A finishes after → still fires (persisted).
//   C6 empty payload: no payload at finish → 'failed' empty-payload, nothing delivered.
//   C7 file: payload { file } → B receives the path (readable).
//   C8 cancel: plano_cancel_chain → never fires.
//   C9 loops: hops >= cap → 'too-many-hops' at arm time.
//   C10 consent: without consent the fire waits for the toast; Deny → failed consent-denied.
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
async function launch(UD, PRJ, port, panels) {
  fs.mkdirSync(UD, { recursive: true })
  fs.mkdirSync(PRJ, { recursive: true })
  fs.writeFileSync(path.join(PRJ, 'package.json'), '{}')
  fs.writeFileSync(
    path.join(UD, 'workspaces.json'),
    JSON.stringify({ schemaVersion: 1, savedAt: new Date().toISOString(), activeId: 's1', workspaces: [{ id: 's1', name: 'S', folderPath: PRJ, viewport: { x: 0, y: 0, zoom: 1 }, regions: [], panels }] }),
  )
  fs.writeFileSync(path.join(UD, 'session.json'), JSON.stringify({ folderPath: PRJ }))
  fs.writeFileSync(path.join(UD, 'settings.json'), JSON.stringify(SETTINGS))
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
  return { app, ev, host, pty, token, webPort }
}
async function chainStatus(call, id) {
  const r = await call('plano_chains', {})
  return (r.chains ?? []).find((c) => c.id === id) ?? null
}
async function waitStatus(call, id, target, tries = 25) {
  let s = null
  for (let i = 0; i < tries; i += 1) {
    s = await chainStatus(call, id)
    if (s?.status === target) return s
    await sleep(500)
  }
  return s
}
async function main() {
  const run = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  const UD = path.join(os.tmpdir(), `mesh-v4d-${run}`)
  const PRJ = path.join(os.tmpdir(), `mesh-v4dp-${run}`)
  const mkPanels = (ids) => ids.map((id, i) => ({ id, type: 'terminal', rect: { x: 60 + (i % 3) * 480, y: 80 + Math.floor(i / 3) * 380, width: 440, height: 320 }, z: 1, title: id, props: { folderPath: PRJ, command: '' } }))

  // ── Phase 1: C4, C6, C7, C8, C9 + arm the C5 survivor ----
  const L = await launch(UD, PRJ, 9730 + (Date.now() % 12), mkPanels(['tA', 'tB', 'tC']))
  let { app, ev, host, pty, token, webPort } = L
  for (const p of [pty.tA, pty.tB, pty.tC]) {
    await rpc(host, 'reportVerdict', { ptyId: p, verdict: { active: true, kind: 'codex', phase: 'idle', displayName: 'codex' } })
  }
  await sleep(500)
  const call = (name, args, t = token.tA) => toolResult(webPort, t, name, args)

  // C9: loops cut at arm time.
  const c9 = await call('plano_chain', { to: pty.tB, payload: 'loop', when: 'i-finish', hops: 4 })
  const c9ok = c9.error === 'too-many-hops'

  // C4: C arms, then dies → failed peer-exited.
  const c4 = await call('plano_chain', { to: pty.tB, payload: 'doomed', when: 'i-finish' }, token.tC)
  await rpc(host, 'kill', { ptyId: pty.tC })
  const c4s = await waitStatus((name, a) => toolResult(webPort, token.tA, name, a), c4.chainId, 'failed')
  const c4ok = c4s?.status === 'failed' && c4s?.failReason === 'peer-exited'

  // C6: no payload at finish → empty-payload.
  const c6 = await call('plano_chain', { to: pty.tB, when: 'i-finish' })
  const c6s = await waitStatus(call, c6.chainId, 'failed', 30)
  const c6ok = c6s?.status === 'failed' && c6s?.failReason === 'empty-payload'
  const c6delivered = ((await rpc(host, 'attach', { ptyId: pty.tB }))?.result?.buffer ?? '').includes('(inferred')
  console.log('PHASE1-done')

  // C7: file payload → B receives the path.
  const planFile = path.join(PRJ, 'plan.md')
  fs.writeFileSync(planFile, '# Plan\nstep 1\n')
  const c7 = await call('plano_chain', { to: pty.tB, payload: { file: planFile }, when: 'i-finish' })
  // First fire needs consent → Allow.
  for (let i = 0; i < 40; i += 1) {
    const clicked = await ev(`(() => { const t=[...document.querySelectorAll('[data-surface-layer="popover"]')].find((x)=>(x.textContent||'').includes('Mesh writes')); if(!t) return false; const b=[...t.querySelectorAll('button')].find((x)=>(x.textContent||'').trim()==='Allow'); b?.click(); return !!b })()`)
    if (clicked) break
    await sleep(250)
  }
  const c7s = await waitStatus(call, c7.chainId, 'fired', 20)
  // typed char-by-char — poll the echo into B's buffer.
  let c7buf = ''
  for (let i = 0; i < 12 && !c7buf.includes(planFile); i += 1) {
    c7buf = ((await rpc(host, 'attach', { ptyId: pty.tB }))?.result?.buffer ?? '')
    if (!c7buf.includes(planFile)) await sleep(400)
  }
  const c7ok = c7s?.status === 'fired' && c7buf.includes(planFile)

  // C8: cancel → never fires.
  const c8 = await call('plano_chain', { to: pty.tB, payload: 'cancelled task', when: 'i-finish' })
  const c8c = await call('plano_cancel_chain', { chainId: c8.chainId })
  await sleep(6000) // A is stably idle — would fire if not cancelled
  const c8s = await chainStatus(call, c8.chainId)
  const c8ok = c8c.ok === true && c8s?.status === 'cancelled' && !((await rpc(host, 'attach', { ptyId: pty.tB }))?.result?.buffer ?? '').includes('cancelled task')
  console.log('PHASE1-c8-done')

  // C5: arm the survivor, then kill the app (daemon restarts).
  const c5 = await call('plano_chain', { to: pty.tB, payload: 'survivor task', when: 'i-finish' })
  const c5id = c5.chainId
  console.log('PHASE1-c5-armed')
  await ev('window.plano.window.close()').catch(() => {})
  await sleep(600)
  try {
    spawnSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore', timeout: 8000 })
  } catch {}

  // ── Phase 2 (C5): restart with the same user-data → chains.json reloaded → fires ----
  await sleep(2000)
  const L2 = await launch(UD, PRJ, 9745 + (Date.now() % 10), mkPanels(['tA', 'tB', 'tC']))
  ;({ app, ev, host, pty, token, webPort } = L2)
  for (const p of [pty.tA, pty.tB]) {
    await rpc(host, 'reportVerdict', { ptyId: p, verdict: { active: true, kind: 'codex', phase: 'idle', displayName: 'codex' } })
  }
  await sleep(500)
  const call2 = (name, args, t = token.tA) => toolResult(webPort, t, name, args)
  let c5fired = false
  for (let i = 0; i < 25 && !c5fired; i += 1) {
    const buf = ((await rpc(host, 'attach', { ptyId: pty.tB }))?.result?.buffer ?? '')
    if (buf.includes('survivor task')) c5fired = true
    else await sleep(500)
  }
  const c5s = await chainStatus(call2, c5id)
  const c5ok = c5fired && c5s?.status === 'fired'
  await ev('window.plano.window.close()').catch(() => {})
  await sleep(600)
  try {
    spawnSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore', timeout: 8000 })
  } catch {}

  // ── Phase 3 (C10): fresh workspace without consent → fire waits, Deny fails it ----
  const UD3 = path.join(os.tmpdir(), `mesh-v4e-${run}`)
  const PRJ3 = path.join(os.tmpdir(), `mesh-v4ep-${run}`)
  const L3 = await launch(UD3, PRJ3, 9755 + (Date.now() % 10), mkPanels(['tA', 'tB']))
  const { app: app3, ev: ev3, pty: pty3, token: token3, webPort: webPort3 } = L3
  await rpc(L3.host, 'reportVerdict', { ptyId: pty3.tA, verdict: { active: true, kind: 'codex', phase: 'idle', displayName: 'codex' } })
  await rpc(L3.host, 'reportVerdict', { ptyId: pty3.tB, verdict: { active: true, kind: 'codex', phase: 'idle', displayName: 'codex' } })
  await sleep(500)
  const call3 = (name, args, t = token3.tA) => toolResult(webPort3, t, name, args)
  const c10 = await call3('plano_chain', { to: pty3.tB, payload: 'needs consent', when: 'i-finish' })
  // The fire blocks on the consent toast → click Deny.
  let denied = false
  for (let i = 0; i < 40 && !denied; i += 1) {
    const clicked = await ev3(`(() => { const t=[...document.querySelectorAll('[data-surface-layer="popover"]')].find((x)=>(x.textContent||'').includes('Mesh writes')); if(!t) return false; const b=[...t.querySelectorAll('button')].find((x)=>(x.textContent||'').trim()==='Deny'); b?.click(); return !!b })()`)
    if (clicked) denied = true
    else await sleep(250)
  }
  const c10s = await waitStatus(call3, c10.chainId, 'failed', 15)
  const c10ok = denied && c10s?.status === 'failed' && c10s?.failReason === 'consent-denied' && !((await rpc(L3.host, 'attach', { ptyId: pty3.tB }))?.result?.buffer ?? '').includes('needs consent')
  await ev3('window.plano.window.close()').catch(() => {})
  await sleep(600)
  try {
    spawnSync('taskkill', ['/PID', String(app3.pid), '/T', '/F'], { stdio: 'ignore', timeout: 8000 })
  } catch {}

  console.log(
    'RESULT:',
    JSON.stringify({
      ok: c9ok && c4ok && c6ok && !c6delivered && c7ok && c8ok && c5ok && c10ok,
      c4: { status: c4s?.status, failReason: c4s?.failReason },
      c5: { fired: c5fired, status: c5s?.status },
      c6: { status: c6s?.status, failReason: c6s?.failReason, delivered: c6delivered },
      c7: { status: c7s?.status, pathDelivered: c7ok },
      c8: { status: c8s?.status },
      c9: { error: c9.error },
      c10: { denied, status: c10s?.status, failReason: c10s?.failReason },
    }),
  )
  process.exit(0)
}
main().catch((e) => {
  console.error('ERR', e)
  process.exit(1)
})
