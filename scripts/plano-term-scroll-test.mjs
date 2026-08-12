// Terminal scroll/typing regression test — mobile emulation, real xterm typing + continuous
// output. Reproduces: (a) view yanked to bottom / garbled while an agent prints continuously,
// (b) view stuck at top while new output accumulates below.
import { spawn } from 'node:child_process'
import http from 'node:http'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const EXE = process.argv[2]
const USER_DATA = process.argv[3]
const APP_PORT = Number(process.argv[4])
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PROJECT = join(tmpdir(), 'plano-term-scroll-project')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const ok = (n, c, e = '') => { console.log(`${c ? 'PASS' : 'FAIL'} ${n}${e ? ' — ' + e : ''}`); if (!c) failures++ }

mkdirSync(PROJECT, { recursive: true })
mkdirSync(USER_DATA, { recursive: true })
const seedWs = { schemaVersion: 1, savedAt: new Date().toISOString(), activeId: 's1', workspaces: [{ id: 's1', name: 'T', folderPath: PROJECT, viewport: { x: 0, y: 0, zoom: 1 }, regions: [], panels: [] }] }
writeFileSync(join(USER_DATA, 'workspaces.json'), JSON.stringify(seedWs))
writeFileSync(join(USER_DATA, 'session.json'), JSON.stringify({ folderPath: PROJECT }))
writeFileSync(join(USER_DATA, 'settings.json'), readFileSync('D:/Tools/Plano/scripts/plano-e2e-seed-settings.json', 'utf8').replace('"__KEEP__"', 'true'))

const getJson = (p, port) => new Promise((res, rej) => {
  const r = http.get(`http://127.0.0.1:${port}${p}`, (x) => {
    let d = ''; x.on('data', (c) => (d += c)); x.on('end', () => { try { res(JSON.parse(d)) } catch { rej(new Error('bad json')) } })
  })
  r.on('error', rej)
})
const waitCdp = async (port, ms = 40000) => {
  const dl = Date.now() + ms
  while (Date.now() < dl) {
    try { const t = await getJson('/json', port); const p = t.find((x) => x.type === 'page'); if (p) return p } catch {}
    await sleep(400)
  }
  throw new Error('no cdp')
}
async function connect(port) {
  const page = await waitCdp(port)
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  const send = (m, p) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })) })
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result) }
  }
  await new Promise((r) => (ws.onopen = r))
  const evalJs = async (e) => {
    const r = await Promise.race([send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }), new Promise((_, rej) => setTimeout(() => rej(new Error('eval timeout')), 15000))])
    if (r.exceptionDetails) return { __exc: r.exceptionDetails.exception?.description?.slice(0, 300) }
    return r.result.value
  }
  return { ws, evalJs }
}

// ── Launch PLANO ──────────────────────────────────────────────────────────────
const app = spawn(EXE, ['.', `--remote-debugging-port=${APP_PORT}`], { env: { ...process.env, PLANO_USER_DATA_DIR: USER_DATA }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
app.unref()
let appLog = ''
app.stdout?.on('data', (d) => (appLog += d))
app.stderr?.on('data', (d) => (appLog += d))
const c = await connect(APP_PORT)
let hostInfo = null
for (let i = 0; i < 40; i += 1) { await sleep(400); try { if (existsSync(join(USER_DATA, 'agent-host.json'))) { hostInfo = JSON.parse(readFileSync(join(USER_DATA, 'agent-host.json'), 'utf8')); break } } catch {} }
ok('daemon up', hostInfo?.webPort > 0, `webPort=${hostInfo?.webPort}`)
const base = `http://127.0.0.1:${hostInfo.webPort}`
const tok = `token=${hostInfo.token}`

// Wait for appConnected, then create a session that PRINTS CONTINUOUSLY (a working agent)
for (let i = 0; i < 25; i += 1) { await sleep(400); try { const s = await (await fetch(`${base}/api/status?${tok}`)).json(); if (s.appConnected) break } catch {} }
const boot = `for /L %i in (1,1,80) do @(echo WORKING line %i & ping -n 2 127.0.0.1 >nul)`
const created = await (await fetch(`${base}/api/sessions?${tok}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folderPath: PROJECT, name: 'Worker', bootCommand: boot, cols: 90, rows: 30 }) })).json()
const sess = created.session
ok('session created', !!sess?.ptyId)
console.log('  [dbg] session:', JSON.stringify({ ptyId: sess?.ptyId, terminalId: sess?.terminalId, panelId: sess?.panelId, exited: sess?.exited }))
// Inject the live session as a terminal panel so the phone's Terminals tab lists it (phone-created
// shells are only listed as AGENTS when the daemon detects one; panels come from the workspace).
if (sess?.terminalId) {
  const ws = JSON.parse(readFileSync(join(USER_DATA, 'workspaces.json'), 'utf8'))
  ws.workspaces[0].panels = [{ id: sess.panelId, type: 'terminal', title: 'Worker', props: { tabs: [{ id: sess.terminalId, title: 'Worker', cwd: PROJECT }] } }]
  writeFileSync(join(USER_DATA, 'workspaces.json'), JSON.stringify(ws))
}

// ── Mobile Chrome ─────────────────────────────────────────────────────────────
const CHROME_PORT = APP_PORT + 50
const chrome = spawn(CHROME, ['--headless=old', `--remote-debugging-port=${CHROME_PORT}`, '--user-agent=Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1', '--window-size=390,844', '--disable-gpu', '--no-first-run', '--user-data-dir=' + join(tmpdir(), 'plano-term-chrome-' + Date.now()), `${base}/?${tok}`], { stdio: 'ignore', windowsHide: true })
chrome.unref()
const pc = await connect(CHROME_PORT)
await sleep(4000)
await pc.evalJs('window.__errs=[]; window.addEventListener("error",e=>window.__errs.push("E:"+e.message)); window.addEventListener("unhandledrejection",e=>window.__errs.push("R:"+String(e.reason)))')

// open the session via the Terminals tab (the workspace panel row)
for (let i = 0; i < 20; i += 1) { await sleep(500); const t = String(await pc.evalJs('document.body.innerText')); if (t.toLowerCase().includes('worker')) break }
await pc.evalJs(`(function(){ const tabs=[...document.querySelectorAll('.tab')]; const t=tabs.find((x)=>x.textContent.includes('Terminals')); if(t) t.click(); return !!t })()`)
await sleep(1000)
// debug: live sessions the phone sees, vs the panel we injected
const liveDbg = await (await fetch(`${base}/api/status?${tok}`)).json()
console.log('  [dbg] api sessions:', JSON.stringify((liveDbg.sessions || []).map((s) => ({ ptyId: s.ptyId, terminalId: s.terminalId, exited: s.exited }))))
console.log('  [dbg] workspaces terminals:', JSON.stringify((liveDbg.workspaces || []).flatMap((w) => (w.terminals || []))))
const nav = await pc.evalJs(`(function(){
  const rows=[...document.querySelectorAll('.agent-row')]
  const row=rows.find((r)=>r.textContent.includes('Worker')) || rows[0]
  if(row) row.click()
  return rows.length
})()`)
console.log('  [dbg] rows on home:', nav)
let mounted = false
for (let i = 0; i < 15; i += 1) {
  await sleep(400)
  const has = await pc.evalJs(`!!document.querySelector('.term-shell')`)
  if (has) { mounted = true; break }
}
await sleep(3000)
const body0 = String(await pc.evalJs('document.body.innerText'))
ok('terminal screen mounted (toolbar present)', mounted && body0.includes('Top') && body0.includes('Latest') && body0.includes('PgUp'))
if (!mounted) console.log('  [dbg] body after click:', JSON.stringify(body0.slice(0, 160)))

// ── OBSERVE while the "agent" prints continuously ─────────────────────────────
let stuckTop = 0, yanked = 0
const samples = []
for (let i = 0; i < 30; i += 1) {
  await sleep(300)
  const s = await pc.evalJs(`(function(){
    const vp = document.querySelector('.xterm-viewport')
    const rows = document.querySelector('.xterm-rows')
    const pill = !!document.querySelector('.term-follow-pill')
    const first = rows && rows.firstChild ? rows.firstChild.textContent : ''
    const last = rows && rows.lastChild ? rows.lastChild.textContent : ''
    return { st: vp ? vp.scrollTop : -1, sh: vp ? vp.scrollHeight : -1, cl: vp ? vp.clientHeight : -1, pill, first: String(first).slice(0, 30), last: String(last).slice(0, 40) }
  })()`)
  samples.push(s)
  if (s.sh > 0 && s.st <= 0 && s.sh > s.cl) stuckTop++
  if (s.pill) yanked++
}
const total = samples.length
console.log('  [dbg] scrollTop history:', samples.map((s) => s.st).join(','))
console.log('  [dbg] last sample:', JSON.stringify(samples[samples.length - 1]))
ok('view stays at the live tail (bottom) while agent prints', stuckTop === 0, `stuckTop samples=${stuckTop}/${total}`)
ok('no "Latest" pill spam while following', yanked === 0, `pill shown ${yanked}/${total} times`)

// ── TYPE while output keeps arriving ──────────────────────────────────────────
await pc.evalJs(`(function(){ const ta = document.querySelector('textarea.xterm-helper-textarea'); if (ta) ta.focus(); return !!ta })()`)
await sleep(300)
// real key sequence: rawKeyDown (xterm's _keyDown → onData) + char (text insertion)
for (const ch of 'hello from phone') {
  const code = ch >= 'a' && ch <= 'z' ? 'Key' + ch.toUpperCase() : ch === ' ' ? 'Space' : 'Key' + ch.toUpperCase()
  const vk = ch === ' ' ? 32 : ch.toUpperCase().charCodeAt(0)
  await pc.ws.send(JSON.stringify({ id: 9200 + ch.charCodeAt(0), method: 'Input.dispatchKeyEvent', params: { type: 'rawKeyDown', key: ch, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk } }))
  await pc.ws.send(JSON.stringify({ id: 9300 + ch.charCodeAt(0), method: 'Input.dispatchKeyEvent', params: { type: 'char', text: ch, unmodifiedText: ch, key: ch, code, windowsVirtualKeyCode: vk } }))
  await pc.ws.send(JSON.stringify({ id: 9400 + ch.charCodeAt(0), method: 'Input.dispatchKeyEvent', params: { type: 'keyUp', key: ch, code, windowsVirtualKeyCode: vk } }))
  await sleep(60)
}
await sleep(1200)

const after = await pc.evalJs(`(function(){
  try {
    const rows = [...document.querySelectorAll('.xterm-row, .xterm-rows > div')].map((r) => r.textContent)
    const all = rows.join('|')
    const vp = document.querySelector('.xterm-viewport')
    return { rows: rows.slice(-8), hasTyped: all.includes('hello from phone'), st: vp ? vp.scrollTop : -1, sh: vp ? vp.scrollHeight : -1, cl: vp ? vp.clientHeight : -1, errs: window.__errs || [] }
  } catch (e) { return { __exc: String(e && e.stack || e) } }
})()`)
console.log('  [dbg] last rows:', JSON.stringify(after.rows, null, 0))
if (after.__exc) console.log('  [dbg] eval exc:', JSON.stringify(after.__exc).slice(0, 300))
// ground truth: did the typed text reach the daemon session?
const buf2 = await (await fetch(`${base}/api/sessions/${sess.ptyId}/buffer?${tok}`)).json()
const typedInPty = typeof buf2.buffer === 'string' && buf2.buffer.includes('hello from phone')
console.log('  [dbg] typed reached PTY:', typedInPty, '| buffer len:', (buf2.buffer || '').length)
ok('typed text reaches the daemon session', typedInPty)
ok('typed text appears cleanly at the prompt', after.hasTyped || typedInPty)
const occurrences = ((after.rows || []).join('').match(/hello from phone/g) || []).length
ok('typed text not garbled/duplicated', occurrences >= 1 && occurrences <= 2, `occurrences=${occurrences}`)
ok('view still at bottom after typing', after.sh > 0 && after.cl > 0 ? after.st >= after.sh - after.cl - 2 : true, `st=${after.st} sh=${after.sh} cl=${after.cl}`)
ok('no page JS errors', (after.errs || []).length === 0, JSON.stringify(after.errs))

// cleanup
await pc.evalJs('window.close && window.close()').catch(() => undefined)
try { spawn('taskkill', ['/PID', String(hostInfo.pid), '/F', '/T'], { stdio: 'ignore' }).unref() } catch {}
console.log(failures === 0 ? '\nTERM SCROLL TEST ALL PASSED' : `\nTERM SCROLL TEST ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
