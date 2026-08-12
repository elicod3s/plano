import { spawn } from 'node:child_process'
import http from 'node:http'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const EXE = process.argv[2] ?? join(process.cwd(), 'node_modules', 'electron', 'dist', 'electron.exe')
const PORT = Number(process.argv[3] ?? 9460)
const RESULT_PATH = process.argv[4] ? resolve(process.argv[4]) : null
const TEMPLATE = resolve('.plano-tests', 'motion-stress', 'workspaces.json')
const USER_DATA = mkdtempSync(join(tmpdir(), 'plano-smoothness-'))
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

writeFileSync(join(USER_DATA, 'workspaces.json'), readFileSync(TEMPLATE))
writeFileSync(join(USER_DATA, 'session.json'), JSON.stringify({ folderPath: process.cwd() }))
writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({
  version: 9,
  general: { restoreLastWorkspace: true, restoreAgentSessions: false, showFilesOnLaunch: false, warnBeforeQuit: false, confirmClosePanelWithProcess: false, agentDoneSound: false },
  appearance: { theme: 'monolith', accent: '#FFFFFF', gridStyle: 'dots', gridOpacity: 1, grain: true, reduceMotion: false },
  editor: { fontSize: 13, tabSize: 2, wordWrap: true, lineNumbers: true },
  terminal: { shell: 'cmd', shellPath: '', fontFamily: '', fontSize: 0, lineHeight: 1.4, cursorStyle: 'bar', cursorBlink: false, scrollback: 1000, theme: 'campbell', copyOnSelect: false, predictiveHistory: false, smartActions: false, autoSuspendIdle: true, keepAgentsOnQuit: false },
  canvas: { snapToGrid: true, showMinimap: true, zoomSensitivity: 1, autosave: false },
  browser: { homepage: 'about:blank', searchEngine: 'google', terminalUrlAction: 'plano' },
  privacy: { telemetry: false, saveTerminalHistory: false },
  advanced: { hardwareAcceleration: true },
  agentMesh: { contextPersistence: false, maxPersistBytes: 524288, mcp: { enabled: false, port: 0, enableMutations: false } },
  voice: { enabled: false, pushToTalkKey: 'Ctrl+Shift+Space', autoSend: true, inputDeviceId: '', language: 'auto', speakResponses: false, gemini: { enabled: false, apiKey: '', model: 'gemini-3.1-flash-lite' }, llmFallback: { enabled: false, baseUrl: 'http://localhost:11434/v1', model: 'llama3.1' } },
}))

function getJson(path) {
  return new Promise((resolveJson, reject) => {
    const req = http.get(`http://127.0.0.1:${PORT}${path}`, (response) => {
      let body = ''
      response.on('data', (chunk) => { body += chunk })
      response.on('end', () => {
        try { resolveJson(JSON.parse(body)) } catch (error) { reject(error) }
      })
    })
    req.on('error', reject)
    req.setTimeout(1200, () => req.destroy(new Error('timeout')))
  })
}

async function connect() {
  const deadline = Date.now() + 45000
  let page
  while (Date.now() < deadline) {
    try {
      const targets = await getJson('/json')
      page = targets.find((target) => target.type === 'page' && target.url.includes('index.html'))
      if (page) break
    } catch { /* app is still starting */ }
    await sleep(300)
  }
  if (!page) throw new Error('No CDP page')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  const pending = new Map()
  let id = 0
  await new Promise((done, reject) => {
    ws.onopen = done
    ws.onerror = reject
  })
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data)
    const callback = pending.get(message.id)
    if (!callback) return
    pending.delete(message.id)
    message.error ? callback.reject(new Error(message.error.message)) : callback.resolve(message.result)
  }
  const send = (method, params = {}) => new Promise((resolveMessage, reject) => {
    const messageId = ++id
    pending.set(messageId, { resolve: resolveMessage, reject })
    ws.send(JSON.stringify({ id: messageId, method, params }))
  })
  const evaluate = async (expression) => {
    const response = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? 'evaluate failed')
    return response.result.value
  }
  return { ws, send, evaluate }
}

const packaged = /PLANO\.exe$/i.test(EXE)
const timingFlags = ['--disable-background-timer-throttling', '--disable-renderer-backgrounding']
const args = packaged
  ? [`--remote-debugging-port=${PORT}`, `--user-data-dir=${USER_DATA}`, ...timingFlags]
  : ['.', `--remote-debugging-port=${PORT}`, ...timingFlags]
const app = spawn(EXE, args, { env: { ...process.env, PLANO_USER_DATA_DIR: USER_DATA }, stdio: 'ignore', windowsHide: true })
let c
try {
  c = await connect()
  await c.send('Performance.enable')
  for (let i = 0; i < 80; i += 1) {
    const count = await c.evaluate(`document.querySelectorAll('[aria-label="Close panel"]').length`)
    if (count >= 56) break
    await sleep(250)
  }
  await sleep(1800)

  const dom = await c.evaluate(`(() => {
    const controls = [...document.querySelectorAll('[aria-label="Hide map"]')]
      .map((node) => node.closest('[data-surface-layer="chrome"]'))
      .find(Boolean)
    const minimap = [...document.querySelectorAll('[data-surface-layer="popover"]')]
      .find((node) => node.querySelector('.label-caps')?.textContent?.trim() === 'Map')
    const controlsRect = controls?.getBoundingClientRect()
    const minimapRect = minimap?.getBoundingClientRect()
    return {
      panels: document.querySelectorAll('[aria-label="Close panel"]').length,
      terminals: document.querySelectorAll('.xterm').length,
      canvases: document.querySelectorAll('.xterm canvas').length,
      domRows: document.querySelectorAll('.xterm-rows').length,
      minimapGap: controlsRect && minimapRect ? Math.round(controlsRect.left - minimapRect.right) : null,
    }
  })()`)

  const metrics = async () => {
    const response = await c.send('Performance.getMetrics')
    return Object.fromEntries(response.metrics.map(({ name, value }) => [name, value]))
  }
  const idleStart = await metrics()
  await sleep(2200)
  const idleEnd = await metrics()

  const pan = await c.evaluate(`(async () => {
    Element.prototype.setPointerCapture = function () {}
    Element.prototype.releasePointerCapture = function () {}
    const root = document.querySelector('[data-canvas-background]')
    const samples = []
    let previous = performance.now()
    root.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 80, clientY: 130, pointerId: 71, button: 0, buttons: 1 }))
    for (let i = 0; i < 150; i += 1) {
      await new Promise(requestAnimationFrame)
      const now = performance.now()
      samples.push(now - previous)
      previous = now
      root.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 80 + i * 2, clientY: 130 + Math.sin(i / 8) * 30, pointerId: 71, button: 0, buttons: 1 }))
    }
    root.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 380, clientY: 130, pointerId: 71, button: 0, buttons: 0 }))
    samples.sort((a, b) => a - b)
    return { avg: samples.reduce((a, b) => a + b, 0) / samples.length, p95: samples[Math.floor(samples.length * .95)], max: samples.at(-1), over25: samples.filter((v) => v > 25).length }
  })()`)

  const drag = await c.evaluate(`(async () => {
    const shell = document.querySelector('[data-panel-type="terminal"]')
    const header = shell.querySelector('.cursor-grab')
    const rect = header.getBoundingClientRect()
    const sx = rect.left + rect.width / 2, sy = rect.top + rect.height / 2
    const samples = []
    let previous = performance.now()
    header.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: sx, clientY: sy, pointerId: 72, button: 0, buttons: 1 }))
    for (let i = 0; i < 150; i += 1) {
      await new Promise(requestAnimationFrame)
      const now = performance.now()
      samples.push(now - previous)
      previous = now
      header.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: sx + i * 1.6, clientY: sy + Math.sin(i / 10) * 20, pointerId: 72, button: 0, buttons: 1 }))
    }
    const ghost = shell.parentElement.querySelector('[data-terminal-drag-ghost]')
    const ghostTransform = ghost?.style.transform ?? null
    const sourceOpacityDuring = getComputedStyle(shell).opacity
    const sourceTransformDuring = shell.style.transform
    header.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: sx + 240, clientY: sy, pointerId: 72, button: 0, buttons: 0 }))
    samples.sort((a, b) => a - b)
    return { avg: samples.reduce((a, b) => a + b, 0) / samples.length, p95: samples[Math.floor(samples.length * .95)], max: samples.at(-1), over25: samples.filter((v) => v > 25).length, ghostTransform, sourceOpacityDuring, sourceTransformDuring, ghostGoneAfter: !document.querySelector('[data-terminal-drag-ghost]') }
  })()`)

  const output = JSON.stringify({
    executable: EXE,
    dom,
    idle: {
      layouts: (idleEnd.LayoutCount ?? 0) - (idleStart.LayoutCount ?? 0),
      recalcStyles: (idleEnd.RecalcStyleCount ?? 0) - (idleStart.RecalcStyleCount ?? 0),
      scriptMs: Math.round(((idleEnd.ScriptDuration ?? 0) - (idleStart.ScriptDuration ?? 0)) * 1000),
    },
    pan,
    drag,
  }, null, 2)
  if (RESULT_PATH) writeFileSync(RESULT_PATH, output)
  console.log(output)
  c.ws.close()
} finally {
  await sleep(500)
  if (!app.killed) app.kill()
  await sleep(800)
}
