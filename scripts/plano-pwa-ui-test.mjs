// PWA UI test: drive a mobile-emulated headless Chrome against the PLANO web app served by the
// daemon. Connects with the token, verifies the agent/terminal views, sends a message to an
// agent, and creates a NEW agent from the phone UI.
import { spawn } from 'node:child_process'
import http from 'node:http'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const EXE = process.argv[2]
const USER_DATA = process.argv[3]
const APP_PORT = Number(process.argv[4])
const PORT = APP_PORT
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PROJECT = join(tmpdir(), 'plano-pwa-project')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const ok = (n, c, e = '') => { console.log(`${c ? 'PASS' : 'FAIL'} ${n}${e ? ' — ' + e : ''}`); if (!c) failures++ }
const withTimeout = (p, ms, what) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout: ' + what)), ms))])

mkdirSync(PROJECT, { recursive: true })
writeFileSync(join(PROJECT, 'package.json'), '{"name":"plano-pwa-e2e"}\n')
mkdirSync(USER_DATA, { recursive: true })
writeFileSync(join(USER_DATA, 'workspaces.json'), JSON.stringify({ schemaVersion: 1, savedAt: new Date().toISOString(), activeId: 's1', workspaces: [{ id: 's1', name: 'PWA', folderPath: PROJECT, viewport: { x: 0, y: 0, zoom: 1 }, regions: [], panels: [] }] }, null, 2))
writeFileSync(join(USER_DATA, 'session.json'), JSON.stringify({ folderPath: PROJECT }))
writeFileSync(join(USER_DATA, 'settings.json'), readFileSync('D:/Tools/Plano/scripts/plano-e2e-seed-settings.json', 'utf8').replace('"__KEEP__"', 'true'))

async function getJson(p, port) {
  return new Promise((res, rej) => {
    const r = http.get(`http://127.0.0.1:${port}${p}`, (x) => {
      let d = ''
      x.on('data', (c) => (d += c))
      x.on('end', () => {
        try { res(JSON.parse(d)) } catch { rej(new Error('bad')) }
      })
    })
    r.on('error', rej)
  })
}
async function waitCdp(port, ms = 30000) {
  const dl = Date.now() + ms
  while (Date.now() < dl) {
    try {
      const t = await getJson('/json', port)
      const p = t.find((x) => x.type === 'page')
      if (p) return p
    } catch {}
    await sleep(400)
  }
  throw new Error('no cdp')
}
async function connect(port) {
  const page = await withTimeout(waitCdp(port), 40000, 'cdp')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  const send = (m, p) => new Promise((res, rej) => {
    const i = ++id
    pending.set(i, { res, rej })
    ws.send(JSON.stringify({ id: i, method: m, params: p }))
  })
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id)
      pending.delete(m.id)
      m.error ? p.rej(new Error(m.error.message)) : p.res(m.result)
    }
  }
  await new Promise((r) => (ws.onopen = r))
  const evalJs = async (e) => {
    const r = await withTimeout(send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }), 15000, 'eval')
    if (r.exceptionDetails) return { __exc: r.exceptionDetails.exception?.description?.slice(0, 200) }
    return r.result.value
  }
  return { ws, evalJs }
}

// ── Launch PLANO with one terminal running an agent-ish session ──────────────
const app = spawn(EXE, ['.', `--remote-debugging-port=${APP_PORT}`], {
  env: { ...process.env, PLANO_USER_DATA_DIR: USER_DATA },
  stdio: 'ignore',
  windowsHide: true,
})
app.unref()
let c = await connect(PORT)
let hostInfo = null
for (let i = 0; i < 40; i += 1) {
  await sleep(400)
  try {
    if (existsSync(join(USER_DATA, 'agent-host.json'))) {
      hostInfo = JSON.parse(readFileSync(join(USER_DATA, 'agent-host.json'), 'utf8'))
      break
    }
  } catch {}
}
ok('daemon web server up', hostInfo?.webPort > 0, `webPort=${hostInfo?.webPort}`)
const base = `http://127.0.0.1:${hostInfo.webPort}`

// Wait for the app to connect, then create an agent session via REST (so the phone UI has data)
for (let i = 0; i < 20; i += 1) {
  await sleep(400)
  try {
    const r = await fetch(`${base}/api/status?token=${hostInfo.token}`)
    const s = await r.json()
    if (s.appConnected) break
  } catch {}
}
const created = await (
  await fetch(`${base}/api/sessions?token=${hostInfo.token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folderPath: PROJECT, name: 'Claude', bootCommand: 'claude', cols: 100, rows: 30 }),
  })
).json()
ok('agent session created', !!created.session?.ptyId)
// give the agent time to boot + the daemon's light detection to flag it
await sleep(9000)

// ── Launch headless Chrome (old headless mode — stable CDP) against the PWA ──
const CHROME_PORT = APP_PORT + 50
const chrome = spawn(CHROME, [
  '--headless=old',
  `--remote-debugging-port=${CHROME_PORT}`,
  '--user-agent=Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  '--window-size=390,844',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--user-data-dir=' + join(tmpdir(), 'plano-pwa-chrome-' + Date.now()),
  `${base}/?token=${hostInfo.token}`,
], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
let chromeLog = ''
chrome.stdout?.on('data', (d) => (chromeLog += d))
chrome.stderr?.on('data', (d) => (chromeLog += d))
chrome.unref()

const pc = await connect(CHROME_PORT)
await sleep(3000)
try {
  await pc.evalJs(`(function(){ return 1 })()`)
  const { ws: _ws } = c
  _ws && _ws.send(JSON.stringify({ id: 9999, method: 'Emulation.setDeviceMetricsOverride', params: { width: 390, height: 844, deviceScaleFactor: 3, mobile: true } }))
} catch {}
await sleep(500)
// Mobile viewport emulation
await pc.ws && undefined
const emu = await pc.evalJs(`(function(){ document.title = 'loaded:' + location.href.slice(0, 60); return window.innerWidth + 'x' + window.innerHeight })()`)
console.log('  [dbg] viewport:', emu)

// Direct fetch check from the page + error collector
const fetchDbg = await pc.evalJs(`(async function(){
  window.__errs = []
  window.addEventListener('error', (e) => window.__errs.push('E:' + e.message))
  window.addEventListener('unhandledrejection', (e) => window.__errs.push('R:' + String(e.reason)))
  try {
    const saved = JSON.parse(localStorage.getItem('plano.conn.v1') || '{}')
    const r = await fetch('/api/status?token=' + saved.token)
    const raw = await r.text()
    const j = JSON.parse(raw)
    return 'status raw=' + raw.slice(0, 120) + ' | sessions=' + (j.sessions||[]).length + ' workspaces=' + (j.workspaces||[]).length + ' appConnected=' + j.appConnected
  } catch (e) { return 'FETCH FAIL: ' + e.message }
})()`)
console.log('  [dbg] page fetch:', fetchDbg)
const errs1 = await pc.evalJs('window.__errs')
console.log('  [dbg] page errors:', JSON.stringify(errs1))

// token mismatch check
const pageTok = await pc.evalJs(`new URLSearchParams(location.search).get('token')`)
console.log('  [dbg] page token:', String(pageTok).slice(0, 10) + '…', '| daemon token:', hostInfo.token.slice(0, 10) + '…')
console.log('  [dbg] page href:', String(await pc.evalJs('location.href')).slice(0, 80))
const apiDbg = await pc.evalJs(`(async function(){
  const saved = JSON.parse(localStorage.getItem('plano.conn.v1') || '{}')
  try {
    const r = await fetch(saved.base + '/api/status?token=' + encodeURIComponent(saved.token))
    const j = await r.json()
    return 'app-fetch ok sessions=' + (j.sessions||[]).length + ' agents=' + (j.sessions||[]).filter(s=>s.agentKind).length
  } catch (e) { return 'app-fetch FAIL ' + e.message + ' base=' + saved.base }
})()`)
console.log('  [dbg] app api fetch:', apiDbg)
const wsDbg = await pc.evalJs(`(async function(){
  const saved = JSON.parse(localStorage.getItem('plano.conn.v1') || '{}')
  return await new Promise((res) => {
    try {
      const w = new WebSocket((saved.base || '').replace(/^http/, 'ws') + '/ws?token=' + saved.token)
      w.onopen = () => { res('WS OPEN'); w.close() }
      w.onerror = (e) => res('WS ERROR ' + (e.message || ''))
      w.onclose = (e) => res('WS CLOSE code=' + e.code)
      setTimeout(() => res('WS TIMEOUT'), 4000)
    } catch (e) { res('WS THROW ' + e.message) }
  })
})()`)
console.log('  [dbg] page ws:', wsDbg)
// Connect screen should be SKIPPED (token in URL → auto-connect). Verify the home screen loads.
let home = false
for (let i = 0; i < 30; i += 1) {
  await sleep(500)
  const txt = String(await pc.evalJs(`document.body.innerText`))
  if (txt.includes('PLANO') && (txt.includes('Agents') || txt.includes('Terminals'))) {
    home = true
    break
  }
}
ok('PWA home screen loads (auto-connected)', home)

// The session must show in the UI (Agents tab once detected, else the Terminals tab)
await sleep(3000)
let agentSeen = false
for (let i = 0; i < 24; i += 1) {
  await sleep(500)
  const txt = String(await pc.evalJs(`document.body.innerText`))
  if (txt.includes('Claude') || txt.toLowerCase().includes('claude code')) { agentSeen = true; break }
}
if (!agentSeen) {
  // switch to Terminals tab
  await pc.evalJs(`(function(){ const tabs = [...document.querySelectorAll('.tab')]; const t = tabs.find((x) => x.textContent.includes('Terminals')); if (t) t.click() })()`)
  for (let i = 0; i < 10; i += 1) {
    await sleep(500)
    const txt = String(await pc.evalJs(`document.body.innerText`))
    if (txt.toLowerCase().includes('claude') || txt.includes('shell')) { agentSeen = true; break }
  }
}
ok('phone sees the running session', agentSeen)
if (!agentSeen) console.log('  [dbg] body:', JSON.stringify(String(await pc.evalJs('document.body.innerText')).slice(0, 300)))

// Open the agent detail (tap the first agent row) → transcript visible
await pc.evalJs(`(function(){ const rows = document.querySelectorAll('.agent-row'); if (rows[0]) rows[0].click(); return rows.length })()`)
await sleep(2000)
let transcript = String(await pc.evalJs(`document.body.innerText`))
ok('agent detail opens with transcript', transcript.includes('claude') || transcript.toLowerCase().includes('claude code'), 'agent page open')

// Send a message from the phone
await pc.evalJs(`(function(){
  const ta = document.querySelector('textarea');
  if (!ta) return 'no-textarea'
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(ta, 'hello from the phone')
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  return 'typed'
})()`)
await sleep(400)
await pc.evalJs(`(function(){ const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Send'); if (btn) btn.click(); return !!btn })()`)
await sleep(2000)
// The message landed in the daemon session (the shell echoes typed input)
const buf = await (await fetch(`${base}/api/sessions/${created.session.ptyId}/buffer?token=${hostInfo.token}`)).json()
ok('phone message reaches the agent session', typeof buf.buffer === 'string' && buf.buffer.includes('hello from the phone'))
if (typeof buf.buffer !== 'string' || !buf.buffer.includes('hello from the phone')) {
  console.log('  [dbg] buffer head:', JSON.stringify((buf.buffer || '').slice(0, 120)))
  console.log('  [dbg] ta value after send:', JSON.stringify(await c.evalJs(`document.querySelector('textarea') ? document.querySelector('textarea').value : 'none'`)))
  console.log('  [dbg] body:', JSON.stringify(String(await c.evalJs('document.body.innerText')).slice(0, 200)))
}

// Navigate back + create a NEW agent via the UI
await pc.evalJs(`(function(){ const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '‹'); if (b) b.click(); })()`)
await sleep(800)
await pc.evalJs(`(function(){ const tabs = [...document.querySelectorAll('.tab')]; const n = tabs.find((t) => t.textContent.includes('New')); if (n) n.click(); })()`)
await sleep(1200)
await pc.evalJs(`(function(){
  const rows = [...document.querySelectorAll('.agent-row')]
  const codex = rows.find((r) => r.textContent.includes('Codex'))
  if (codex) codex.click()
  const btns = [...document.querySelectorAll('button')]
  const launch = btns.find((b) => b.textContent.includes('Launch'))
  if (launch) launch.click()
  return !!launch
})()`)
await sleep(3500)
const sessionsAfter = await (await fetch(`${base}/api/sessions?token=${hostInfo.token}`)).json()
ok('created a new agent from the phone UI', sessionsAfter.sessions.length >= 2, `sessions=${sessionsAfter.sessions.length}`)
if (sessionsAfter.sessions.length < 2) console.log('  [dbg] new-agent body:', JSON.stringify(String(await pc.evalJs('document.body.innerText')).slice(0, 300)))

// cleanup
await pc.evalJs('window.plano && window.plano.window.close()').catch(() => undefined)
await sleep(800)
try { spawn('taskkill', ['/PID', String(hostInfo.pid), '/F', '/T'], { stdio: 'ignore' }).unref() } catch {}

console.log(failures === 0 ? '\nPWA UI TEST ALL PASSED' : `\nPWA UI TEST ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
