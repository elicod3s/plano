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
//   C9 status + context give another agent's live state AND full redacted chat (cross-agent visibility).
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
  const tryAllow = async (n = 40) => {
    for (let i = 0; i < n; i += 1) {
      const clicked = await ev(`(() => { const t=[...document.querySelectorAll('[data-surface-layer="popover"]')].find((x)=>(x.textContent||'').includes('Mesh writes')); if(!t) return false; const b=[...t.querySelectorAll('button')].find((x)=>(x.textContent||'').trim()==='Allow'); b?.click(); return !!b })()`)
      if (clicked) break
      await sleep(250)
    }
  }
  const rosterAgent = (ptyId, token = tokenA) => {
    const r = parseJson(cliSync(['roster', '--json'], token).stdout)
    return (r?.agents ?? []).find((x) => String(x.id).startsWith(String(ptyId).slice(0, 12))) ?? null
  }
  const tailOf = async (ptyId) => {
    const buf = ((await rpc(host, 'attach', { ptyId }))?.result?.buffer ?? '')
    return buf.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\r/g, '').slice(-500)
  }
  /** Answer codex's TUI prompts: "Trust this directory?", tool approvals, and the first-run
   *  admin-sandbox select. Enter = highlighted Yes; the sandbox select gets DOWN+Enter
   *  ("Use Codex without admin sandbox"). Drives the PTY directly, like the user clicking. */
  const answerPrompts = async (ptyId, timeoutMs = 45000) => {
    const deadline = Date.now() + timeoutMs
    let answered = false
    while (Date.now() < deadline && !answered) {
      const tail = await tailOf(ptyId)
      const isPrompt = /(continue|trust|confirm|allow|approve|permission|run this|yes\/no|y\/n|proceed|sandbox|set up|setup)/i.test(tail) && /(yes|allow|approve|continue|confirm|proceed|run|try|use codex|sandbox)/i.test(tail)
      if (isPrompt) {
        if (/sandbox|set up|setup/i.test(tail)) {
          // codex 0.147 first-run select: DOWN moves to "Use Codex without admin sandbox".
          await rpc(host, 'write', { ptyId, data: '\x1b[B\r' })
        } else {
          await rpc(host, 'write', { ptyId, data: '\r' })
        }
        await sleep(1500)
        const after = await tailOf(ptyId)
        const still = /(continue|trust|confirm|allow|approve|permission|run this|yes\/no|y\/n|proceed|sandbox|set up|setup)/i.test(after) && /(yes|allow|approve|continue|confirm|proceed|run|try|use codex|sandbox)/i.test(after)
        answered = !still
        if (!answered) {
          if (/sandbox|set up|setup/i.test(after)) await rpc(host, 'write', { ptyId, data: '\x1b[B\r' })
          else await rpc(host, 'write', { ptyId, data: '\r' })
        }
      } else {
        answered = true // no prompt visible — done answering
      }
      if (!answered) await sleep(700)
    }
    return answered
  }
  /** Wait until the roster shows a target state (default idle), or a deadline. */
  const waitState = async (ptyId, want = 'idle', timeoutMs = 60000) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const a = rosterAgent(ptyId)
      if (a && a.state === want) return true
      await sleep(800)
    }
    return false
  }
  const waitTailContains = async (ptyId, needle, timeoutMs = 30000) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if ((await tailOf(ptyId)).includes(needle)) return true
      await sleep(250)
    }
    return false
  }

  // ---- C1: whoami via the installed CLI (production execution path) ----
  const who = cliSync(['whoami', '--json'], tokenA)
  const whoParsed = parseJson(who.stdout) ?? {}
  const c1 = whoParsed.ok === true && whoParsed.id === ptyA && typeof whoParsed.workspace === 'string'

  // ---- C2: roster lists the seeded agents ----
  const rosParsed = parseJson(cliSync(['roster', '--json'], tokenA).stdout) ?? {}
  const c2 = rosParsed.ok === true && Array.isArray(rosParsed.agents) && rosParsed.agents.length >= 2

  // ---- C3: a bad token is rejected ----
  const bad = cliSync(['whoami'], 'not-a-real-token')
  const c3 = bad.status === 1 && /token/i.test(bad.stderr)

  // ---- C4: send (type) to the peer ----
  await tryAllow()
  const sentParsed = parseJson(cliSync(['send', ptyB, 'echo hello-from-a', '--json'], tokenA).stdout) ?? {}
  await tryAllow()
  const bufB = ((await rpc(host, 'attach', { ptyId: ptyB }))?.result?.buffer ?? '')
  const c4 = sentParsed.ok === true && bufB.includes('echo hello-from-a')

  // ---- C5: spawn a REAL codex, answer its prompts, then send --wait ----
  await tryAllow()
  const sp = parseJson(cliSync(['spawn', 'codex', PRJ, '--json'], tokenA).stdout) ?? {}
  const codexId = Array.isArray(sp?.ptyIds) ? sp.ptyIds[0] : null
  let c5 = sp.ok === true && !!codexId
  let c5detail = { detected: false, answered: false, wait: null, state: null, tail: null }
  if (c5) {
    const deadline = Date.now() + 30000
    while (Date.now() < deadline) {
      const a = rosterAgent(codexId)
      if (a && a.kind === 'codex') {
        c5detail.detected = true
        break
      }
      await sleep(800)
    }
    if (c5detail.detected) {
      c5detail.answered = await answerPrompts(codexId)
      // wait for codex to reach its normal idle prompt before typing the plan into it
      const idle = await waitState(codexId, 'idle', 120000)
      c5 = idle
      if (c5) {
        const wP = runAsync(cliAsync(['send', codexId, 'Reply with exactly: PONG', '--wait', '--timeout-ms', '240000', '--json'], tokenA), 280000)
        // answer any prompt codex shows while the send --wait blocks (user would click Allow)
        let wDone = false
        void wP.then(() => (wDone = true)).catch(() => (wDone = true))
        const guardDeadline = Date.now() + 250000
        while (!wDone && Date.now() < guardDeadline) {
          await sleep(700)
          const tail = await tailOf(codexId)
          if (/(trust|continue|confirm|allow|approve|permission|run this|yes\/no|y\/n|proceed|sandbox|setup)/i.test(tail)) {
            await answerPrompts(codexId, 12000)
          }
        }
        const w = await wP
        const wParsed = parseJson(w.stdout)?.wait ?? null
        c5detail.wait = wParsed
        c5 = w.status === 0 && wParsed?.ok === true && (wParsed.state === 'idle' || wParsed.state === 'exited') && wParsed.timedOut !== true && (wParsed.delta || '').length > 0
        if (!c5) c5detail.tail = (await tailOf(codexId)).slice(-260)
      } else {
        c5detail.state = rosterAgent(codexId)?.state ?? null
        c5detail.tail = (await tailOf(codexId)).slice(-220)
      }
    }
  }

  // ---- C6: ask — a peer that never replies must answer HONESTLY, never with a fabricated reply ----
  // This used to assert `inferred: true`: on timeout the bus handed back the transcript delta as
  // if it were the answer, so a peer still booting returned its MCP connection errors as the reply
  // to a question. Worse than silence, because it looks like an answer. The contract now: either a
  // real reply, or `pending` with the transcript offered separately as context.
  const a = parseJson(cliSync(['ask', ptyB, 'what is the meaning', '--timeout-ms', '20000', '--json'], tokenA, 60000).stdout) ?? {}
  const c6 =
    a?.ok === true &&
    (typeof a.reply === 'string' && a.reply.length > 0
      ? true
      : (a.answered === false || a.timeout === true) && a.status === 'pending' && a.inferred !== true)

  // Free the codex single-instance lock: C5's TUI is still alive — kill the session so C7's
  // newborn codex can start (a second instance refuses to boot and the shell stays plain).
  if (codexId) await rpc(host, 'kill', { ptyId: codexId }).catch(() => {})
  await sleep(1500)

  // ---- C7: spawn --wait — prompt typed into the newborn, wait resolves with its output ----
  await tryAllow()
  let c7 = false
  let c7detail = { state: null, deltaHasPrompt: false, answered: false, tail: null }
  // Snapshot the roster BEFORE the spawn — taking it afterwards can already include the
  // newborn, which would then be filtered out of the prompt-answering watch list.
  const beforeIds = new Set((parseJson(cliSync(['roster', '--json'], tokenA).stdout)?.agents ?? []).map((a) => a.id))
  const sp2P = runAsync(cliAsync(['spawn', 'codex', PRJ, '--prompt', 'Reply with exactly: PONG', '--wait', '--timeout-ms', '240000', '--json'], tokenA), 340000)
  let sp2Done = false
  void sp2P.then(() => (sp2Done = true)).catch(() => (sp2Done = true))
  // While the spawn --wait blocks, watch the roster for the newborn and answer its prompts
  // (sandbox select / trust / approvals) the moment they appear — the user would click them.
  const foundIds = []
  const guardDeadline = Date.now() + 270000
  while (!sp2Done && Date.now() < guardDeadline) {
    await sleep(700)
    const ros = parseJson(cliSync(['roster', '--json'], tokenA).stdout) ?? {}
    for (const a of ros?.agents ?? []) {
      if (beforeIds.has(a.id) || foundIds.includes(a.id)) continue
      foundIds.push(a.id)
    }
    for (const pid of foundIds) {
      const tail = await tailOf(pid)
      if (/(trust|continue|confirm|allow|approve|permission|run this|yes\/no|y\/n|proceed|sandbox|setup)/i.test(tail)) {
        c7detail.answered = (await answerPrompts(pid, 12000)) || c7detail.answered
      }
    }
  }
  const sp2 = await sp2P
  const sp2Parsed = parseJson(sp2.stdout) ?? {}
  const sp2Wait = sp2Parsed.wait ?? null
  const idsFromOutput = Array.isArray(sp2Parsed.ptyIds) ? sp2Parsed.ptyIds : []
  const allSpawnedIds = [...new Set([...foundIds, ...idsFromOutput])]
  c7detail.state = sp2Wait?.state
  c7detail.deltaHasPrompt = (sp2Wait?.delta ?? '').includes('PONG')
  c7detail.deltaBytes = (sp2Wait?.delta ?? '').length
  c7detail.timedOut = sp2Wait?.timedOut ?? null
  c7detail.ids = allSpawnedIds.map((x) => String(x).slice(0, 8))
  c7 = sp2Parsed.ok === true && sp2Wait?.ok === true && (sp2Wait.state === 'idle' || sp2Wait.state === 'exited') && sp2Wait.timedOut !== true && c7detail.deltaHasPrompt
  if (!c7 && allSpawnedIds.length > 0) c7detail.tail = (await tailOf(allSpawnedIds[0])).slice(-600)

  // ---- C8: agent-context emits the machine-readable schema ----
  const acParsed = parseJson(cliSync(['agent-context'], tokenA).stdout) ?? {}
  const c8 = Array.isArray(acParsed.commands) && acParsed.commands.some((c) => c.command === 'wait')

  // ---- C9: cross-agent visibility — live state AND the full chat of another agent ----
  const targetId = allSpawnedIds[0] || codexId || ptyB
  const stParsed = parseJson(cliSync(['status', targetId, '--json'], tokenA).stdout) ?? {}
  const ctxParsed = parseJson(cliSync(['context', targetId, '--lines', '15', '--json'], tokenA).stdout) ?? {}
  const c9 = stParsed.ok === true && typeof stParsed.state === 'string' && ctxParsed?.ok === true && (ctxParsed.tail || '').length > 0

  const c12detail = {}
  let c12 = false
  // ---- C11: a busy target AUTO-QUEUES instead of refusing (v6 A1) ----
  // The old contract answered `failed: working` and made every agent invent its own retry. Send
  // to a peer that is mid-turn and assert the message is accepted and parked, not rejected.
  const c11detail = {}
  let c11 = false
  {
    // Put B to work with something slow, then send while it is busy.
    cliSync(['send', ptyB, 'sleep 6'], tokenA)
    await sleep(1500)
    const busySend = parseJson(cliSync(['send', ptyB, 'echo queued-under-load', '--json'], tokenA).stdout) ?? {}
    c11detail.status = busySend.status
    c11detail.autoQueued = busySend.autoQueued === true
    c11detail.id = typeof busySend.id === 'string' ? busySend.id.slice(0, 8) : null
    // Accepted is the point: either it went straight in (target finished early) or it was queued.
    c11 = busySend.ok === true && (busySend.status === 'queued' || busySend.status === 'delivered')

    // ---- C12: `plano watch` answers for that exact message (v6 B1) ----
    if (busySend.ok === true && typeof busySend.id === 'string') {
      const watched = parseJson(cliSync(['watch', busySend.id, '--timeout-ms', '45000', '--json'], tokenA, 60000).stdout) ?? {}
      c12detail.status = watched.status
      c12detail.already = watched.already === true
      c12 = watched.ok === true && (watched.status === 'delivered' || watched.status === 'queued')
    }
  }

  // ---- C13: the roster exposes backlog + workspace (v6 B3 / v5 roster columns) ----
  const rosterV6 = parseJson(cliSync(['roster', '--json'], tokenA).stdout) ?? {}
  const anyAgent = (rosterV6.agents ?? [])[0] ?? {}
  const c13 =
    rosterV6.ok === true &&
    typeof anyAgent.pending === 'number' &&
    typeof anyAgent.workspace === 'string' &&
    typeof anyAgent.oldestPendingMs === 'number'

  // ---- C10: an agent can CLOSE a terminal (the undo of spawn) ----
  // Close one of the agents spawned above and prove it is really gone: the session dies, the mesh
  // drops it, and `status` can no longer find it.
  const c10detail = {}
  let c10 = false
  const closeTarget = allSpawnedIds.find((x) => String(x) !== ptyA) || codexId
  if (closeTarget) {
    const closed = parseJson(cliSync(['close', String(closeTarget), '--json'], tokenA).stdout) ?? {}
    c10detail.closedOk = closed.ok === true
    await sleep(1200)
    const after = parseJson(cliSync(['status', String(closeTarget), '--json'], tokenA).stdout) ?? {}
    const rosterAfter = parseJson(cliSync(['roster', '--json'], tokenA).stdout) ?? {}
    c10detail.goneFromStatus = after.ok !== true
    c10detail.goneFromRoster = !(rosterAfter.agents ?? []).some((a) => String(a.id) === String(closeTarget))
    c10 = c10detail.closedOk && c10detail.goneFromStatus && c10detail.goneFromRoster
  } else {
    c10detail.skipped = 'no spawned agent to close'
  }

  // ---- C14: SHORT-PREFIX ids work on every command, not just send/ask ----
  // The roster prints truncated ids; `send`/`ask` resolved them while wait/status/context/close
  // did an exact map lookup and answered not-found for the very id they had just been shown.
  const c14detail = {}
  const prefix = String(ptyB).slice(0, 8)
  const stPrefix = parseJson(cliSync(['status', prefix, '--json'], tokenA).stdout) ?? {}
  const ctxPrefix = parseJson(cliSync(['context', prefix, '--json'], tokenA).stdout) ?? {}
  c14detail.status = stPrefix.ok === true
  c14detail.context = ctxPrefix.ok === true
  const c14 = c14detail.status && c14detail.context

  // ---- C15: permission prompt is a hard zero-byte boundary ----
  const c15detail = {}
  let c15 = false
  await waitState(ptyB, 'idle', 30000)
  await rpc(host, 'write', { ptyId: ptyB, data: '__TEST_PERMISSION__\r' })
  const permissionVisible = await waitState(ptyB, 'awaiting-input', 30000)
  const permissionMessage = `PERMISSION-MUST-NOT-BE-WRITTEN-${run}`
  const permissionSend = parseJson(cliSync(['send', ptyB, permissionMessage, '--json'], tokenA).stdout) ?? {}
  await sleep(1200)
  const permissionBufferBeforeClear = ((await rpc(host, 'attach', { ptyId: ptyB }))?.result?.buffer ?? '')
  c15detail.visible = permissionVisible
  c15detail.status = permissionSend.status
  c15detail.humanActionRequired = permissionSend.humanActionRequired === true
  c15detail.accepted = permissionSend.accepted
  c15detail.bytesWritten = permissionSend.bytesWritten
  c15detail.absentBeforeClear = !permissionBufferBeforeClear.includes(permissionMessage)
  await rpc(host, 'write', { ptyId: ptyB, data: 'y\r' })
  const permissionCleared = await waitState(ptyB, 'idle', 30000)
  let permissionWatch = {}
  if (typeof permissionSend.id === 'string') {
    permissionWatch =
      parseJson(cliSync(['watch', permissionSend.id, '--timeout-ms', '90000', '--json'], tokenA, 110000).stdout) ?? {}
  }
  const permissionLanded = await waitTailContains(ptyB, permissionMessage, 30000)
  c15detail.cleared = permissionCleared
  c15detail.watchStatus = permissionWatch.status
  c15detail.watchAccepted = permissionWatch.accepted
  c15detail.watchBytes = permissionWatch.bytesWritten
  c15detail.landedAfterClear = permissionLanded
  c15 =
    permissionVisible &&
    permissionSend.ok === true &&
    permissionSend.status === 'queued' &&
    permissionSend.humanActionRequired === true &&
    permissionSend.accepted === false &&
    permissionSend.bytesWritten === 0 &&
    c15detail.absentBeforeClear &&
    permissionCleared &&
    permissionWatch.ok === true &&
    permissionWatch.accepted === true &&
    permissionWatch.bytesWritten > 0 &&
    permissionLanded

  // ---- C16: a swallowed Enter leaves the paste parked; PLANO detects and resubmits it ----
  const c16detail = {}
  let c16 = false
  await waitState(ptyB, 'idle', 30000)
  await rpc(host, 'write', { ptyId: ptyB, data: '__TEST_SWALLOW_NEXT__\r' })
  const swallowArmed = await waitTailContains(ptyB, 'armed swallow-next', 15000)
  await waitState(ptyB, 'idle', 30000)
  const parkedMessage = `PARKED-THEN-RECOVERED-${run}`
  const parkedSend = parseJson(cliSync(['send', ptyB, parkedMessage, '--json'], tokenA, 60000).stdout) ?? {}
  const parkedLanded = await waitTailContains(ptyB, parkedMessage, 30000)
  c16detail.armed = swallowArmed
  c16detail.status = parkedSend.status
  c16detail.accepted = parkedSend.accepted
  c16detail.bytesWritten = parkedSend.bytesWritten
  c16detail.recoveredEditing = parkedSend.recoveredEditing === true
  c16detail.landed = parkedLanded
  c16 =
    swallowArmed &&
    parkedSend.ok === true &&
    parkedSend.accepted === true &&
    parkedSend.bytesWritten > 0 &&
    parkedSend.recoveredEditing === true &&
    parkedLanded

  // ---- C17: 3-agent saturation, 20 messages in each direction under live collisions ----
  console.error('PROGRESS: C17 saturation starting')
  const c17detail = { submitted: 0, watched: 0, landed: 0, failures: [] }
  let c17 = false
  // Let per-sender rate windows from the earlier probes expire before the deliberate burst.
  await sleep(11000)
  await Promise.all([
    rpc(host, 'write', { ptyId: ptyA, data: `COLLIDE-PRIME-A-${run}\r` }),
    rpc(host, 'write', { ptyId: ptyB, data: `COLLIDE-PRIME-B-${run}\r` }),
    rpc(host, 'write', { ptyId: ptyC, data: `COLLIDE-PRIME-C-${run}\r` }),
  ])
  // Observe the same collision window for all three agents. Sequential 30 s polls can reach C
  // after its deliberate 12 s turn already ended even though A/B/C did overlap in reality.
  const allWorking = (await Promise.all([
    waitState(ptyA, 'working', 30000),
    waitState(ptyB, 'working', 30000),
    waitState(ptyC, 'working', 30000),
  ])).every(Boolean)
  const agents3 = [
    { id: ptyA, token: tokenA },
    { id: ptyB, token: tokenB },
    { id: ptyC, token: tokenC },
  ]
  const saturation = []
  for (let i = 0; i < 20; i += 1) {
    const from = agents3[i % agents3.length]
    const forwardTo = agents3[(i + 1) % agents3.length]
    const reverseFrom = forwardTo
    const reverseTo = from
    for (const item of [
      { from, to: forwardTo, text: `SAT-F-${String(i).padStart(2, '0')}-${run}` },
      { from: reverseFrom, to: reverseTo, text: `SAT-R-${String(i).padStart(2, '0')}-${run}` },
    ]) {
      const call = cliSync(['send', item.to.id, item.text, '--json'], item.from.token, 30000)
      const parsed = parseJson(call.stdout) ?? {}
      saturation.push({ ...item, result: parsed })
      c17detail.submitted += 1
      if (parsed.ok !== true || typeof parsed.id !== 'string') {
        c17detail.failures.push({ phase: 'send', text: item.text, status: parsed.status, error: parsed.error })
      }
    }
  }
  let watchProgress = 0
  const watchResults = await Promise.all(saturation.map(async (item) => {
    if (typeof item.result.id !== 'string') return { item, watched: {} }
    const watchedCall = await runAsync(
      cliAsync(['watch', item.result.id, '--timeout-ms', '180000', '--json'], item.from.token),
      200000,
      `watch ${item.text}`,
    )
    const watched = parseJson(watchedCall.stdout) ?? {}
    watchProgress += 1
    if (watchProgress % 5 === 0 || watchProgress === saturation.length) {
      console.error(`PROGRESS: C17 watches ${watchProgress}/${saturation.length}`)
    }
    return { item, watched }
  }))
  for (const { item, watched } of watchResults) {
    if (
      watched.ok === true &&
      watched.accepted === true &&
      watched.bytesWritten > 0 &&
      (watched.status === 'delivered' || watched.status === 'written-but-unconfirmed')
    ) {
      c17detail.watched += 1
    } else {
      c17detail.failures.push({
        phase: 'watch',
        text: item.text,
        status: watched.status,
        accepted: watched.accepted,
        bytesWritten: watched.bytesWritten,
      })
    }
  }
  const saturationBuffers = new Map()
  for (const agent of agents3) {
    saturationBuffers.set(agent.id, ((await rpc(host, 'attach', { ptyId: agent.id }))?.result?.buffer ?? ''))
  }
  for (const item of saturation) {
    if ((saturationBuffers.get(item.to.id) ?? '').includes(item.text)) c17detail.landed += 1
    else c17detail.failures.push({ phase: 'buffer', text: item.text, to: item.to.id.slice(0, 8) })
  }
  c17detail.allWorking = allWorking
  c17 =
    allWorking &&
    c17detail.submitted === 40 &&
    c17detail.watched === 40 &&
    c17detail.landed === 40 &&
    c17detail.failures.length === 0

  // ── C18: the PULL channel — a peer blocked in `check --wait` receives instantly ────────────
  //
  // This is the one delivery route that is guaranteed rather than attempted: the peer is already
  // inside the CLI call, so the message arrives as that command's own output. No composer to
  // detect, no paste to confirm, no Enter to prove. Everything else in the mesh degrades when a
  // TUI is in an unexpected state; this does not.
  const c18detail = {}
  {
    const listener = cliAsync(['check', '--wait', '--timeout-ms', '60000', '--json'], tokenB)
    const listening = runAsync(listener, 70000, 'c18-check')
    await sleep(2000) // let the long-poll register its waiter
    const t0 = Date.now()
    const push = cliSync(['send', ptyB, 'ping-through-check-18', '--json'], tokenA, 30000)
    let pushParsed = {}
    try {
      pushParsed = JSON.parse(push.stdout || '{}')
    } catch {}
    const got = await listening
    c18detail.wakeMs = Date.now() - t0
    c18detail.channel = pushParsed.channel ?? null
    c18detail.sendStatus = pushParsed.status ?? null
    let checkParsed = {}
    try {
      checkParsed = JSON.parse(got.stdout || '{}')
    } catch {}
    c18detail.count = checkParsed.count ?? 0
    c18detail.carriedText = JSON.stringify(checkParsed.messages ?? []).includes('ping-through-check-18')
    // Fast is the point: the old path waited for an idle transition that could never come.
    c18detail.fast = c18detail.wakeMs < 10000
  }
  const c18 =
    c18detail.channel === 'check' &&
    c18detail.sendStatus === 'delivered' &&
    c18detail.count >= 1 &&
    c18detail.carriedText === true &&
    c18detail.fast === true

  // ── C19: `send` never refuses a peer whose harness is not detected ─────────────────────────
  //
  // It used to answer `not-agent: target is a plain terminal` and drop the message on the floor.
  // A booting agent is indistinguishable from a plain terminal for its first minutes, which is
  // how a message sent to a newborn was rejected outright instead of waiting for it.
  const c19detail = {}
  {
    await rpc(host, 'reportVerdict', { ptyId: ptyC, verdict: { active: false, kind: 'unknown', phase: 'idle', displayName: '' } })
    await sleep(800)
    const res = cliSync(['send', ptyC, 'mail-to-an-undetected-peer', '--json'], tokenA, 30000)
    try {
      const parsed = JSON.parse(res.stdout || '{}')
      c19detail.ok = parsed.ok
      c19detail.status = parsed.status ?? null
      c19detail.error = parsed.error ?? null
    } catch {
      c19detail.parseFailed = (res.stdout || '').slice(0, 200)
    }
  }
  const c19 = c19detail.ok === true && !c19detail.error

  console.log(
    'RESULT:',
    JSON.stringify({
      ok:
        c1 && c2 && c3 && c4 && c5 && c6 && c7 && c8 && c9 && c10 && c11 && c12 && c13 && c14 &&
        c15 && c16 && c17 && c18 && c19,
      c18: { ok: c18, ...c18detail },
      c19: { ok: c19, ...c19detail },
      c1: { ok: c1, id: whoParsed.id?.slice(0, 8), workspace: whoParsed.workspace },
      c2: { ok: c2, agents: rosParsed.agents?.length },
      c3: { ok: c3, status: bad.status, stderr: (bad.stderr || '').trim().slice(0, 80) },
      c4: { ok: c4, sendStatus: sentParsed.status, landed: bufB.includes('echo hello-from-a') },
      c5: { ok: c5, spawned: sp.ok, detected: c5detail.detected, answered: c5detail.answered, state: c5detail.state, waitState: c5detail.wait?.state, waitTimedOut: c5detail.wait?.timedOut, deltaBytes: (c5detail.wait?.delta ?? '').length, tail: c5detail.tail },
      c6: { ok: c6, status: a?.status ?? null, answered: a?.answered ?? null, replyBytes: (a?.reply ?? '').length, contextBytes: (a?.contextTail ?? '').length },
      c7: { ok: c7, spawnOk: sp2Parsed.ok, state: c7detail.state, timedOut: c7detail.timedOut, deltaHasPrompt: c7detail.deltaHasPrompt, deltaBytes: c7detail.deltaBytes, ids: c7detail.ids, answered: c7detail.answered, status: sp2.status, tail: c7detail.tail, stdout: (sp2.stdout || '').slice(0, 400), stderr: (sp2.stderr || '').slice(0, 200) },
      c8: { ok: c8, commands: acParsed.commands?.length },
      c9: { ok: c9, state: stParsed.state, chatBytes: (ctxParsed?.tail ?? '').length },
      c10: { ok: c10, ...c10detail },
      c11: { ok: c11, ...c11detail },
      c12: { ok: c12, ...c12detail },
      c13: { ok: c13, pending: anyAgent.pending, workspace: anyAgent.workspace },
      c14: { ok: c14, ...c14detail },
      c15: { ok: c15, ...c15detail },
      c16: { ok: c16, ...c16detail },
      c17: { ok: c17, ...c17detail },
    }),
  )

  // Kill the app tree AND the detached daemon (agent-host daemons survive app closes by design).
  cleanupRun()
  process.exit(0)
}

main().catch((e) => {
  console.error('ERROR:', e && e.stack ? e.stack : String(e))
  cleanupRun()
  process.exit(1)
})
