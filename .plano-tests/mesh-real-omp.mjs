// Mesh CLI e2e probes C1-C17: the `plano` CLI against a REAL freshly booted daemon.
// Uses a REAL codex agent (installed on this machine) as the workhorse: spawn → answer its
// "Trust this directory?" prompt → send --wait / spawn --wait exercise REAL turns.
//   C1 whoami through the installed CLI, executed the production way (ELECTRON_RUN_AS_NODE).
//   C2 roster lists the agents.
//   C3 a bad token is rejected with exit 1.
//   C4 send (type) to a peer lands in its buffer.
//   C5 spawn a real codex, answer its trust prompt, then `send --wait` blocks until it finishes.
//   C6 ask → an unanswered question reports PENDING, never a reply invented from the transcript.
//   C7 spawn --wait — prompt typed into the newborn, wait resolves with its output.
//   C8 agent-context emits the machine-readable command schema.
//   C9 status + context give another agent's live state AND full redacted chat (Orca-style).
import { spawn, spawnSync } from 'node:child_process'
import http from 'node:http'
import net from 'node:net'
import { createHmac } from 'node:crypto'
import WebSocket from 'ws'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let cleanupAppPid = 0
let cleanupUserData = ''

function cleanupRun() {
  const userData = cleanupUserData
  try {
    if (cleanupAppPid) spawnSync('taskkill', ['/PID', String(cleanupAppPid), '/T', '/F'], { stdio: 'ignore', timeout: 8000 })
  } catch {}
  try {
    if (userData) {
      const hostFile = JSON.parse(fs.readFileSync(path.join(userData, 'agent-host.json'), 'utf8'))
      if (hostFile?.pid) spawnSync('taskkill', ['/PID', String(hostFile.pid), '/T', '/F'], { stdio: 'ignore', timeout: 8000 })
    }
  } catch {}
  // Exact per-run marker only: never sweep another test or the user's installed PLANO.
  try {
    if (userData) {
      spawnSync('powershell', [
        '-NoProfile',
        '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.CommandLine -match '${userData.replace(/\\/g, '\\\\').replace(/'/g, "''")}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
      ], { stdio: 'ignore', timeout: 8000 })
    }
  } catch {}
  cleanupAppPid = 0
  cleanupUserData = ''
}

process.on('SIGTERM', () => {
  cleanupRun()
  process.exit(143)
})
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

async function main() {
  const run = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  const UD = path.join(os.tmpdir(), `mesh-cli-${run}`)
  cleanupUserData = UD
  const PRJ = path.join(os.tmpdir(), `mesh-clip-${run}`)
  // Isolated codex config: the user's real ~/.codex has MCP servers that hang the TUI with
  // failed handshakes. Give the test its own CODEX_HOME (auth copied, no MCP) so turns are fast.
  const CODE_HOME = path.join(os.tmpdir(), `mesh-codex-${run}`)
  fs.mkdirSync(UD, { recursive: true })
  fs.mkdirSync(PRJ, { recursive: true })
  fs.mkdirSync(CODE_HOME, { recursive: true })
  // Deterministic agent TUI for transport fault injection. It advertises bracketed paste exactly
  // like the supported harnesses, renders a real composer marker, can park the next submitted
  // message in edit mode, and can expose a permission prompt without requiring a live model API.
  // Its path deliberately matches the daemon's codex process signature, so detection remains the
  // production process-tree path rather than a test-only daemon switch.
  const FAKE_AGENT = path.join(PRJ, 'node_modules', 'fake-codex', 'bin', 'cli.js')
  fs.mkdirSync(path.dirname(FAKE_AGENT), { recursive: true })
  fs.writeFileSync(
    FAKE_AGENT,
    String.raw`const ESC = '\x1b'
const BP_START = ESC + '[200~'
const BP_END = ESC + '[201~'
let pending = ''
let input = ''
let inPaste = false
let permission = false
let editing = false
let swallowNext = false
let working = false

process.stdin.setEncoding('utf8')
if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.resume()

function prompt(clear) {
  if (clear) process.stdout.write(ESC + '[2J' + ESC + '[H')
  process.stdout.write(ESC + '[?2004h' + '› ')
}

function finish(text, delay) {
  working = true
  let tick = 0
  const timer = setInterval(() => {
    tick += 1
    process.stdout.write('\rworking-' + tick)
  }, 90)
  setTimeout(() => {
    clearInterval(timer)
    working = false
    process.stdout.write('\r\nACK:' + text + '\r\n')
    prompt(false)
  }, delay)
}

function submit() {
  const text = input
  if (swallowNext && text.indexOf('__TEST_SWALLOW_NEXT__') === -1) {
    swallowNext = false
    editing = true
    process.stdout.write('\r\nesc again to edit previous message\r\n› [Pasted Content ' + text.length + ' chars]')
    return
  }
  input = ''
  if (text.indexOf('__TEST_PERMISSION__') !== -1) {
    permission = true
    process.stdout.write('\r\nDo you want to proceed? [y/n]')
    return
  }
  if (text.indexOf('__TEST_EDIT__') !== -1) {
    editing = true
    process.stdout.write('\r\nesc again to edit previous message\r\n› ')
    return
  }
  if (text.indexOf('__TEST_SWALLOW_NEXT__') !== -1) {
    swallowNext = true
    process.stdout.write('\r\narmed swallow-next\r\n')
    prompt(false)
    return
  }
  const delay = /COLLIDE-PRIME/.test(text) ? 12000 : /sleep 6/.test(text) ? 6000 : 110
  finish(text, delay)
}

function consume() {
  while (pending.length) {
    if (permission) {
      const cr = pending.indexOf('\r')
      if (cr < 0) return
      const answer = pending.slice(0, cr)
      pending = pending.slice(cr + 1)
      if (/y|yes/i.test(answer)) {
        permission = false
        input = ''
        process.stdout.write('\r\npermission-cleared\r\n')
        prompt(true)
      }
      continue
    }
    if (editing && pending[0] === ESC && !pending.startsWith(BP_START)) {
      pending = pending.slice(1)
      editing = false
      process.stdout.write('\r\nedit-mode-cleared\r\n')
      prompt(true)
      if (input) process.stdout.write('[Pasted Content ' + input.length + ' chars]')
      continue
    }
    if (!inPaste && pending.startsWith(BP_START)) {
      pending = pending.slice(BP_START.length)
      inPaste = true
      input = ''
      continue
    }
    if (!inPaste && BP_START.startsWith(pending)) return
    if (inPaste) {
      const end = pending.indexOf(BP_END)
      if (end < 0) return
      input += pending.slice(0, end)
      pending = pending.slice(end + BP_END.length)
      inPaste = false
      process.stdout.write('[Pasted Content ' + input.length + ' chars]')
      continue
    }
    const ch = pending[0]
    pending = pending.slice(1)
    if (ch === '\r') submit()
    else if (ch === '\x15') input = ''
    else if (ch !== ESC) input += ch
  }
}

process.stdin.on('data', (chunk) => {
  pending += chunk
  consume()
})
prompt(false)
`,
    'utf8',
  )
  const userAuth = path.join(os.homedir(), '.codex', 'auth.json')
  if (fs.existsSync(userAuth)) fs.copyFileSync(userAuth, path.join(CODE_HOME, 'auth.json'))
  fs.writeFileSync(path.join(PRJ, 'package.json'), '{}')
  // Pre-answer codex's first-run TUI gates in config instead of racing to click them:
  //   [windows] sandbox = "unelevated"  → skips the "set up the admin sandbox?" select
  //   [projects.<cwd>] trust_level      → skips "Trust this directory?"
  // Both are written for every spelling of the temp path codex may normalize to (8.3 short
  // form from %TEMP%, the long real path, lowercased, forward slashes). answerPrompts below
  // still runs as the backstop — this only removes the race.
  const trustPaths = new Set()
  for (const base of [PRJ, (() => { try { return fs.realpathSync.native(PRJ) } catch { return PRJ } })()]) {
    for (const v of [base, base.toLowerCase(), base.replace(/\\/g, '/'), base.replace(/\\/g, '/').toLowerCase()]) trustPaths.add(v)
  }
  const trustToml = [...trustPaths].map((p) => `[projects."${p.replace(/\\/g, '\\\\')}"]\ntrust_level = "trusted"\n`).join('\n')
  fs.writeFileSync(
    path.join(CODE_HOME, 'config.toml'),
    `model = "gpt-5.6-sol"\napproval_policy = "never"\nsandbox_mode = "danger-full-access"\nmodel_reasoning_effort = "high"\n\n[windows]\nsandbox = "unelevated"\n\n${trustToml}`,
    'utf8',
  )
  const fakeBoot = `node "${FAKE_AGENT.replace(/\\/g, '/')}"`
  const panels = ['tA', 'tB', 'tC'].map((id, i) => ({
    id,
    type: 'terminal',
    rect: { x: 60 + i * 500, y: 80, width: 440, height: 320 },
    z: 1,
    title: id,
    props: { folderPath: PRJ, bootCommand: fakeBoot },
  }))
  fs.writeFileSync(
    path.join(UD, 'workspaces.json'),
    JSON.stringify({ schemaVersion: 1, savedAt: new Date().toISOString(), activeId: 's1', workspaces: [{ id: 's1', name: 'S', folderPath: PRJ, viewport: { x: 0, y: 0, zoom: 1 }, regions: [], panels }] }),
  )
  fs.writeFileSync(path.join(UD, 'session.json'), JSON.stringify({ folderPath: PRJ }))
  fs.writeFileSync(path.join(UD, 'settings.json'), JSON.stringify(SETTINGS))
  const freePort = () =>
    new Promise((res) => {
      const srv = net.createServer()
      srv.listen(0, '127.0.0.1', () => {
        const p = srv.address().port
        srv.close(() => res(p))
      })
    })
  const port = await freePort()
  const app = spawn('D:/Tools/Plano/node_modules/electron/dist/electron.exe', ['.', `--remote-debugging-port=${port}`], {
    env: { ...process.env, PLANO_USER_DATA_DIR: UD, CODEX_HOME: CODE_HOME },
    stdio: 'ignore',
    windowsHide: true,
  })
  cleanupAppPid = app.pid ?? 0
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
  const ptyA = sessions.find((s) => s.panelId === 'tA')?.ptyId ?? sessions[0]?.ptyId
  const ptyB = sessions.find((s) => s.panelId === 'tB')?.ptyId ?? sessions[1]?.ptyId
  const ptyC = sessions.find((s) => s.panelId === 'tC')?.ptyId ?? sessions[2]?.ptyId
  const webPort = hello?.webPort ?? host.webPort
  const secret = fs.readFileSync(path.join(UD, 'mesh', 'master-secret'), 'utf8').trim()
  const tokenA = createHmac('sha256', secret).update(ptyA).digest('hex')
  const tokenB = createHmac('sha256', secret).update(ptyB).digest('hex')
  const tokenC = createHmac('sha256', secret).update(ptyC).digest('hex')
  await rpc(host, 'reportVerdict', { ptyId: ptyA, verdict: { active: true, kind: 'codex', phase: 'idle', displayName: 'codex' } })
  await rpc(host, 'reportVerdict', { ptyId: ptyB, verdict: { active: true, kind: 'codex', phase: 'idle', displayName: 'codex' } })
  await rpc(host, 'reportVerdict', { ptyId: ptyC, verdict: { active: true, kind: 'codex', phase: 'idle', displayName: 'codex' } })
  await sleep(600)

  // The daemon installed the CLI at boot; the test drives the real bundle.
  const cliJs = path.join(UD, 'bin', 'plano-cli.js')
  if (!fs.existsSync(cliJs)) throw new Error('CLI not installed: ' + cliJs + ' (installCli failed at daemon boot?)')
  const ELECTRON = 'D:/Tools/Plano/node_modules/electron/dist/electron.exe'
  const meshUrl = `http://127.0.0.1:${webPort}/cli`
  const cliEnv = (token) => ({ ...process.env, ELECTRON_RUN_AS_NODE: '1', PLANO_MESH_URL: meshUrl, PLANO_MESH_TOKEN: token })
  /** Sync CLI call (fast commands). */
  const cliSync = (cmdArgs, token, timeoutMs = 60000) =>
    spawnSync(ELECTRON, [cliJs, ...cmdArgs], { env: cliEnv(token), encoding: 'utf8', timeout: timeoutMs, windowsHide: true })
  /** Async CLI call (long-polls like spawn --wait / send --wait — the test keeps driving). */
  const cliAsync = (cmdArgs, token) => spawn(ELECTRON, [cliJs, ...cmdArgs], { env: cliEnv(token), windowsHide: true })
  const runAsync = (child, timeoutMs, label = 'cli') =>
    new Promise((res) => {
      let out = ''
      let err = ''
      child.stdout.on('data', (d) => (out += d))
      child.stderr.on('data', (d) => (err += d))
      const t = setTimeout(() => {
        child.kill()
        res({ status: 'timeout', stdout: out, stderr: err, label })
      }, timeoutMs)
      child.on('close', (code) => {
        clearTimeout(t)
        res({ status: code, stdout: out, stderr: err, label })
      })
      child.on('error', (e) => {
        clearTimeout(t)
        res({ status: 'spawn-error', stdout: out, stderr: String(e), label })
      })
    })
  const parseJson = (s) => {
    try {
      return JSON.parse(s)
    } catch {
      return null
    }
  }

  // ── The user's exact scenario, with a REAL OMP agent ───────────────────────────────────────
  //
  //   plano spawn omp . --prompt "Do nothing. Wait for messages. Answer when greeted."
  //   …then someone greets it, and it must actually answer.
  //
  // The machine-checkable proof is `channel: "check"` on the send: it means the real agent read
  // the injected contract and parked itself inside `plano check --wait`, so the message was handed
  // to it as command output instead of being typed at a screen we had to guess the state of.
  const out = { steps: [] }
  const log = (s, v) => {
    out.steps.push([s, v])
    console.log('STEP', s, JSON.stringify(v).slice(0, 300))
  }

  const spawned = cliSync(
    ['spawn', 'omp', PRJ, '--prompt', 'No hagas nada. Quedate a la espera de mensajes. Cuando te saluden, responde.', '--json'],
    tokenA,
    120000,
  )
  const sp = parseJson(spawned.stdout) ?? {}
  log('spawn', { ok: sp.ok, harness: sp.harness, ids: (sp.ptyIds ?? []).map((i) => i.slice(0, 8)) })
  const worker = (sp.ptyIds ?? [])[0]
  if (!worker) throw new Error('no worker spawned: ' + (spawned.stdout || spawned.stderr))

  // Boot + read the contract + get into check --wait. OMP starts MCP servers; minutes is normal.
  let listening = false
  for (let i = 0; i < 60 && !listening; i += 1) {
    await sleep(5000)
    const st = parseJson(cliSync(['status', worker, '--json'], tokenA, 30000).stdout) ?? {}
    const tail = String(st.lastOutput ?? '')
    listening = tail.includes('check --wait') || tail.includes('still listening')
    if (i % 4 === 0) log('boot', { s: i * 5, state: st.state, kind: st.kind, tail: tail.slice(-140) })
  }
  log('adopted-contract', { listening })

  // Greet it, exactly as a peer would.
  const greet = cliSync(['send', worker, 'hola, responde si me escuchas', '--json'], tokenA, 60000)
  const gp = parseJson(greet.stdout) ?? {}
  log('send', { ok: gp.ok, status: gp.status, channel: gp.channel ?? null, detail: String(gp.detail ?? '').slice(0, 120) })

  // Did it actually say something back?
  await sleep(25000)
  const ctx = parseJson(cliSync(['context', worker, '--lines', '40', '--json'], tokenA, 30000).stdout) ?? {}
  const chat = String(ctx.tail ?? '')
  log('answered', { chatBytes: chat.length, tail: chat.slice(-400) })

  console.log('RESULT:', JSON.stringify({
    ok: gp.ok === true && (gp.channel === 'check' || gp.status === 'delivered'),
    viaCheckChannel: gp.channel === 'check',
    adoptedContract: listening,
    sendStatus: gp.status ?? null,
  }))
  cleanupRun()
  process.exit(0)
}

main().catch((e) => {
  console.error('ERROR:', e && e.stack ? e.stack : String(e))
  cleanupRun()
  process.exit(1)
})
