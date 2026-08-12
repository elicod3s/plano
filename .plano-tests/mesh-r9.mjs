// Plan AGENT_MESH_V3 R9: chaos.
//   R9a: A asks B (idle cmd, echo visible), B dies mid-ask → peer-exited, never a hang.
//   R9b: A queues a message to C while C is busy (claim) → queued; replay same id →
//        already-queued; C dies → msg-undeliverable peer-exited on the timeline and the
//        persisted mailbox drops it (no re-delivery after restart).
//   R9c: replaying a delivered messageId → already-delivered, no duplicate.
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
    req.setTimeout(25000, () => req.destroy(new Error('http timeout')))
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
  const UD = path.join(os.tmpdir(), `mesh-r9-${run}`)
  const PRJ = path.join(os.tmpdir(), `mesh-r9p-${run}`)
  fs.mkdirSync(UD, { recursive: true })
  fs.mkdirSync(PRJ, { recursive: true })
  fs.writeFileSync(path.join(PRJ, 'package.json'), '{}')
  const panels = ['tA', 'tB', 'tC'].map((id, i) => ({ id, type: 'terminal', rect: { x: 60 + i * 480, y: 80, width: 420, height: 300 }, z: 1, title: id, props: { folderPath: PRJ, command: '' } }))
  fs.writeFileSync(
    path.join(UD, 'workspaces.json'),
    JSON.stringify({ schemaVersion: 1, savedAt: new Date().toISOString(), activeId: 's1', workspaces: [{ id: 's1', name: 'S', folderPath: PRJ, viewport: { x: 0, y: 0, zoom: 1 }, regions: [], panels }] }),
  )
  fs.writeFileSync(path.join(UD, 'session.json'), JSON.stringify({ folderPath: PRJ }))
  fs.writeFileSync(path.join(UD, 'settings.json'), JSON.stringify(SETTINGS))
  const port = 9705 + (Date.now() % 15)
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
  const tokenC = createHmac('sha256', secret).update(ptyC).digest('hex')
  for (const p of [ptyA, ptyB, ptyC]) {
    await rpc(host, 'reportVerdict', { ptyId: p, verdict: { active: true, kind: 'codex', phase: 'idle', displayName: 'codex' } })
  }
  await sleep(500)
  const call = (name, args, token = tokenA) => toolResult(webPort, token, name, args)

  // R9a: ask to idle B, kill mid-ask → peer-exited, no hang.
  const askP = call('plano_ask', { to: ptyB, text: 'long task?', timeoutMs: 20000 }).catch((e) => ({ postError: String(e) }))
  for (let i = 0; i < 40; i += 1) {
    const clicked = await ev(`(() => { const t=[...document.querySelectorAll('[data-surface-layer="popover"]')].find((x)=>(x.textContent||'').includes('Mesh writes')); if(!t) return false; const b=[...t.querySelectorAll('button')].find((x)=>(x.textContent||'').trim()==='Allow'); b?.click(); return !!b })()`)
    if (clicked) break
    await sleep(250)
  }
  let corr = null
  for (let i = 0; i < 40 && !corr; i += 1) {
    const buf = ((await rpc(host, 'attach', { ptyId: ptyB }))?.result?.buffer ?? '')
    const m = buf.match(/#([0-9a-f]{5})/)
    if (m) corr = m[1]
    else await sleep(250)
  }
  await sleep(2500) // let the ask finish typing and register its pending correlation
  const killRes = await rpc(host, 'kill', { ptyId: ptyB })
  const t0 = Date.now()
  const askResult = await askP
  const askMs = Date.now() - t0
  const peerExited = askResult.error === 'peer-exited'
  const rosterAfter = await call('plano_roster', {})
  console.log('KILL:', JSON.stringify({ killOk: killRes?.result?.ok, corr, ask: askResult, askMs, bGone: !(rosterAfter.agents ?? []).some((a) => a.id === ptyB) }))

  // R9b: C claims (busy) → queue 'dup-1' → queued; replay → already-queued; kill C → undeliverable.
  await call('plano_claim', { task: 'busy simulation' }, tokenC)
  await sleep(400)
  const queued = await call('plano_send', { to: ptyC, text: 'doomed message', mode: 'queue', id: 'dup-1' })
  const replayWhileQueued = await call('plano_send', { to: ptyC, text: 'doomed message', mode: 'queue', id: 'dup-1' })
  await rpc(host, 'kill', { ptyId: ptyC })
  let undeliverableSeen = false
  for (let i = 0; i < 20 && !undeliverableSeen; i += 1) {
    const tl = await call('plano_timeline', {})
    undeliverableSeen = (tl.events ?? []).some((e) => e.kind === 'msg-undeliverable' && e.to === ptyC)
    if (!undeliverableSeen) await sleep(400)
  }
  await sleep(800)
  let mailboxDropped = true
  try {
    const file = fs.readdirSync(path.join(UD, 'mesh')).find((f) => f.includes('inbox-') && f.includes(ptyC))
    if (file) {
      const content = fs.readFileSync(path.join(UD, 'mesh', file), 'utf8')
      mailboxDropped = !content.includes('doomed message')
    }
  } catch {
    mailboxDropped = true
  }

  // R9c: replay a delivered id → already-delivered.
  const dlv = await call('plano_send', { to: ptyA, text: 'ping', mode: 'type', id: 'dup-3' })
  const replayDlv = dlv.status === 'delivered' || dlv.status === 'confirmed' ? await call('plano_send', { to: ptyA, text: 'ping', mode: 'type', id: 'dup-3' }) : null

  console.log(
    'RESULT:',
    JSON.stringify({
      ok: peerExited && queued.status === 'queued' && replayWhileQueued.status === 'already-queued' && undeliverableSeen && mailboxDropped && (replayDlv?.status === 'already-delivered' || dlv.status !== 'delivered' && dlv.status !== 'confirmed'),
      r9a: { peerExited, askMs, corrFound: !!corr },
      r9b: { queued: queued.status, queuedErr: queued.error, replay: replayWhileQueued.status, undeliverableSeen, mailboxDropped },
      r9c: { firstStatus: dlv.status, replayStatus: replayDlv?.status ?? null, replayError: replayDlv?.error ?? null },
      kill: { ok: killRes?.result?.ok },
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
