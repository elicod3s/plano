// Plan AGENT_MESH_INTERCONNECT E1: the daemon's provisioning must merge ONLY the `plano` MCP
// key into each installed harness config, be idempotent (N spawns → one plano block), never
// touch the user's other servers, and leave a backup. Runs with an isolated HOME (USERPROFILE)
// and fake harness binaries on PATH so the REAL user config is never touched.
import { spawn, spawnSync } from 'node:child_process'
import http from 'node:http'
import net from 'node:net'
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
async function main() {
  const run = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  const UD = path.join(os.tmpdir(), `mesh-e1-${run}`)
  const PRJ = path.join(os.tmpdir(), `mesh-e1p-${run}`)
  const HOME = path.join(os.tmpdir(), `mesh-e1h-${run}`)
  const BIN = path.join(os.tmpdir(), `mesh-e1b-${run}`)
  fs.mkdirSync(UD, { recursive: true })
  fs.mkdirSync(PRJ, { recursive: true })
  fs.mkdirSync(HOME, { recursive: true })
  fs.mkdirSync(BIN, { recursive: true })
  fs.writeFileSync(path.join(PRJ, 'package.json'), '{}')
  // Fake harness binaries so the daemon considers them installed.
  fs.writeFileSync(path.join(BIN, 'claude.exe'), '')
  fs.writeFileSync(path.join(BIN, 'codex.exe'), '')
  // A pre-existing Claude config with ANOTHER server — must stay untouched.
  fs.writeFileSync(
    path.join(HOME, '.claude.json'),
    JSON.stringify({ mcpServers: { github: { type: 'http', url: 'http://example.com/github' } } }, null, 2),
    'utf8',
  )
  // A pre-existing Codex TOML with another server table.
  fs.mkdirSync(path.join(HOME, '.codex'), { recursive: true })
  fs.writeFileSync(path.join(HOME, '.codex', 'config.toml'), '[mcp_servers.gh]\ntype = "http"\nurl = "http://example.com/gh"\n', 'utf8')
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
          panels: [{ id: 't1', type: 'terminal', rect: { x: 60, y: 80, width: 420, height: 300 }, z: 1, title: 'T', props: { folderPath: PRJ, command: '' } }],
        },
      ],
    }),
  )
  fs.writeFileSync(path.join(UD, 'session.json'), JSON.stringify({ folderPath: PRJ }))
  fs.writeFileSync(path.join(UD, 'settings.json'), JSON.stringify(SETTINGS))
  const port = 9690 + (Date.now() % 15)
  const app = spawn('D:/Tools/Plano/node_modules/electron/dist/electron.exe', ['.', `--remote-debugging-port=${port}`], {
    env: { ...process.env, PLANO_USER_DATA_DIR: UD, USERPROFILE: HOME, HOME, PATH: `${BIN}${path.delimiter}${process.env.PATH}` },
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
      const t = setTimeout(() => { pend.delete(i); res(undefined) }, 15000)
      pend.set(i, (m) => { clearTimeout(t); res(m) })
      ws.send(JSON.stringify({ id: i, method, params }))
    })
  const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); return r?.result?.result?.value }
  await send('Page.bringToFront', {}).catch(() => {})
  // Wait for the terminal (its spawn triggers provisioning).
  for (let i = 0; i < 60; i += 1) {
    const n = (await ev(`document.querySelectorAll('.xterm').length`)) || 0
    if (n >= 1) break
    await sleep(500)
  }
  await sleep(2500)

  const claude = JSON.parse(fs.readFileSync(path.join(HOME, '.claude.json'), 'utf8'))
  const codex = fs.readFileSync(path.join(HOME, '.codex', 'config.toml'), 'utf8')
  const backupExists = fs.existsSync(path.join(HOME, '.claude.json.plano-backup'))
  const skillExists = fs.existsSync(path.join(HOME, '.claude', 'skills', 'plano-mesh', 'SKILL.md'))
  const cliExists = fs.existsSync(path.join(UD, 'bin', 'plano.cmd')) && fs.existsSync(path.join(UD, 'bin', 'plano-cli.js'))

  // Idempotency: spawn a SECOND terminal → configs must still contain exactly ONE plano block.
  const host = JSON.parse(fs.readFileSync(path.join(UD, 'agent-host.json'), 'utf8'))
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
  await tcp()
  const create2 = () =>
    new Promise((res, rej) => {
      const socket = net.connect(host.port, '127.0.0.1')
      const timer = setTimeout(() => {
        socket.destroy()
        rej(new Error('tcp timeout'))
      }, 8000)
      let buf = ''
      socket.on('connect', () => {
        socket.write(JSON.stringify({ id: 1, method: 'hello', params: { token: host.token } }) + '\n')
        setTimeout(() => {
          socket.write(JSON.stringify({ id: 2, method: 'create', params: { ptyId: 'probe-2', panelId: 'p2', terminalId: 't2', spaceId: 's1', cols: 80, rows: 24 } }) + '\n')
        }, 200)
      })
      socket.on('data', (chunk) => {
        buf += chunk.toString('utf8')
        if (buf.split('\n').length >= 3) {
          clearTimeout(timer)
          socket.destroy()
          res(true)
        }
      })
      socket.on('error', rej)
    })
  try {
    await create2()
  } catch {
    /* second session may fail if PTY busy — idempotency is about the CONFIG, not the session */
  }
  await sleep(2000)

  const claude2 = JSON.parse(fs.readFileSync(path.join(HOME, '.claude.json'), 'utf8'))
  const planoBlocks = Object.keys(claude2.mcpServers).filter((k) => k === 'plano').length
  const githubStillThere = !!claude2.mcpServers.github
  // The entry is now a STDIO server: it must point at the bundled CLI with `mcp`, and must NOT
  // carry a token or URL (those live in each agent's environment — see provision.mcpServerEntry).
  const entry = claude2.mcpServers.plano ?? {}
  const stdioOk = typeof entry.command === 'string' && /plano(\.cmd)?$/.test(entry.command) && Array.isArray(entry.args) && entry.args[0] === 'mcp'
  const noSecretAtRest = entry.headers === undefined && entry.url === undefined
  const codexPlanoCount = (codex.match(/\[mcp_servers\.plano\]/g) || []).length
  const codexGhStillThere = codex.includes('[mcp_servers.gh]')

  console.log(
    'RESULT:',
    JSON.stringify({
      claudePlanoBlocks: planoBlocks,
      githubStillThere,
      stdioOk,
      noSecretAtRest,
      backupExists,
      skillExists,
      cliExists,
      codexPlanoCount,
      codexGhStillThere,
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
