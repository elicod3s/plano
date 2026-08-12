// Mobile integration E2E (robust):
//  A) PLANO OPEN: phone creates an agent via the daemon REST API → desktop materializes a live
//     canvas panel (new xterm, output streams, phone writes visible on the PC).
//  B) PLANO CLOSED: phone creates another terminal → pending panel → relaunch → materialized +
//     reattached to the live daemon session.
import { spawn } from 'node:child_process'
import http from 'node:http'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const EXE = process.argv[2]
const USER_DATA = process.argv[3]
const PORT = Number(process.argv[4])
const PROJECT = join(tmpdir(), 'plano-mobile-project')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const ok = (n, c, e = '') => {
  console.log(`${c ? 'PASS' : 'FAIL'} ${n}${e ? ' — ' + e : ''}`)
  if (!c) failures++
}
const withTimeout = (p, ms, what) =>
  Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout: ' + what)), ms)),
  ])

mkdirSync(PROJECT, { recursive: true })
writeFileSync(join(PROJECT, 'package.json'), '{"name":"plano-mobile-e2e"}\n')
mkdirSync(USER_DATA, { recursive: true })
writeFileSync(
  join(USER_DATA, 'workspaces.json'),
  JSON.stringify(
    {
      schemaVersion: 1,
      savedAt: new Date().toISOString(),
      activeId: 's1',
      workspaces: [
        {
          id: 's1',
          name: 'Mobile E2E',
          folderPath: PROJECT,
          viewport: { x: 0, y: 0, zoom: 1 },
          regions: [],
          panels: [],
        },
      ],
    },
    null,
    2,
  ),
)
writeFileSync(join(USER_DATA, 'session.json'), JSON.stringify({ folderPath: PROJECT }))
writeFileSync(
  join(USER_DATA, 'settings.json'),
  readFileSync('D:/Tools/Plano/scripts/plano-e2e-seed-settings.json', 'utf8').replace('"__KEEP__"', 'true'),
)

async function getJson(p, port) {
  return new Promise((res, rej) => {
    const r = http.get(`http://127.0.0.1:${port}${p}`, (x) => {
      let d = ''
      x.on('data', (c) => (d += c))
      x.on('end', () => {
        try {
          res(JSON.parse(d))
        } catch {
          rej(new Error('bad'))
        }
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
      const p = t.find((x) => x.type === 'page' && x.url.includes('index.html'))
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
const pidAlive = (pid) => {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const allXtermText = async (c) =>
  String(
    await c.evalJs(
      `Array.from(document.querySelectorAll('.xterm')).map((t) => (t.querySelector('.xterm-rows') ? t.querySelector('.xterm-rows').textContent : '')).join('~SEP~')`,
    ),
  )

// ── Phase A: app OPEN ───────────────────────────────────────────────────────
console.log('== Phase A: phone creates an agent while PLANO is open ==')
let app = spawn(EXE, ['.', `--remote-debugging-port=${PORT}`], {
  env: { ...process.env, PLANO_USER_DATA_DIR: USER_DATA },
  stdio: 'ignore',
  windowsHide: true,
})
app.unref()
let c = await connect(PORT)
let hostInfo = null
for (let i = 0; i < 30; i += 1) {
  await sleep(400)
  try {
    if (existsSync(join(USER_DATA, 'agent-host.json'))) {
      hostInfo = JSON.parse(readFileSync(join(USER_DATA, 'agent-host.json'), 'utf8'))
      break
    }
  } catch {}
}
ok('daemon web server up', hostInfo?.webPort > 0, `webPort=${hostInfo?.webPort}`)
// Wait for the DESKTOP app to have finished startup + connected to the daemon (otherwise a
// phone-created session would take the "pending panel" path instead of the live materialization).
for (let i = 0; i < 20; i += 1) {
  await sleep(400)
  const r = await c.evalJs('window.plano.terminal.restore()').catch(() => null)
  if (r && Array.isArray(r.sessions)) break
}
await sleep(500)
const base = `http://127.0.0.1:${hostInfo.webPort}`
const phonePost = async (path, body) => {
  const res = await withTimeout(
    fetch(`${base}${path}?token=${hostInfo.token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    15000,
    'phonePost ' + path,
  )
  return res.json()
}

const created = await phonePost('/api/sessions', {
  folderPath: PROJECT,
  name: 'Phone Agent',
  bootCommand: 'echo REMOTE-AGENT-READY & ping -n 4 127.0.0.1 >nul',
  cols: 100,
  rows: 30,
})
const remotePty = created.session?.ptyId
const shellPid = created.session?.pid
ok('phone created a session via REST', !!remotePty, `pid=${shellPid}`)

// Desktop must materialize a NEW live xterm
let xtermCount = 0
for (let i = 0; i < 20; i += 1) {
  await sleep(500)
  xtermCount = Number(await c.evalJs(`document.querySelectorAll('.xterm').length`))
  if (xtermCount >= 1) break
}
ok('desktop materialized a live terminal panel', xtermCount >= 1, `xterms=${xtermCount}`)

// The desktop xterm must show the remote session's output
let sawBanner = false
for (let i = 0; i < 20; i += 1) {
  await sleep(500)
  const txt = await allXtermText(c)
  if (txt.includes('REMOTE-AGENT-READY')) {
    sawBanner = true
    break
  }
}
ok('remote output streams into the desktop terminal', sawBanner)

// Phone writes → visible on the PC's canvas terminal
await phonePost(`/api/sessions/${remotePty}/write`, { data: 'echo PHONE-TYPED-ON-PC\r' })
let sawWrite = false
for (let i = 0; i < 12; i += 1) {
  await sleep(500)
  const txt = await allXtermText(c)
  if (txt.includes('PHONE-TYPED-ON-PC')) {
    sawWrite = true
    break
  }
}
ok('phone-typed input appears in the desktop terminal', sawWrite)

// ── Phase B: app CLOSED ─────────────────────────────────────────────────────
console.log('== Phase B: phone creates while PLANO is closed ==')
console.log('  [pb] closing…')
const closeRes = await withTimeout(c.evalJs('window.plano.window.close()'), 8000, 'close').catch((e) => String(e))
console.log('  [pb] close eval:', String(closeRes).slice(0, 80))
// The app's Chromium network process can linger on the debug port after quit — don't poll it;
// the daemon surviving is what matters, and the app has ~1-2s of teardown.
await sleep(4000)
console.log('  [pb] app closed')
ok('phone-created shell survives app quit', pidAlive(shellPid), `pid=${shellPid}`)
console.log('  [pb] creating while closed…')

// Phone creates a SECOND terminal while the app is closed → pending panel
const created2 = await phonePost('/api/sessions', {
  folderPath: PROJECT,
  name: 'Closed-App Terminal',
  bootCommand: 'echo PENDING-PANEL-THIS',
  cols: 80,
  rows: 24,
})
const pty2 = created2.session?.ptyId
const status3 = await (await withTimeout(fetch(`${base}/api/status?token=${hostInfo.token}`), 15000, 'status3')).json()
ok('phone session created while app closed + recorded as pending', !!pty2 && status3.pending >= 1, `pending=${status3.pending}`)

// Relaunch → pending panel materializes + reattaches to the live session
console.log('== relaunch: pending panel materializes ==')
app = spawn(EXE, ['.', `--remote-debugging-port=${PORT + 1}`], {
  env: { ...process.env, PLANO_USER_DATA_DIR: USER_DATA },
  stdio: 'ignore',
  windowsHide: true,
})
app.unref()
c = await connect(PORT + 1)
let restored = false
for (let i = 0; i < 30; i += 1) {
  await sleep(500)
  const r = await c.evalJs('window.plano.terminal.restore()')
  if (Array.isArray(r?.sessions) && r.sessions.some((s) => s.ptyId === pty2)) {
    restored = true
    break
  }
}
ok('pending session reattached on relaunch', restored)
console.log('  [dbg] relaunch title:', await c.evalJs('document.title'))
const wsDbg = await (await withTimeout(fetch(`${base}/api/workspaces?token=${hostInfo.token}`), 15000, 'wsdbg')).json()
console.log('  [dbg] workspaces on daemon:', JSON.stringify(wsDbg.workspaces))
const bufDbg = await (await withTimeout(fetch(`${base}/api/sessions/${pty2}/buffer?token=${hostInfo.token}`), 15000, 'bufdbg')).json()
console.log('  [dbg] pending buffer has text:', typeof bufDbg.buffer === 'string' && bufDbg.buffer.includes('PENDING-PANEL-THIS'), 'len:', bufDbg.buffer?.length)
const panelsDbg = await c.evalJs('window.plano.workspaces.get()')
console.log('  [dbg] panels on disk:', JSON.stringify((panelsDbg?.state?.workspaces ?? []).flatMap((w) => w.panels.map((p) => p.type + ':' + (p.props?.tabs?.[0]?.id ?? '').slice(0, 8)))))
let sawPending = false
for (let i = 0; i < 12; i += 1) {
  await sleep(500)
  const txt = await allXtermText(c)
  if (txt.includes('PENDING-PANEL-THIS')) {
    sawPending = true
    break
  }
}
ok('pending panel terminal shows its output after relaunch', sawPending)

// cleanup
await c.evalJs('window.plano.window.close()').catch(() => undefined)
await sleep(800)
try {
  spawn('taskkill', ['/PID', String(hostInfo.pid), '/F', '/T'], { stdio: 'ignore' }).unref()
} catch {}

console.log(failures === 0 ? '\nMOBILE E2E ALL PASSED' : `\nMOBILE E2E ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
