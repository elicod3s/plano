// Daemon web-server headless test: status, create session, write, list, buffer, kill, WS events.
import { spawn } from 'node:child_process'
import { connect } from 'node:net'
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const REPO = resolve(import.meta.dirname, '..')
const ELECTRON = join(REPO, 'node_modules', 'electron', 'dist', 'electron.exe')
const DAEMON = join(REPO, 'out', 'main', 'daemon.js')
const USER_DATA = mkdtempSync(join(tmpdir(), 'plano-web-test-'))
const WEB_ROOT = mkdtempSync(join(tmpdir(), 'plano-web-root-'))
const HOST_FILE = join(USER_DATA, 'agent-host.json')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// a tiny fake web app
mkdirSync(WEB_ROOT, { recursive: true })
writeFileSync(join(WEB_ROOT, 'index.html'), '<html><body>PLANO MOBILE</body></html>')
writeFileSync(join(WEB_ROOT, 'app.js'), 'console.log("hi")')

let failures = 0
const ok = (n, c, e = '') => { console.log(`${c ? 'PASS' : 'FAIL'} ${n}${e ? ' — ' + e : ''}`); if (!c) failures++ }

const daemon = spawn(ELECTRON, [DAEMON, '--userData', USER_DATA, '--webRoot', WEB_ROOT], {
  detached: true, stdio: 'ignore', windowsHide: true,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PLANO_APP_VERSION: '0.2.0' },
})
daemon.unref()

let info = null
for (let i = 0; i < 60 && !info; i += 1) {
  await sleep(250)
  try { if (existsSync(HOST_FILE)) info = JSON.parse(readFileSync(HOST_FILE, 'utf8')) } catch {}
}
ok('host file has webPort', info && info.webPort > 0, JSON.stringify(info && { port: info.port, webPort: info.webPort }))
const base = `http://127.0.0.1:${info.webPort}`
const token = info.token

const get = async (p, tok = token) => {
  const res = await fetch(base + p + (tok ? `?token=${tok}` : ''))
  return { status: res.status, body: await res.json().catch(() => null) }
}
const post = async (p, body, tok = token) => {
  const res = await fetch(base + p + (tok ? `?token=${tok}` : ''), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

// static app
let res = await fetch(base + '/')
ok('serves the web app', res.status === 200 && (await res.text()).includes('PLANO MOBILE'))
res = await fetch(base + '/app.js')
ok('serves static assets', res.status === 200)

// auth
const noAuth = await get('/api/status', '')
ok('API rejects missing token', noAuth.status === 401)

// status
const status = await get('/api/status')
ok('status endpoint', status.status === 200 && Array.isArray(status.body.sessions) && Array.isArray(status.body.workspaces), JSON.stringify(status.body).slice(0, 120))

// create a session via REST (phone path)
const created = await post('/api/sessions', { folderPath: process.env.USERPROFILE, shell: 'cmd.exe', cols: 100, rows: 30 })
ok('create session via REST', created.status === 200 && created.body.session?.ptyId, JSON.stringify(created.body))
const ptyId = created.body.session?.ptyId
const shellPid = created.body.session?.pid

await sleep(2500)
// write + interrupt + buffer
await post(`/api/sessions/${ptyId}/write`, { data: 'echo PHONE-HELLO\r' })
await sleep(1500)
const buf = await get(`/api/sessions/${ptyId}/buffer`)
ok('buffer contains phone write output', typeof buf.body?.buffer === 'string' && buf.body.buffer.includes('PHONE-HELLO'), `len=${buf.body?.buffer?.length}`)
await post(`/api/sessions/${ptyId}/interrupt`, {})
await sleep(300)

// WS: connect, hello, attach, data events
const ws = await new Promise((resolve2, reject2) => {
  const w = new WebSocket(`ws://127.0.0.1:${info.webPort}/ws?token=${token}`)
  w.onopen = () => resolve2(w)
  w.onerror = (e) => reject2(new Error('ws error'))
})
const wsEvents = []
ws.onmessage = (ev) => wsEvents.push(JSON.parse(ev.data))
await sleep(800)
ok('WS hello + session list', wsEvents.some((e) => e.event === 'hello'))
// attach via WS (viewer) → only then does the session stream
ws.send(JSON.stringify({ method: 'attach', ptyId }))
await sleep(500)
await post(`/api/sessions/${ptyId}/write`, { data: 'echo WS-LIVE\r' })
await sleep(1500)
ok('WS attach-result', wsEvents.some((e) => e.event === 'attach-result' && e.ok === true))
ok('WS data events flow', wsEvents.some((e) => e.event === 'data' && e.data.includes('WS-LIVE')))

// kill + verify gone
await post(`/api/sessions/${ptyId}/kill`, {})
await sleep(800)
const afterKill = await get('/api/sessions')
ok('session removed after kill', afterKill.body.sessions.length === 0)
const shellDead = (() => { try { process.kill(shellPid, 0); return false } catch { return true } })()
ok('shell killed', shellDead)

ws.close()
// shutdown via TCP
const sock = connect({ port: info.port, host: '127.0.0.1' })
await new Promise((r) => sock.once('connect', r))
sock.write(JSON.stringify({ id: 1, method: 'hello', params: { token } }) + '\n')
await sleep(200)
sock.write(JSON.stringify({ id: 2, method: 'shutdown' }) + '\n')
await sleep(1200)
ok('host file removed on shutdown', !existsSync(HOST_FILE))

try { rmSync(USER_DATA, { recursive: true, force: true }) } catch {}
console.log(failures === 0 ? '\nWEB TEST ALL PASSED' : `\nWEB TEST ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
