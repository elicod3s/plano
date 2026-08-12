// Plan AGENT_MESH_V3 R4 + R5: ask/reply conversation.
//   R4: A asks B; the probe (acting as B with B's token) extracts the #corr from B's buffer
//       and calls plano_reply → A's ask resolves with B's summary, inferred:false.
//   R5: A asks B with a short timeout; nobody replies → A's ask resolves with the inferred
//       tail delta (timeout:true), never a hang.
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
    req.setTimeout(30000, () => req.destroy(new Error('http timeout')))
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
  const UD = path.join(os.tmpdir(), `mesh-r45-${run}`)
  const PRJ = path.join(os.tmpdir(), `mesh-r45p-${run}`)
  fs.mkdirSync(UD, { recursive: true })
  fs.mkdirSync(PRJ, { recursive: true })
  fs.writeFileSync(path.join(PRJ, 'package.json'), '{}')
  fs.writeFileSync(
    path.join(UD, 'workspaces.json'),
    JSON.stringify({
      schemaVersion: 1,
      savedAt: new Date().toISOString(),
      activeId: 's1',
      workspaces: [
        {
          id: 's1',
          name: 'S',
          folderPath: PRJ,
          viewport: { x: 0, y: 0, zoom: 1 },
          regions: [],
          panels: [
            { id: 'tA', type: 'terminal', rect: { x: 60, y: 80, width: 420, height: 300 }, z: 1, title: 'A', props: { folderPath: PRJ, command: '' } },
            { id: 'tB', type: 'terminal', rect: { x: 520, y: 80, width: 420, height: 300 }, z: 1, title: 'B', props: { folderPath: PRJ, command: '' } },
          ],
        },
      ],
    }),
  )
  fs.writeFileSync(path.join(UD, 'session.json'), JSON.stringify({ folderPath: PRJ }))
  fs.writeFileSync(path.join(UD, 'settings.json'), JSON.stringify(SETTINGS))
  const port = 9650 + (Date.now() % 15)
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
  const tokenB = createHmac('sha256', secret).update(ptyB).digest('hex')
  await rpc(host, 'reportVerdict', { ptyId: ptyA, verdict: { active: true, kind: 'codex', phase: 'idle', displayName: 'codex' } })
  await rpc(host, 'reportVerdict', { ptyId: ptyB, verdict: { active: true, kind: 'codex', phase: 'idle', displayName: 'codex' } })
  await sleep(500)

  // ---- R4: ask + reply ----
  console.log('M1 ask-launched')
  const askPromise = toolResult(webPort, tokenA, 'plano_ask', { to: ptyB, text: 'what is 2+2?' }).catch((e) => ({ postError: String(e) }))
  // First mesh write needs the consent toast → Allow.
  for (let i = 0; i < 40; i += 1) {
    const clicked = await ev(`(() => { const t=[...document.querySelectorAll('[data-surface-layer="popover"]')].find((x)=>(x.textContent||'').includes('Mesh writes')); if(!t) return false; const b=[...t.querySelectorAll('button')].find((x)=>(x.textContent||'').trim()==='Allow'); b?.click(); return !!b })()`)
    if (clicked) break
    await sleep(250)
  }
  console.log('M2 allow-loop-done')
  // Acting as B: find the #corr in B's buffer and reply with B's token.
  let corr = null
  for (let i = 0; i < 60 && !corr; i += 1) {
    const buf = ((await rpc(host, 'attach', { ptyId: ptyB }))?.result?.buffer ?? '')
    const m = buf.match(/#([0-9a-f]{5})/)
    if (m) corr = m[1]
    else await sleep(250)
  }
  console.log('M3 corr-found', corr)
  if (!corr) {
    const bufB = ((await rpc(host, 'attach', { ptyId: ptyB }))?.result?.buffer ?? '').slice(-200)
    const roster = await toolResult(webPort, tokenA, 'plano_roster', {})
    console.log('DIAG:', JSON.stringify({ bufB, roster: roster.agents ?? roster.error, askResult: r4 }) )
  }
  let r4 = { noReply: true }
  if (corr) {
    await sleep(600) // let the ask finish typing and register the pending ask
    let reply = { error: 'no-pending-ask' }
    for (let attempt = 0; attempt < 3 && reply.error === 'no-pending-ask'; attempt += 1) {
      reply = await toolResult(webPort, tokenB, 'plano_reply', { correlationId: corr, summary: 'it is 4' })
      if (reply.error === 'no-pending-ask') await sleep(300)
    }
    r4 = await askPromise
    r4.replyStatus = reply.status
    r4.replyError = reply.error
    console.log('R4RAW:', JSON.stringify({ corr, r4, reply }))
  } else {
    r4 = await askPromise
    const bufB = ((await rpc(host, 'attach', { ptyId: ptyB }))?.result?.buffer ?? '').slice(-200)
    const roster = await toolResult(webPort, tokenA, 'plano_roster', {})
    console.log('DIAG:', JSON.stringify({ bufB, roster: roster.agents ?? roster.error, r4 }))
  }

  // ---- R5: ask with timeout, nobody replies → inferred ----
  console.log('M4 r5-starting')
  const t0 = Date.now()
  const r5 = await toolResult(webPort, tokenA, 'plano_ask', { to: ptyB, text: 'are you there?', timeoutMs: 3000 })
  const r5ms = Date.now() - t0

  console.log(
    'RESULT:',
    JSON.stringify({
      r4ok: r4.reply === 'it is 4' && r4.inferred === false,
      r4: { reply: r4.reply, inferred: r4.inferred, error: r4.error },
      r5ok: r5.inferred === true && typeof r5.reply === 'string',
      r5: { inferred: r5.inferred, timeout: r5.timeout, replyLen: typeof r5.reply === 'string' ? r5.reply.length : -1, ms: r5ms, error: r5.error },
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
