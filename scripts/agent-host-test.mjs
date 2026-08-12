/**
 * Headless Agent Host lifecycle test — proves the herdr-style guarantee end to end:
 *  1. spawn the daemon (ELECTRON_RUN_AS_NODE child of the Electron binary)
 *  2. connect, hello, create a PTY running a long-lived command
 *  3. write + receive data events
 *  4. disconnect the client → the shell MUST keep running (daemon survives)
 *  5. reconnect → sessions list shows it → attach replays the buffer
 *  6. write again → live stream resumes
 *  7. kill → gone; shutdown → daemon exits
 * Run: node scripts/agent-host-test.mjs
 */
import { spawn } from 'node:child_process'
import { connect } from 'node:net'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const REPO = resolve(import.meta.dirname, '..')
const ELECTRON = join(REPO, 'node_modules', 'electron', 'dist', 'electron.exe')
const DAEMON = join(REPO, 'out', 'main', 'daemon.js')
const USER_DATA = mkdtempSync(join(tmpdir(), 'plano-host-test-'))
const HOST_FILE = join(USER_DATA, 'agent-host.json')

let failures = 0
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`)
  if (!cond) failures += 1
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const execFile = (exe, args) =>
  new Promise((resolve2, reject) => {
    const p = spawn(exe, args, { stdio: 'ignore', windowsHide: true })
    p.on('error', reject)
    p.on('exit', () => resolve2())
    p.unref()
  })

// ── client ────────────────────────────────────────────────────────────────
function makeClient(port, token) {
  const sock = connect({ port, host: '127.0.0.1' })
  const pending = new Map()
  const events = []
  let buf = ''
  let id = 0
  sock.on('data', (chunk) => {
    buf += chunk.toString('utf8')
    let nl
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (!line.trim()) continue
      const msg = JSON.parse(line)
      if (typeof msg.id === 'number' && pending.has(msg.id)) {
        const p = pending.get(msg.id)
        pending.delete(msg.id)
        msg.result ? p.res(msg.result) : p.rej(new Error(msg.result?.error?.message || 'rpc error'))
      } else if (msg.event) {
        events.push(msg)
      }
    }
  })
  const rpc = (method, params = {}) =>
    new Promise((res, rej) => {
      const mid = ++id
      pending.set(mid, { res, rej })
      sock.write(JSON.stringify({ id: mid, method, params }) + '\n')
    })
  const connected = new Promise((res, rej) => {
    sock.once('connect', res)
    sock.once('error', rej)
  })
  return { sock, rpc, events, connected }
}

// ── main ───────────────────────────────────────────────────────────────────
console.log('== spawn daemon ==')
const daemon = spawn(ELECTRON, [DAEMON, '--userData', USER_DATA], {
  detached: true,
  stdio: 'ignore',
  windowsHide: true,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
})
daemon.unref()

let info = null
for (let i = 0; i < 60 && !info; i += 1) {
  await sleep(250)
  try {
    if (existsSync(HOST_FILE)) info = JSON.parse(readFileSync(HOST_FILE, 'utf8'))
  } catch {}
}
ok('daemon port file appears', !!info, info ? `pid=${info.pid} port=${info.port}` : 'no file')

const c1 = makeClient(info.port, info.token)
await c1.connected
const hello1 = await c1.rpc('hello', { token: info.token })
ok('hello returns session list', hello1.ok === true && Array.isArray(hello1.sessions))

console.log('== create session ==')
const pid1 = 'test-pty-0001'
const create = await c1.rpc('create', {
  ptyId: pid1,
  panelId: 'panel-1',
  terminalId: 'tab-1',
  spaceId: 'space-1',
  cwd: process.env.USERPROFILE,
  shell: 'cmd.exe',
  cols: 100,
  rows: 30,
})
ok('create spawns shell', create.ok === true && typeof create.pid === 'number', JSON.stringify(create))
const shellPid = create.pid

// Wait for prompt + stream some data
await sleep(2500)
ok('data events flow', c1.events.some((e) => e.event === 'data' && e.ptyId === pid1), `events=${c1.events.length}`)

// Run a long-lived command so we can prove survival
await c1.rpc('write', { ptyId: pid1, data: 'ping -t 127.0.0.1\r' })
await sleep(3500)
const dataAfterPing = c1.events.filter((e) => e.event === 'data' && e.ptyId === pid1).length
ok('ping output streamed', dataAfterPing > 1, `data events=${dataAfterPing}`)

console.log('== detach (client disconnects) ==')
c1.sock.end()
await sleep(1000)

// The shell process must still be alive
const pingAlive = (() => {
  try {
    process.kill(shellPid, 0)
    return true
  } catch {
    return false
  }
})()
ok('shell survives client disconnect', pingAlive, `shell pid=${shellPid}`)

console.log('== reattach ==')
const c2 = makeClient(info.port, info.token)
await c2.connected
const hello2 = await c2.rpc('hello', { token: info.token })
const listed = hello2.sessions.find((s) => s.ptyId === pid1)
ok('session listed on reconnect', !!listed, JSON.stringify(listed))
ok('session metadata intact', listed && listed.terminalId === 'tab-1' && listed.pid === shellPid)

const attach = await c2.rpc('attach', { ptyId: pid1 })
ok('attach replays buffer', attach.ok === true && attach.buffer.length > 0, `buffer=${attach.buffer.length} bytes`)

// Live stream resumes after attach
const eventsAfter = c2.events.length
await sleep(2500)
const dataAfterAttach = c2.events.filter((e) => e.event === 'data' && e.ptyId === pid1).length
ok('live stream resumes after attach', dataAfterAttach > 0, `new data events=${dataAfterAttach}`)

// Kill the session → daemon must drop it, shell must die
await c2.rpc('kill', { ptyId: pid1 })
await sleep(1200)
const gone = (() => {
  try {
    process.kill(shellPid, 0)
    return false
  } catch {
    return true
  }
})()
ok('kill terminates shell', gone)
const sessionsAfterKill = await c2.rpc('sessions')
ok('session removed after kill', sessionsAfterKill.sessions.length === 0)

// Shutdown → daemon exits + removes port file
await c2.rpc('shutdown')
await sleep(1500)
ok('port file removed on shutdown', !existsSync(HOST_FILE))

let exited = false
for (let i = 0; i < 40; i += 1) {
  try {
    process.kill(info.pid, 0)
  } catch {
    exited = true
    break
  }
  await sleep(250)
}
ok('daemon process exited after shutdown', exited)

// Cleanup stray ping/conhosts
try {
  execFile('taskkill', ['/PID', String(shellPid), '/F', '/T'])
} catch {}
try {
  rmSync(USER_DATA, { recursive: true, force: true })
} catch {}

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
