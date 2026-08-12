// Plan AGENT_MESH_INTERCONNECT E5: plano_spawn_agent(count: 2) must materialize TWO new
// terminal panels in the canvas, each booting the requested harness command.
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
  const UD = path.join(os.tmpdir(), `mesh-e5-${run}`)
  const PRJ = path.join(os.tmpdir(), `mesh-e5p-${run}`)
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
        { id: 's1', name: 'S', folderPath: PRJ, viewport: { x: 0, y: 0, zoom: 1 }, regions: [], panels: [{ id: 't1', type: 'terminal', rect: { x: 60, y: 60, width: 420, height: 300 }, z: 1, title: 'T', props: { folderPath: PRJ, command: '' } }] },
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
    return r?.result?.result?.value
  }
  await send('Page.bringToFront', {}).catch(() => {})
  // Wait for the initial terminal + its session.
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
  const helloRpc = await rpc(host, 'ping', {})
  const hello = helloRpc.hello ?? helloRpc.result
  const ptyA = hello?.sessions?.[0]?.ptyId
  const webPort = hello?.webPort ?? host.webPort
  const secret = fs.readFileSync(path.join(UD, 'mesh', 'master-secret'), 'utf8').trim()
  const tokenA = createHmac('sha256', secret).update(ptyA).digest('hex')
  const countBefore = (await ev(`document.querySelectorAll('.xterm').length`)) || 0

  // E5: spawn 2 agents. Mesh WRITES require the user's one-click consent for this workspace, so
  // the call blocks on a toast — fire it WITHOUT awaiting, click Allow, then read the result.
  // (Awaiting first would deadlock: the toast can only be answered while the call is pending.)
  const spawnPending = toolResult(webPort, tokenA, 'plano_spawn_agent', { harness: 'codex', cwd: 'C:/tmp', count: 2, prompt: 'MESH-PROMPT-MARKER' })
  let consentClicked = false
  for (let i = 0; i < 40 && !consentClicked; i += 1) {
    consentClicked = await ev(`(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Allow')
      if (!btn) return false
      btn.click()
      return true
    })()`)
    if (!consentClicked) await sleep(500)
  }
  const spawnResult = await spawnPending
  let countAfter = 0
  for (let i = 0; i < 60; i += 1) {
    countAfter = (await ev(`document.querySelectorAll('.xterm').length`)) || 0
    if (countAfter >= countBefore + 2) break
    await sleep(500)
  }
  // Colocación (petición del usuario): los agentes nuevos deben salir AL LADO del que los pidió,
  // con SU MISMO tamaño y sin solaparse con nada. Se leen los rects del mundo desde el DOM: el
  // ancla de cada panel lleva translate3d(x,y) + width/height en línea.
  const layout = await ev(`(() => {
    const rects = [...document.querySelectorAll('[data-surface-layer="panel"]')].map((shell) => {
      const anchor = shell.parentElement
      const m = /translate3d\\((-?[\\d.]+)px,\\s*(-?[\\d.]+)px/.exec(anchor.style.transform || '')
      return {
        type: shell.dataset.panelType,
        x: m ? Math.round(Number(m[1])) : null,
        y: m ? Math.round(Number(m[2])) : null,
        width: Math.round(parseFloat(anchor.style.width) || 0),
        height: Math.round(parseFloat(anchor.style.height) || 0),
      }
    })
    const overlap = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
    let overlaps = 0
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) if (overlap(rects[i], rects[j])) overlaps++
    return { rects, overlaps }
  })()`)
  const originRect = (layout.rects ?? [])[0]
  const spawned = (layout.rects ?? []).slice(1)
  const sameSize = spawned.length > 0 && spawned.every((r) => r.width === originRect?.width && r.height === originRect?.height)
  const toTheRight = spawned.length > 0 && spawned.every((r) => r.x > originRect.x)
  const notStackedOnOrigin = spawned.every((r) => !(r.x === originRect?.x && r.y === originRect?.y))

  // El prompt del spawn debe aterrizar en los PTY NUEVOS, jamás en el que lo pidió.
  await sleep(14000)
  const buffers = {}
  for (const s of (await rpc(host, 'ping', {})).hello?.sessions ?? []) {
    const att = await rpc(host, 'attach', { ptyId: s.ptyId })
    buffers[s.ptyId] = (att?.result?.buffer ?? '')
  }
  const requesterHasPrompt = (buffers[ptyA] ?? '').includes('MESH-PROMPT-MARKER')
  const spawnedWithPrompt = Object.entries(buffers).filter(([id, b]) => id !== ptyA && b.includes('MESH-PROMPT-MARKER')).length

  const roster = await toolResult(webPort, tokenA, 'plano_roster', {})
  const sessionsAfter = (await rpc(host, 'ping', {})).hello?.sessions ?? []
  const newSessions = sessionsAfter.length - hello.sessions.length

  console.log(
    'RESULT:',
    JSON.stringify({
      consentClicked,
      spawnStatus: spawnResult.status ?? spawnResult.error,
      panelsBefore: countBefore,
      panelsAfter: countAfter,
      newPanels: countAfter - countBefore,
      rosterCount: (roster.agents ?? []).length,
      newSessions,
      promptToRequester: requesterHasPrompt,
      promptToSpawned: spawnedWithPrompt,
      placement: { sameSize, toTheRight, notStackedOnOrigin, overlaps: layout.overlaps, rects: layout.rects },
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
