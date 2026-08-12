// Plan AGENT_MESH_INTERCONNECT E2: launch the dev app (isolated user-data) with a seeded
// 2-terminal workspace, then speak the native JSON-RPC protocol to the daemon's /cli endpoint:
//   - hello over the daemon TCP socket → both ptyIds + webPort
//   - derive each agent's token from <userData>/mesh/master-secret (HMAC(secret, ptyId))
//   - POST /cli plano_whoami + plano_roster with agent A's token
//   - unauthorized with a wrong token
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
  agentMesh: { contextPersistence: false, maxPersistBytes: 524288, mcp: { enabled: false, port: 0, enableMutations: false } },
  voice: { enabled: false, pushToTalkKey: 'Ctrl+Shift+Space', autoSend: true, inputDeviceId: '', language: 'auto', speakResponses: false, gemini: { enabled: false, apiKey: '', model: 'gemini-3.1-flash-lite' }, llmFallback: { enabled: false, baseUrl: 'http://localhost:11434/v1', model: 'llama3.1' } },
}
async function main() {
  const run = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  const UD = path.join(os.tmpdir(), `mesh-e2-${run}`)
  const PRJ = path.join(os.tmpdir(), `mesh-e2p-${run}`)
  fs.mkdirSync(UD, { recursive: true })
  fs.mkdirSync(PRJ, { recursive: true })
  fs.writeFileSync(path.join(PRJ, 'package.json'), '{}')
  const mkTerm = (id, x) => ({ id, type: 'terminal', rect: { x, y: 80, width: 420, height: 300 }, z: 1, title: 'T', props: { folderPath: PRJ, command: '' } })
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
          panels: [mkTerm('t1', 60), mkTerm('t2', 520)],
        },
      ],
    }),
  )
  fs.writeFileSync(path.join(UD, 'session.json'), JSON.stringify({ folderPath: PRJ }))
  fs.writeFileSync(path.join(UD, 'settings.json'), JSON.stringify(SETTINGS))
  const port = 9710 + (Date.now() % 15)
  const app = spawn('D:/Tools/Plano/node_modules/electron/dist/electron.exe', ['.', `--remote-debugging-port=${port}`, '--disable-background-timer-throttling'], {
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
      pend.set(i, res)
      ws.send(JSON.stringify({ id: i, method, params }))
    })
  const ev = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) return { __exc: (r.exceptionDetails.exception?.description || '').slice(0, 200) }
    return r.result?.result?.value
  }
  await send('Page.bringToFront', {}).catch(() => {})
  // Wait for both xterms (both sessions created by the daemon).
  let xterms = 0
  for (let i = 0; i < 60; i += 1) {
    xterms = (await ev(`document.querySelectorAll('.xterm').length`)) || 0
    if (xterms >= 2) break
    await sleep(500)
  }

  // Read the daemon host file: TCP port + token + webPort.
  let host
  for (let i = 0; i < 30 && !host; i += 1) {
    try {
      host = JSON.parse(fs.readFileSync(path.join(UD, 'agent-host.json'), 'utf8'))
    } catch {}
    await sleep(400)
  }
  // TCP hello → session list with ptyIds.
  const tcp = (line) =>
    new Promise((res, rej) => {
      const socket = net.connect(host.port, '127.0.0.1')
      const timer = setTimeout(() => {
        socket.destroy()
        rej(new Error('tcp timeout'))
      }, 8000)
      let buf = ''
      socket.on('connect', () => socket.write(JSON.stringify({ id: 1, method: 'hello', params: { token: host.token } }) + '\n'))
      socket.on('data', (chunk) => {
        buf += chunk.toString('utf8')
        const nl = buf.indexOf('\n')
        if (nl !== -1) {
          clearTimeout(timer)
          socket.destroy()
          try {
            res(JSON.parse(buf.slice(0, nl)))
          } catch {
            rej(new Error('bad frame'))
          }
        }
      })
      socket.on('error', rej)
    })
  const hello = await tcp()
  const sessions = hello?.result?.sessions ?? []
  const ptyIds = sessions.map((s) => s.ptyId).filter(Boolean)
  const webPort = hello?.result?.webPort ?? host.webPort

  // Derive per-agent tokens (HMAC-SHA256(masterSecret, ptyId)).
  const secret = fs.readFileSync(path.join(UD, 'mesh', 'master-secret'), 'utf8').trim()
  const tokenOf = (ptyId) => createHmac('sha256', secret).update(ptyId).digest('hex')

  // CLI: POST /cli native JSON-RPC over HTTP.
  const post = (webPort, token, body) =>
    new Promise((res, rej) => {
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
              res(d.slice(0, 200))
            }
          })
        },
      )
      req.on('error', rej)
      req.write(data)
      req.end()
    })

  const tokenA = ptyIds.length > 0 ? tokenOf(ptyIds[0]) : ''
    const rosterCall = await post(webPort, tokenA, { jsonrpc: '2.0', id: 2, method: 'plano_roster', params: {} })
  const roster = rosterCall?.result ?? null
  const whoamiCall = await post(webPort, tokenA, { jsonrpc: '2.0', id: 3, method: 'plano_whoami', params: {} })
  const whoami = whoamiCall?.result ?? null
  // Unauthorized must fail with the wrong token.
  const bad = await post(webPort, 'deadbeef', { jsonrpc: '2.0', id: 4, method: 'plano_whoami' })

  console.log(
    'RESULT:',
    JSON.stringify({
      xterms,
      ptyIds,
      hasSecret: !!secret,
      rosterAgents: roster?.agents?.length ?? null,
      rosterHasA: ptyIds.length > 0 ? (roster?.agents ?? []).some((a) => a.id === ptyIds[0]) : false,
      rosterHasB: ptyIds.length > 1 ? (roster?.agents ?? []).some((a) => a.id === ptyIds[1]) : false,
      whoamiId: whoami?.id,
      unauthorizedStatus: bad?.error?.code ?? 'ok',
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
