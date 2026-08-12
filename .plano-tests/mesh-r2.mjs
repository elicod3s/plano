// Plan AGENT_MESH_V3 R2: busy honesto. Simulated "codex" agent (node in
// node_modules/codex-sim/) gated by a START handshake file so sampling is synchronized:
//   phase spinner (0-5s):  repaints the SAME line (\rWorking...)  → idle by content
//   phase counter (5-11s): prints a changing counter             → working
//   phase done (11s+):     silence                               → idle
// Mesh busy comes ONLY from the daemon detect loop (v3 A2): content fingerprint with
// ~1.5s leave hysteresis, never "bytes flowed recently".
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
  const UD = path.join(os.tmpdir(), `mesh-r2-${run}`)
  const PRJ = path.join(os.tmpdir(), `mesh-r2p-${run}`)
  fs.mkdirSync(UD, { recursive: true })
  fs.mkdirSync(path.join(PRJ, 'node_modules', 'codex-sim'), { recursive: true })
  fs.writeFileSync(path.join(PRJ, 'package.json'), '{}')
  fs.writeFileSync(
    path.join(PRJ, 'node_modules', 'codex-sim', 'index.js'),
    `const fs=require('fs');const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const main=async()=>{
  for(let i=0;i<300;i++){ if(fs.existsSync('START')) break; await sleep(100); }
  process.stdout.write('spinner-phase\\n');
  for(let i=0;i<20;i++){ process.stdout.write('\\rWorking...'); await sleep(250); }
  process.stdout.write('\\ncounter-phase\\n');
  for(let i=0;i<24;i++){ process.stdout.write('\\rWorking... '+i); await sleep(250); }
  process.stdout.write('\\ndone\\n');
  await sleep(60000);
};
main();`,
  )
  const command = `node "${path.join(PRJ, 'node_modules', 'codex-sim', 'index.js').replace(/"/g, '')}"`
  fs.writeFileSync(
    path.join(UD, 'workspaces.json'),
    JSON.stringify({
      schemaVersion: 1,
      savedAt: new Date().toISOString(),
      activeId: 's1',
      workspaces: [
        { id: 's1', name: 'S', folderPath: PRJ, viewport: { x: 0, y: 0, zoom: 1 }, regions: [], panels: [{ id: 't1', type: 'terminal', rect: { x: 60, y: 80, width: 420, height: 300 }, z: 1, title: 'T', props: { folderPath: PRJ, command: '' } }] },
      ],
    }),
  )
  fs.writeFileSync(path.join(UD, 'session.json'), JSON.stringify({ folderPath: PRJ }))
  fs.writeFileSync(path.join(UD, 'settings.json'), JSON.stringify(SETTINGS))
  const port = 9660 + (Date.now() % 15)
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
    if (n >= 1) break
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
  const ptyA = hello?.sessions?.[0]?.ptyId
  const webPort = hello?.webPort ?? host.webPort
  const secret = fs.readFileSync(path.join(UD, 'mesh', 'master-secret'), 'utf8').trim()
  const tokenA = createHmac('sha256', secret).update(ptyA).digest('hex')
  await rpc(host, 'reportVerdict', { ptyId: ptyA, verdict: { active: true, kind: 'codex', phase: 'idle', displayName: 'codex' } })
  fs.writeFileSync(path.join(PRJ, 'START'), 'go') // handshake: script may begin
  await rpc(host, 'write', { ptyId: ptyA, data: `${command}\r` }) // launch the simulated CLI

  const t0 = Date.now()
  const samples = []
  const sample = async () => {
    const r = await toolResult(webPort, tokenA, 'plano_roster', {})
    const row = (r.agents ?? r.roster ?? []).find((a) => a.id === ptyA)
    const tail = ((await rpc(host, 'attach', { ptyId: ptyA }))?.result?.buffer ?? '').slice(-200)
    const clean = tail.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\r/g, '')
    samples.push({ t: ((Date.now() - t0) / 1000).toFixed(1), busy: !!row?.busy, phase: phaseOf(clean) })
  }
  const phaseOf = (clean) => {
    const lines = clean.split('\n').filter(Boolean)
    const last = lines[lines.length - 1] ?? ''
    if (last.startsWith('Working... ') && /\d$/.test(last)) return 'counter'
    if (last.startsWith('Working...')) return 'spinner'
    return 'other'
  }
  for (let i = 0; i < 30; i += 1) {
    await sample()
    await sleep(500)
  }
  // criteria: spinner repaint for >2.5s (one full detect poll) must be idle;
  // counter must flip to busy; after 'done' + 2s must be idle again.
  const spinnerSamples = samples.filter((s) => s.phase === 'spinner')
  const counterSamples = samples.filter((s) => s.phase === 'counter')
  const lastIdx = samples.map((s) => s.phase).lastIndexOf('counter')
  const doneSamples = lastIdx >= 0 ? samples.slice(lastIdx + 1) : []
  const spinnerIdle = spinnerSamples.slice(2).some((s) => !s.busy)
  const counterBusy = counterSamples.some((s) => s.busy)
  const doneIdle = doneSamples.slice(4).some((s) => !s.busy)
  console.log('RESULT:', JSON.stringify({ ok: spinnerIdle && counterBusy && doneIdle, spinnerIdle, counterBusy, doneIdle, samples }))
  console.log('TAIL:', JSON.stringify(((await rpc(host, 'attach', { ptyId: ptyA }))?.result?.buffer ?? '').slice(-300)))
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
