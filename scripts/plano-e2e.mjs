/**
 * PLANO full-app E2E — proves the agents-never-close guarantee through the real app:
 *
 *   1. Seed a temp userData with a workspace containing one terminal panel (tab `tab-e2e-1`).
 *   2. Launch PLANO (parameterized exe) with a CDP debugging port.
 *   3. The panel mounts → the terminal spawns via the detached Agent Host. Grab its ptyId by
 *      subscribing to terminal:data, start a long-lived `ping -t` inside it, record the shell PID.
 *   4. Quit the app (window.close → app.quit). The host MUST keep the shell running.
 *   5. Verify the shell + the host are still alive with the app gone.
 *   6. Relaunch with the SAME userData. The workspace restores, the terminal panel remounts and
 *      REATTACHES to the same live session (same ptyId + PID), replaying its scrollback, and the
 *      stream resumes (a write from the new app lands in the same shell).
 *   7. Kill the terminal → shell dies; host stays up.
 *
 * Usage:  node scripts/plano-e2e.mjs <exe> <userData> <port> [appArg...]
 *   e.g.  node scripts/plano-e2e.mjs "C:/Program Files/Electron/electron.exe" "%TEMP%/ud" 9333 "."
 */
import { spawn } from 'node:child_process'
import http from 'node:http'
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const EXE = process.argv[2]
const USER_DATA = process.argv[3]
const PORT = Number(process.argv[4])
const APP_ARGS = process.argv.slice(5)
// Each launch binds its own CDP port: after a quit, the previous instance's network process can
// briefly hold the socket, so a relaunch on the same port would fail to bind (no CDP, no test).

let failures = 0
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`)
  if (!cond) failures += 1
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── seed userData ───────────────────────────────────────────────────────────
const PROJECT = join(tmpdir(), 'plano-e2e-project')
mkdirSync(PROJECT, { recursive: true })
writeFileSync(join(PROJECT, 'package.json'), '{"name":"plano-e2e-project"}\n')

const SPACE_ID = 'space-e2e-1'
const TAB_ID = 'tab-e2e-1'
const PANEL_ID = 'panel-e2e-1'
const state = {
  schemaVersion: 1,
  savedAt: new Date().toISOString(),
  activeId: SPACE_ID,
  workspaces: [
    {
      id: SPACE_ID,
      name: 'E2E Workspace',
      folderPath: PROJECT,
      viewport: { x: 0, y: 0, zoom: 1 },
      regions: [],
      panels: [
        {
          id: PANEL_ID,
          type: 'terminal',
          rect: { x: 100, y: 100, width: 900, height: 500 },
          z: 1,
          title: 'Terminal',
          props: { tabs: [{ id: TAB_ID }], activeTabId: TAB_ID, terminalNumber: 1 },
        },
      ],
    },
  ],
}
mkdirSync(USER_DATA, { recursive: true })
writeFileSync(join(USER_DATA, 'workspaces.json'), JSON.stringify(state, null, 2))
writeFileSync(join(USER_DATA, 'session.json'), JSON.stringify({ folderPath: PROJECT }))
writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({
  version: 9,
  general: { restoreLastWorkspace: true, restoreAgentSessions: false, showFilesOnLaunch: false, warnBeforeQuit: false, confirmClosePanelWithProcess: false },
  appearance: { theme: 'monolith', accent: '#FFFFFF', gridStyle: 'dots', gridOpacity: 1, grain: false, reduceMotion: true },
  editor: { fontSize: 13, tabSize: 2, wordWrap: true, lineNumbers: true },
  terminal: { shell: 'cmd', shellPath: '', fontFamily: '', fontSize: 0, lineHeight: 1.0, cursorStyle: 'bar', cursorBlink: true, scrollback: 5000, theme: 'campbell', copyOnSelect: false, predictiveHistory: false, smartActions: false, autoSuspendIdle: true, keepAgentsOnQuit: true },
  canvas: { snapToGrid: true, showMinimap: false, zoomSensitivity: 1, autosave: true },
  browser: { homepage: 'about:blank', searchEngine: 'google', terminalUrlAction: 'plano' },
  privacy: { telemetry: false, saveTerminalHistory: true },
  advanced: { hardwareAcceleration: true },
  agentMesh: { contextPersistence: false, maxPersistBytes: 524288, mcp: { enabled: false, port: 0, enableMutations: false } },
  voice: { enabled: false, pushToTalkKey: 'Ctrl+Shift+Space', autoSend: true, inputDeviceId: '', language: 'auto', speakResponses: false, gemini: { enabled: true, apiKey: '', model: 'gemini-3.1-flash-lite' }, llmFallback: { enabled: false, baseUrl: 'http://localhost:11434/v1', model: 'llama3.1' } },
}, null, 2))

const HOST_FILE = join(USER_DATA, 'agent-host.json')

// ── CDP helpers ─────────────────────────────────────────────────────────────
async function getJson(path, port = PORT) {
  return new Promise((resolve2, reject) => {
    const req = http.get(`http://127.0.0.1:${port}${path}`, (res) => {
      let data = ''
      res.on('data', (c) => (data += c))
      res.on('end', () => {
        try {
          resolve2(JSON.parse(data))
        } catch {
          reject(new Error('bad json'))
        }
      })
    })
    req.on('error', reject)
    req.setTimeout(1500, () => req.destroy(new Error('timeout')))
  })
}

async function waitForCdp(port, ms = 25000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    try {
      const targets = await getJson('/json', port)
      const page = targets.find((t) => t.type === 'page' && t.url.includes('index.html'))
      if (page) return page
    } catch {
      /* not up yet */
    }
    await sleep(400)
  }
  throw new Error('CDP never came up')
}

async function connectPage(port) {
  const page = await waitForCdp(port)
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  const send = (method, params) =>
    new Promise((res, rej) => {
      const mid = ++id
      pending.set(mid, { res, rej })
      ws.send(JSON.stringify({ id: mid, method, params }))
    })
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? p.rej(new Error(msg.error.message)) : p.res(msg.result)
    }
  }
  await new Promise((r) => (ws.onopen = r))
  const evalJs = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) return { __exception: r.exceptionDetails.exception?.description?.slice(0, 300) }
    return r.result.value
  }
  return { ws, evalJs }
}

let appLog = ''
function launchApp(port) {
  const child = spawn(EXE, [...APP_ARGS, `--remote-debugging-port=${port}`], {
    env: { ...process.env, PLANO_USER_DATA_DIR: USER_DATA },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  child.stdout?.on('data', (d) => (appLog += d))
  child.stderr?.on('data', (d) => (appLog += d))
  child.unref()
  return child
}

function pidAlive(pid) {
  if (!pid || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// ── test body ───────────────────────────────────────────────────────────────
console.log(`== launch 1 (${EXE}) ==`)
let appProc = launchApp(PORT)
const c1 = await connectPage(PORT)

// subscribe to terminal data to discover ptyIds
await c1.evalJs(`window.__ptyLog = []; window.__dataCount = {}; window.__dataText = {};
  window.__unsub = window.plano.terminal.onData(e => {
    if (!window.__ptyLog.includes(e.ptyId)) window.__ptyLog.push(e.ptyId)
    window.__dataCount[e.ptyId] = (window.__dataCount[e.ptyId] || 0) + e.data.length
    window.__dataText[e.ptyId] = (window.__dataText[e.ptyId] || '') + e.data
  }); 'subscribed'`)

// wait for the terminal panel to spawn its shell (prompt data arrives)
let ptyId = null
for (let i = 0; i < 30 && !ptyId; i += 1) {
  await sleep(500)
  const log = await c1.evalJs(`window.__ptyLog`)
  if (Array.isArray(log) && log.length) ptyId = log[0]
}
ok('terminal spawned via Agent Host', !!ptyId, `ptyId=${ptyId}`)

// xterm actually painted?
const painted = await c1.evalJs(`(function(){ const t = document.querySelector('.xterm-rows'); return t ? t.textContent.length : 0 })()`)
ok('xterm rendered content', typeof painted === 'number' && painted > 0, `chars=${painted}`)

// record shell PID (restore lists host sessions with pids)
const restore1 = await c1.evalJs(`window.plano.terminal.restore()`)
const sess1 = Array.isArray(restore1?.sessions) ? restore1.sessions.find((s) => s.ptyId === ptyId) : null
ok('restore lists the live session', !!sess1, JSON.stringify(sess1))
const shellPid = sess1?.pid
ok('shell pid recorded', typeof shellPid === 'number' && shellPid > 0, `pid=${shellPid}`)

// start a long-lived process inside the terminal
await c1.evalJs(`window.plano.terminal.write('${ptyId}', 'ping -t 127.0.0.1\r')`)
await sleep(4000)
const bytes = await c1.evalJs(`window.__dataCount['${ptyId}'] || 0`)
ok('ping output streamed to renderer', typeof bytes === 'number' && bytes > 200, `bytes=${bytes}`)

console.log('== quit app 1 (agents must survive) ==')
await c1.evalJs(`window.plano.window.close()`)
// wait for app process to die
for (let i = 0; i < 40; i += 1) {
  try {
    if (appProc.exitCode !== null || appProc.signalCode) break
  } catch {}
  await sleep(300)
  // poll CDP — once it stops answering, the app is gone
  try {
    await getJson('/json', PORT)
  } catch {
    break
  }
}
await sleep(1500)
ok('app process exited', !pidAlive(appProc.pid ?? -1) || appProc.exitCode !== null)

// The HOST + shell must still be alive
ok('shell survives app quit', pidAlive(shellPid), `pid=${shellPid}`)
const hostFile = existsSync(HOST_FILE) ? JSON.parse(readFileSync(HOST_FILE, 'utf8')) : null
ok('host file survives app quit', !!hostFile)
ok('host process survives app quit', hostFile ? pidAlive(hostFile.pid) : false, `host pid=${hostFile?.pid}`)

console.log('== launch 2 (reattach) ==')
const PORT2 = PORT + 1
appProc = launchApp(PORT2)
const c2 = await connectPage(PORT2)

// fresh collector — will fill only AFTER the terminal reattaches
await c2.evalJs(`window.__ptyLog2 = []; window.__dataText2 = {};
  window.__unsub2 = window.plano.terminal.onData(e => {
    if (!window.__ptyLog2.includes(e.ptyId)) window.__ptyLog2.push(e.ptyId)
    window.__dataText2[e.ptyId] = (window.__dataText2[e.ptyId] || '') + e.data
  }); 'subscribed2'`)

// the restored session must be the SAME ptyId + SAME shell pid
let restore2 = null
for (let i = 0; i < 20; i += 1) {
  await sleep(500)
  restore2 = await c2.evalJs(`window.plano.terminal.restore()`)
  if (Array.isArray(restore2?.sessions) && restore2.sessions.length) break
}
const sess2 = Array.isArray(restore2?.sessions) ? restore2.sessions.find((s) => s.ptyId === ptyId) : null
ok('relaunch restores the same session', !!sess2, JSON.stringify(sess2))
ok('same shell pid after relaunch', sess2?.pid === shellPid, `pid=${sess2?.pid} vs ${shellPid}`)

// the panel reattached and the live stream resumed (ping keeps printing)
// Diagnostics first: what ptyIds did we see, and what does the full session list look like?
const ptyLog2 = await c2.evalJs(`window.__ptyLog2`)
console.log('  [dbg] launch2 ptyIds seen:', JSON.stringify(ptyLog2))
console.log('  [dbg] launch2 full restore:', JSON.stringify(restore2?.sessions))
console.log('  [dbg] xterm present:', await c2.evalJs(`!!document.querySelector('.xterm')`))
console.log('  [dbg] xterm text:', JSON.stringify((await c2.evalJs(`document.querySelector('.xterm-rows')?.textContent.slice(0,120) ?? ''`))))
console.log('  [dbg] renderer pty traces:', (appLog.match(/\[pty-dbg\][^\n]*/g) || []).slice(-12).join(' | '))
let streamed2 = 0
for (let i = 0; i < 12; i += 1) {
  await sleep(500)
  streamed2 = await c2.evalJs(`(window.__dataText2['${ptyId}'] || '').length`)
  if (streamed2 > 50) break
}
ok('live stream resumed after reattach', typeof streamed2 === 'number' && streamed2 > 50, `chars=${streamed2}`)

// writing from the NEW app must land in the SAME shell — interrupt the busy ping first, then echo
await c2.evalJs(`window.plano.terminal.write('${ptyId}', '\\x03')`)
await sleep(800)
await c2.evalJs(`window.plano.terminal.write('${ptyId}', 'echo REATTACHED-OK\\r')`)
await sleep(2500)
const text2 = await c2.evalJs(`window.__dataText2['${ptyId}'] || ''`)
ok('write from new app reaches the same shell', typeof text2 === 'string' && text2.includes('REATTACHED-OK'))

// xterm content includes the replayed scrollback (ping lines)
const xterm2 = await c2.evalJs(`(function(){ const t = document.querySelector('.xterm-rows'); return t ? t.textContent : '' })()`)
console.log('  [dbg] xterm text head:', JSON.stringify(xterm2.slice(0, 200)))
const rawAttach = await c2.evalJs(`window.plano.terminal.attach('${ptyId}').then(r => ({ ok: r.ok, exited: r.exited, len: (r.buffer||'').length, head: (r.buffer||'').slice(0,120), tail: (r.buffer||'').slice(-200) }))`)
console.log('  [dbg] raw attach replay:', JSON.stringify(rawAttach))
ok('xterm shows replayed + live content', typeof xterm2 === 'string' && (xterm2.includes('Reply from') || xterm2.includes('REATTACHED-OK')))

// ── kill the terminal from the new app ──────────────────────────────────────
await c2.evalJs(`window.plano.terminal.kill('${ptyId}')`)
await sleep(1500)
ok('kill terminates the shell', !pidAlive(shellPid))
const hostStill = existsSync(HOST_FILE) ? JSON.parse(readFileSync(HOST_FILE, 'utf8')) : null
ok('host still up after terminal kill', hostStill ? pidAlive(hostStill.pid) : false)

// cleanup: close app + wait for it to fully exit + stop the host so no leftovers pin the port
await c2.evalJs(`window.plano.window.close()`).catch(() => {})
for (let i = 0; i < 30; i += 1) {
  try {
    await getJson('/json', PORT2)
  } catch {
    break
  }
  await sleep(300)
}
const hostClean = existsSync(HOST_FILE) ? JSON.parse(readFileSync(HOST_FILE, 'utf8')) : null
if (hostClean) {
  try {
    const { execFileSync } = await import('node:child_process')
    execFileSync('taskkill', ['/PID', String(hostClean.pid), '/F', '/T'], { stdio: 'ignore' })
  } catch {}
}
await sleep(1000)

console.log(failures === 0 ? '\nE2E ALL PASSED' : `\nE2E ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
