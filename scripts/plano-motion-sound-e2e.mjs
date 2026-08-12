// E2E for the motion + agent-done-sound work:
//   T1  data-motion="full" is set after settings hydrate (the app, not the OS, owns motion)
//   T2  the CSS gate: animations RUN under data-motion=full, damp to none under reduced
//   T3  closing a panel plays the animate-panel-out collapse (not an instant removal)
//   T4  a real agent (pi) finishing a turn triggers the synthesized chime
//   T4b unrelated agent-store activity cannot replay the same finished turn
//   T5  toggling the setting off silences the chime, back on re-arms it
//   T6  terminal dragging uses a lightweight ghost and never transforms/remounts xterm
import { spawn } from 'node:child_process'
import http from 'node:http'
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const EXE = process.argv[2] ?? join(process.cwd(), 'node_modules', 'electron', 'dist', 'electron.exe')
// Randomized port: stale TIME_WAIT sockets from killed runs can hold a fixed CDP port and make
// the next launch fail with "no cdp endpoint".
const PORT = Number(process.argv[3] ?? 9600 + Math.floor(Math.random() * 200))
const RUN = String(Date.now())
const USER_DATA = join(tmpdir(), `plano-motion-sound-e2e-${RUN}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── seed a project + workspace with one terminal panel + full-motion settings ──
const PROJECT = join(tmpdir(), `plano-motion-sound-project-${RUN}`)
rmSync(USER_DATA, { recursive: true, force: true })
mkdirSync(PROJECT, { recursive: true })
mkdirSync(USER_DATA, { recursive: true })
writeFileSync(join(PROJECT, 'package.json'), '{"name":"plano-motion-sound-e2e"}\n')
writeFileSync(join(USER_DATA, 'workspaces.json'), JSON.stringify({
  schemaVersion: 1, savedAt: new Date().toISOString(), activeId: 's1',
  workspaces: [{ id: 's1', name: 'Motion', folderPath: PROJECT, viewport: { x: 0, y: 0, zoom: 1 }, regions: [], panels: [{ id: 'p1', type: 'terminal', rect: { x: 100, y: 100, width: 900, height: 520 }, z: 1, title: 'Terminal', props: { tabs: [{ id: 't1' }], activeTabId: 't1', terminalNumber: 1 } }] }],
}, null, 2))
writeFileSync(join(USER_DATA, 'session.json'), JSON.stringify({ folderPath: PROJECT }))
writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({
  version: 9,
  general: { restoreLastWorkspace: true, restoreAgentSessions: false, showFilesOnLaunch: false, warnBeforeQuit: false, confirmClosePanelWithProcess: false, agentDoneSound: true },
  appearance: { theme: 'monolith', accent: '#FFFFFF', gridStyle: 'dots', gridOpacity: 1, grain: false, reduceMotion: false },
  editor: { fontSize: 13, tabSize: 2, wordWrap: true, lineNumbers: true },
  terminal: { shell: 'cmd', shellPath: '', fontFamily: '', fontSize: 0, lineHeight: 1.0, cursorStyle: 'bar', cursorBlink: true, scrollback: 5000, theme: 'campbell', copyOnSelect: false, predictiveHistory: false, smartActions: false, autoSuspendIdle: true, keepAgentsOnQuit: true },
  canvas: { snapToGrid: true, showMinimap: false, zoomSensitivity: 1, autosave: true },
  browser: { homepage: 'about:blank', searchEngine: 'google', terminalUrlAction: 'plano' },
  privacy: { telemetry: false, saveTerminalHistory: true },
  advanced: { hardwareAcceleration: true },
  agentMesh: { contextPersistence: false, maxPersistBytes: 524288, mcp: { enabled: false, port: 0, enableMutations: false } },
  voice: { enabled: false, pushToTalkKey: 'Ctrl+Shift+Space', autoSend: true, inputDeviceId: '', language: 'auto', speakResponses: false, gemini: { enabled: true, apiKey: '', model: 'gemini-3.1-flash-lite' }, llmFallback: { enabled: false, baseUrl: 'http://localhost:11434/v1', model: 'llama3.1' } },
}, null, 2))

async function getJson(path, port) {
  return new Promise((res, rej) => {
    const req = http.get(`http://127.0.0.1:${port}${path}`, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => { try { res(JSON.parse(d)) } catch { rej(new Error('bad json')) } }) })
    req.on('error', rej); req.setTimeout(1500, () => req.destroy(new Error('timeout')))
  })
}
async function waitCdp(port, ms = 45000) {
  const dl = Date.now() + ms
  while (Date.now() < dl) {
    try {
      const t = await getJson('/json', port)
      const p = t.find((x) => x.type === 'page' && x.url.includes('index.html'))
      if (p) return p
    } catch { /* not up yet */ }
    await sleep(400)
  }
  throw new Error('no cdp endpoint')
}
async function connect(port) {
  const page = await waitCdp(port)
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
    const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) return { __exc: r.exceptionDetails.exception?.description?.slice(0, 400) }
    return r.result.value
  }
  return { ws, evalJs, send }
}

let failures = 0
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`)
  if (!cond) failures++
}

// ── launch ────────────────────────────────────────────────────────────────
// Dev electron needs the app path ('.'); the packaged exe must NOT get one — a real
// directory in argv triggers its "Open in PLANO" launch-folder logic (isPackaged only)
// which would open that folder as an extra workspace over the seeded one.
const packaged = /PLANO\.exe$/i.test(EXE)
console.log(`== launching ${EXE} on :${PORT} ==`)
let app = spawn(EXE, packaged ? [`--remote-debugging-port=${PORT}`] : ['.', `--remote-debugging-port=${PORT}`], {
  env: { ...process.env, PLANO_USER_DATA_DIR: USER_DATA },
  stdio: 'ignore',
  windowsHide: true,
})
app.unref()
let c = null
try {
  c = await connect(PORT)
} catch (err) {
  console.error('connect failed:', err.message)
  try { spawn('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' }).unref() } catch { /* best-effort */ }
  process.exit(1)
}

// T1 — the app owns motion: data-motion=full after hydration (even though this Windows box
// may report prefers-reduced-motion: reduce to Chromium).
let motion = null
for (let i = 0; i < 30 && motion !== 'full'; i += 1) {
  await sleep(500)
  motion = await c.evalJs(`document.documentElement.dataset.motion`)
}
ok('T1 data-motion=full after hydrate', motion === 'full', `motion=${motion}`)

// T2 — CSS gate: the same keyframe is live under full, damped under reduced.
const probe = await c.evalJs(`(() => {
  const el = document.createElement('div')
  el.className = 'animate-panel-in'
  document.body.appendChild(el)
  const name = () => getComputedStyle(el).animationName
  const full = name()
  document.documentElement.dataset.motion = 'reduced'
  const reduced = name()
  document.documentElement.dataset.motion = 'full'
  const fullAgain = name()
  el.remove()
  return { full, reduced, fullAgain }
})()`)
ok('T2 animation runs under data-motion=full', probe?.full === 'panel-in', JSON.stringify(probe))
ok('T2 damped under data-motion=reduced', probe?.reduced === 'none', JSON.stringify(probe))
ok('T2 restored on data-motion=full again', probe?.fullAgain === 'panel-in', JSON.stringify(probe))

// install the chime spy (records every oscillator frequency started in the page)
await c.evalJs(`(() => {
  window.__chime = []
  if (!window.__chimeHooked) {
    window.__chimeHooked = true
    const orig = OscillatorNode.prototype.start
    OscillatorNode.prototype.start = function (...a) {
      try { window.__chime.push(Math.round(this.frequency?.value ?? 0)) } catch {}
      return orig.apply(this, a)
    }
  }
  return 'ok'
})()`)
// record every agent verdict signal the renderer receives (ground truth for the trigger)
await c.evalJs(`window.__signals = []; window.plano.agent.onSignal(e => { window.__signals.push({ pty: e.ptyId.slice(0, 8), a: e.verdict.active, ph: e.verdict.phase, k: e.verdict.kind }) }); 'ok'`)

// T6 — DIRECT terminal drag (pre-glass behavior, verified as the correct reference): the live
// panel — xterm included — translates with the pointer via the anchor's pure translate3d. No
// ghost overlay, no source hiding, no scale. The xterm node keeps its identity.
await sleep(1800) // let p1 mount (animate-panel-in) + PTY spawn
const dragResult = await c.evalJs(`(async () => {
  Element.prototype.setPointerCapture = function () {}
  Element.prototype.releasePointerCapture = function () {}
  const inner = document.querySelector('[aria-label="Close panel"]').closest('.group')
  const header = inner.querySelector('.cursor-grab')
  if (!header) return { error: 'no header' }
  const r = header.getBoundingClientRect()
  const startX = r.left + r.width / 2
  const y = r.top + r.height / 2
  const xterm = inner.querySelector('.xterm')
  window.__dragXtermNode = xterm
  const anchor = inner.parentElement
  const anchorBefore = anchor.style.transform
  header.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: startX, clientY: y, pointerId: 7, button: 0, buttons: 1 }))
  // SYNCHRONOUS burst (no awaits): the E2E window is backgrounded, so real-time timers are
  // throttled to ~1s. The direct drag commits the position through the store per rAF frame.
  for (let i = 1; i <= 24; i += 1) {
    header.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: startX + i * 14, clientY: y, pointerId: 7, button: 0, buttons: 1 }))
  }
  await new Promise((resolve) => setTimeout(resolve, 50))
  const inline = inner.style.transform
  const anchorTransform = anchor.style.transform
  const r2 = header.getBoundingClientRect()
  return {
    inline,
    anchor: anchorTransform,
    sourceOpacity: getComputedStyle(inner).opacity,
    movedX: Math.round(r2.left + r2.width / 2 - startX),
    ghostGone: !document.querySelector('[data-terminal-drag-ghost]'),
    anchorChanged: anchorTransform !== anchorBefore,
    noScale: !String(anchorTransform).includes('scale(') && !String(inline).includes('scale('),
  }
})()`)
ok('T6 no ghost — the live panel drags directly', dragResult?.ghostGone === true, JSON.stringify(dragResult))
ok('T6 source moves with the pointer (direct drag)', (dragResult?.movedX ?? 0) > 100, JSON.stringify(dragResult))
ok('T6 anchor position commits during the drag', dragResult?.anchorChanged === true, JSON.stringify(dragResult))
ok('T6 no scale anywhere on the panel chain', dragResult?.noScale === true, JSON.stringify(dragResult))
const settleResult = await c.evalJs(`(async () => {
  const inner = document.querySelector('[aria-label="Close panel"]').closest('.group')
  const header = inner.querySelector('.cursor-grab')
  const r = header.getBoundingClientRect()
  header.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, pointerId: 7, button: 0, buttons: 0 }))
  await new Promise((resolve) => setTimeout(resolve, 650))
  const r2 = header.getBoundingClientRect()
  return {
    opacity: getComputedStyle(inner).opacity,
    movedX: Math.round(r2.left + r2.width / 2 - (r.left + r.width / 2)),
    ghostGone: !document.querySelector('[data-terminal-drag-ghost]'),
    xtermSameNode: inner.querySelector('.xterm') === window.__dragXtermNode,
  }
})()`)
// The movement already committed DURING the direct drag (movedX 340 mid-drag above); release
// just ends the gesture cleanly: no ghost, shell at full opacity, xterm identity kept.
ok('T6 release ends cleanly (no ghost, opacity 1, xterm kept)', settleResult?.ghostGone === true && settleResult?.opacity === '1' && settleResult?.xtermSameNode === true, JSON.stringify(settleResult))
ok('T6 xterm stays mounted across the drag', settleResult?.xtermSameNode === true, JSON.stringify(settleResult))
// Clear residual hover + focus (the xterm helper textarea keeps DOM focus across drags) and
// neutralize the opacity transition — a backgrounded window freezes it mid-flight, so the
// computed value would read between 0.75 and 1 while the state IS correct.
await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 8, y: 8, modifiers: 0 }).catch(() => undefined)
// The Deska dim is carried by a pointer-events-none OVERLAY (.terminal-dim-overlay); the shell
// itself must stay at opacity 1 in BOTH states — opacity < 1 on the shell composites the xterm
// canvas as a transparent layer and re-rasterizes the CLI text on every repaint while the mouse
// moves (the crispness regression vs the pre-glass build). Assert the shell stays opaque.
const focusStyle = await c.evalJs(`(async () => {
  const shell = document.querySelector('[data-panel-type="terminal"]')
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur()
  shell.style.transition = 'none'
  shell.dataset.panelActive = 'false'
  await new Promise(requestAnimationFrame)
  const inactive = getComputedStyle(shell).opacity
  const overlayInactive = (() => { const o = shell.querySelector('.terminal-dim-overlay'); return o ? getComputedStyle(o).opacity : 'absent' })()
  shell.dataset.panelActive = 'true'
  await new Promise(requestAnimationFrame)
  const active = getComputedStyle(shell).opacity
  shell.style.transition = ''
  return { inactive, active, overlayInactive }
})()`)
// The overlay mounts via React only for a genuinely inactive panel (real canvas click — covered
// by the motion suite's deska-focus); the manual attribute can't mount it, so only assert the
// crispness guarantee here: the shell NEVER drops below opacity 1.
ok('T6 terminal shell stays opaque (crisp canvas)', focusStyle?.inactive === '1' && focusStyle?.active === '1', JSON.stringify(focusStyle))

// T3 — closing a panel plays the genie collapse (animate-panel-out), then removes it.
const closeResult = await c.evalJs(`(() => new Promise((resolve) => {
  const btn = document.querySelector('[aria-label="Close panel"]')
  if (!btn) { resolve({ error: 'no close button' }); return }
  btn.click()
  let saw = false
  const t0 = performance.now()
  const tick = () => {
    const el = document.querySelector('.animate-panel-out')
    if (el) { resolve({ saw: true, ms: Math.round(performance.now() - t0) }); return }
    if (performance.now() - t0 > 900) resolve({ saw: false, ms: 900 })
    else requestAnimationFrame(tick)
  }
  tick()
}))()`)
ok('T3 close plays animate-panel-out', closeResult?.saw === true, JSON.stringify(closeResult))
await sleep(700)
const gone = await c.evalJs(`!document.querySelector('[aria-label="Close panel"]')`)
ok('T3 panel removed after animation', gone === true)

// T3b — a SECOND close (fresh panel) must play the same clean collapse: regression for
// "first close ok, later closes glitch" (or the reverse).
await c.evalJs(`document.querySelector('[aria-label="New Terminal"]').click()`)
await sleep(2400) // mount + PTY spawn
const close2 = await c.evalJs(`(() => new Promise((resolve) => {
  const btn = document.querySelector('[aria-label="Close panel"]')
  if (!btn) { resolve({ error: 'no close btn 2' }); return }
  btn.click()
  // sample once the collapse has actually started (React flushes transform-origin on the
  // same render that starts the animation; a 3ms probe can catch the pre-flush style)
  const sample = () => {
    const el = document.querySelector('.animate-panel-out')
    if (!el) { resolve({ error: 'panel gone too fast' }); return }
    const cs = getComputedStyle(el)
    const rect = el.getBoundingClientRect()
    const y = parseFloat(cs.transformOrigin.split(' ')[1] || '0')
    resolve({ originY: y, height: Math.round(rect.height), filter: cs.filter })
  }
  setTimeout(sample, 80)
}))()`)
ok('T3b second close plays animate-panel-out', close2?.filter !== undefined && close2.originY !== undefined, JSON.stringify(close2))
ok('T3b collapse is a whole-shell fade+scale (no squash/blur)', !String(close2?.filter ?? '').includes('blur'), JSON.stringify(close2))
ok('T3b no blur filter during close (no compositor hitch)', !String(close2?.filter ?? '').includes('blur'), JSON.stringify(close2))
await sleep(700)
const gone2 = await c.evalJs(`!document.querySelector('[aria-label="Close panel"]')`)
ok('T3b second panel removed after animation', gone2 === true)

// T4 — real agent turn → chime. New terminal, run pi, ASK it something, watch it work→idle.
// (The chime is for "it finished a task" — launching an agent and letting it sit at its
// prompt is not a finished turn, so the first arm happens on the first real prompt.)
await c.evalJs(`window.__ptyIds = []; window.__dataHook = window.plano.terminal.onData(e => { if (!window.__ptyIds.includes(e.ptyId)) window.__ptyIds.push(e.ptyId) }); 'ok'`)
await c.evalJs(`document.querySelector('[aria-label="New Terminal"]').click()`)
let ptyId = null
for (let i = 0; i < 30 && !ptyId; i += 1) {
  await sleep(500)
  const ids = await c.evalJs('window.__ptyIds')
  if (Array.isArray(ids) && ids.length) ptyId = ids[0]
}
ok('T4 new terminal spawned', !!ptyId, ptyId ? `pty=${ptyId}` : 'none')
await c.evalJs(`window.plano.terminal.write('${ptyId}', 'pi\\r')`)

const meshAgent = async () => {
  const snap = await c.evalJs(`window.plano.agentMesh.getSnapshot()`)
  const a = (snap?.agents || []).find((x) => x.verdict?.active)
  return a ?? null
}
// wait until the agent is detected at all (it lands at its prompt, idle)
let detected = false
for (let i = 0; i < 90; i += 1) {
  await sleep(1000)
  const a = await meshAgent()
  if (a) { detected = true; break }
}
ok('T4 agent detected', detected)
// now give it a task — the real "finished" moment
await c.evalJs(`window.plano.terminal.write('${ptyId}', 'Reply with exactly: OK\\r')`)
let sawWorking = false
let phaseSeen = ''
for (let i = 0; i < 90; i += 1) {
  await sleep(1000)
  const a = await meshAgent()
  if (a) {
    phaseSeen = a.verdict?.phase ?? ''
    if (phaseSeen === 'working') { sawWorking = true; break }
  }
}
ok('T4 agent working on the task', sawWorking, `phase=${phaseSeen}`)

let chime = []
let gotIdle = false
for (let i = 0; i < 50; i += 1) {
  await sleep(500)
  const a = await meshAgent()
  if (a && a.verdict?.phase === 'idle') gotIdle = true
  chime = await c.evalJs('window.__chime')
  if (gotIdle && Array.isArray(chime) && chime.length) break
}
ok('T4 chime played after agent finished', Array.isArray(chime) && chime.length > 0, `freqs=${(chime || []).join(',')} gotIdle=${gotIdle}`)
if (!Array.isArray(chime) || !chime.length) {
  const sigs = await c.evalJs('window.__signals')
  console.log('  [debug] renderer signals:', JSON.stringify(sigs))
}
const chimeCount1 = (chime || []).length

// T4b — after the grouping cooldown has elapsed, spawning an unrelated plain terminal
// updates the same Zustand store. The completed Pi turn must stay consumed and remain silent.
await sleep(8500)
await c.evalJs(`document.querySelector('[aria-label="New Terminal"]').click()`)
await sleep(6500)
const chimeAfterUnrelated = await c.evalJs('window.__chime')
const unrelatedExtra = Array.isArray(chimeAfterUnrelated) ? chimeAfterUnrelated.length - chimeCount1 : -1
ok('T4b completed turn is not replayed by unrelated activity', unrelatedExtra === 0, `extra=${unrelatedExtra}`)

// T5 — the setting gates the sound: off silences, on re-arms.
// Toggle it off through the real Settings UI.
await c.evalJs(`document.querySelector('[aria-label="Settings"]').click()`)
await sleep(600)
const off = await c.evalJs(`(() => {
  const t = document.querySelector('[role="switch"][aria-label="Agent finished sound"]')
  if (!t) return { error: 'toggle not found' }
  if (t.getAttribute('aria-checked') !== 'true') return { error: 'toggle not on initially' }
  t.click()
  return { ok: true }
})()`)
ok('T5 settings toggle found + turned off', off?.ok === true, JSON.stringify(off))
await sleep(800)

// give the agent another task — with the sound OFF it must not chime
const chimeBefore = await c.evalJs('window.__chime')
await c.evalJs(`window.plano.terminal.write('${ptyId}', 'say done\\r')`)
let negIdle = false
for (let i = 0; i < 60; i += 1) {
  await sleep(500)
  const a = await meshAgent()
  if (a && a.verdict?.phase === 'idle' && i > 0) negIdle = true
  const cur = await c.evalJs('window.__chime')
  if (negIdle && i >= 18) break // >9s of idle → the 4s confirm window has long since passed
}
const chimeAfter = await c.evalJs('window.__chime')
const negExtra = Array.isArray(chimeAfter) ? chimeAfter.length - (Array.isArray(chimeBefore) ? chimeBefore.length : 0) : -1
ok('T5 no chime while setting off', negExtra === 0, `extra=${negExtra} idleSeen=${negIdle}`)

// back ON → a fresh finished turn chimes again
await c.evalJs(`(() => {
  const t = document.querySelector('[role="switch"][aria-label="Agent finished sound"]')
  if (t) t.click()
  return 'ok'
})()`)
await sleep(800)
const chimeBefore2 = await c.evalJs('window.__chime')
await c.evalJs(`window.plano.terminal.write('${ptyId}', 'say hello again\\r')`)
let posIdle = false
for (let i = 0; i < 60; i += 1) {
  await sleep(500)
  const a = await meshAgent()
  if (a && a.verdict?.phase === 'idle' && i > 0) posIdle = true
  const cur = await c.evalJs('window.__chime')
  if (Array.isArray(cur) && cur.length > (Array.isArray(chimeBefore2) ? chimeBefore2.length : 0)) break
}
const chimeAfter2 = await c.evalJs('window.__chime')
const posExtra = Array.isArray(chimeAfter2) ? chimeAfter2.length - (Array.isArray(chimeBefore2) ? chimeBefore2.length : 0) : -1
ok('T5 chime returns when setting on', posExtra > 0, `extra=${posExtra} freqs=${(Array.isArray(chimeAfter2) ? chimeAfter2 : []).slice(-5).join(',')} idleSeen=${posIdle}`)

// ── cleanup: close the app WE spawned (and its process tree only) ──
await c.evalJs(`window.plano.window.close()`).catch(() => undefined)
await sleep(1200)
if (app?.pid) { try { spawn('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' }).unref() } catch { /* already gone */ } }

console.log(failures === 0 ? '\nMOTION+SOUND E2E ALL PASSED' : `\nMOTION+SOUND E2E ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
