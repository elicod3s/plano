import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const executable = resolve(process.argv[2])
const port = Number(process.argv[3] ?? 9464)
const resultPath = process.argv[4] ? resolve(process.argv[4]) : null
const userData = mkdtempSync(join(tmpdir(), 'plano-popover-drag-'))
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

writeFileSync(
  join(userData, 'workspaces.json'),
  JSON.stringify({
    schemaVersion: 1,
    savedAt: new Date().toISOString(),
    activeId: 'popover-drag-test',
    workspaces: [{
      id: 'popover-drag-test',
      name: 'Popover drag test',
      folderPath: process.cwd(),
      viewport: { x: 80, y: 80, zoom: 1 },
      regions: [],
      panels: [{
        id: 'sticky-test',
        type: 'sticky',
        rect: { x: 100, y: 100, width: 360, height: 260 },
        z: 1,
        title: 'Drag test',
        props: { text: 'Drag test', tone: 'graphite' },
      }],
    }],
  }),
)
writeFileSync(join(userData, 'session.json'), JSON.stringify({ folderPath: process.cwd() }))
writeFileSync(join(userData, 'settings.json'), JSON.stringify({
  version: 9,
  general: { restoreLastWorkspace: true, restoreAgentSessions: false, showFilesOnLaunch: false, warnBeforeQuit: false, confirmClosePanelWithProcess: false, agentDoneSound: false },
  appearance: { theme: 'monolith', accent: '#FFFFFF', gridStyle: 'dots', gridOpacity: 1, grain: false, reduceMotion: false },
  editor: { fontSize: 13, tabSize: 2, wordWrap: true, lineNumbers: true },
  terminal: { shell: 'cmd', shellPath: '', fontFamily: '', fontSize: 0, lineHeight: 1.4, cursorStyle: 'bar', cursorBlink: false, scrollback: 1000, theme: 'campbell', copyOnSelect: false, predictiveHistory: false, smartActions: false, autoSuspendIdle: true, keepAgentsOnQuit: false },
  canvas: { snapToGrid: false, showMinimap: false, zoomSensitivity: 1, autosave: false },
  browser: { homepage: 'about:blank', searchEngine: 'google', terminalUrlAction: 'plano' },
  privacy: { telemetry: false, saveTerminalHistory: false },
  advanced: { hardwareAcceleration: true },
  agentMesh: { contextPersistence: false, maxPersistBytes: 524288, mcp: { enabled: false, port: 0, enableMutations: false } },
  voice: { enabled: false, pushToTalkKey: 'Ctrl+Shift+Space', autoSend: true, inputDeviceId: '', language: 'auto', speakResponses: false, gemini: { enabled: false, apiKey: '', model: 'gemini-3.1-flash-lite' }, llmFallback: { enabled: false, baseUrl: 'http://localhost:11434/v1', model: 'llama3.1' } },
}))

function getJson(path) {
  return new Promise((resolveJson, reject) => {
    const request = http.get(`http://127.0.0.1:${port}${path}`, (response) => {
      let body = ''
      response.on('data', (chunk) => { body += chunk })
      response.on('end', () => {
        try { resolveJson(JSON.parse(body)) } catch (error) { reject(error) }
      })
    })
    request.on('error', reject)
    request.setTimeout(1200, () => request.destroy(new Error('timeout')))
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
    } catch { /* application is still starting */ }
    await sleep(250)
  }
  if (!page) throw new Error('No CDP page')
  const socket = new WebSocket(page.webSocketDebuggerUrl)
  const pending = new Map()
  let id = 0
  await new Promise((done, reject) => {
    socket.onopen = done
    socket.onerror = reject
  })
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data)
    const callback = pending.get(message.id)
    if (!callback) return
    pending.delete(message.id)
    message.error ? callback.reject(new Error(message.error.message)) : callback.resolve(message.result)
  }
  const send = (method, params = {}) => new Promise((resolveMessage, reject) => {
    const messageId = ++id
    pending.set(messageId, { resolve: resolveMessage, reject })
    socket.send(JSON.stringify({ id: messageId, method, params }))
  })
  const evaluate = async (expression) => {
    const response = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? 'evaluate failed')
    return response.result.value
  }
  return { socket, evaluate }
}

const app = spawn(executable, [
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${userData}`,
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
], {
  env: { ...process.env, PLANO_USER_DATA_DIR: userData },
  stdio: 'ignore',
  windowsHide: true,
})

let client
try {
  client = await connect()
  await sleep(1200)
  const result = await client.evaluate(`(async () => {
    const wait = (ms) => new Promise((done) => setTimeout(done, ms))
    const chip = document.querySelector('[aria-label="Time tracked"]')
    if (!chip) return { error: 'time chip not found' }

    chip.click()
    await wait(80)
    const opened = !!document.querySelector('[data-surface-layer="popover"]')
    chip.parentElement.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false }))
    document.querySelector('[data-canvas-background]')?.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 30, clientY: 300 }))
    await wait(80)
    const stayedAfterLeave = !!document.querySelector('[data-surface-layer="popover"]')
    const popover = document.querySelector('[data-surface-layer="popover"]')
    popover?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 41, button: 0, buttons: 1 }))
    await wait(40)
    const stayedAfterInsidePress = !!document.querySelector('[data-surface-layer="popover"]')
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 20, clientY: 300, pointerId: 42, button: 0, buttons: 1 }))
    await wait(80)
    const closedOutside = !document.querySelector('[data-surface-layer="popover"]')
    chip.click()
    await wait(60)
    chip.click()
    await wait(60)
    const toggledClosed = !document.querySelector('[data-surface-layer="popover"]')

    Element.prototype.setPointerCapture = function () {}
    Element.prototype.releasePointerCapture = function () {}
    const shell = document.querySelector('[aria-label="Close panel"]')?.closest('.group')
    const header = shell?.querySelector('.cursor-grab')
    if (!shell || !header) return { error: 'draggable panel not found' }
    const anchor = shell.parentElement
    const rect = header.getBoundingClientRect()
    const x = rect.left + rect.width / 2
    const y = rect.top + rect.height / 2
    const anchorBefore = anchor.style.transform
    header.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x, clientY: y, pointerId: 43, button: 0, buttons: 1 }))
    await wait(180)
    const liftInline = shell.style.transform
    const liftComputed = getComputedStyle(shell).transform
    header.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: x + 120, clientY: y + 45, pointerId: 43, button: 0, buttons: 1 }))
    await new Promise(requestAnimationFrame)
    await new Promise(requestAnimationFrame)
    const anchorDuring = anchor.style.transform
    header.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: x + 120, clientY: y + 45, pointerId: 43, button: 0, buttons: 0 }))
    await wait(320)
    const releasedInline = shell.style.transform
    const releasedComputed = getComputedStyle(shell).transform
    return { opened, stayedAfterLeave, stayedAfterInsidePress, closedOutside, toggledClosed, anchorBefore, anchorDuring, liftInline, liftComputed, releasedInline, releasedComputed }
  })()`)
  const pass = !result.error
    && result.opened
    && result.stayedAfterLeave
    && result.stayedAfterInsidePress
    && result.closedOutside
    && result.toggledClosed
    && result.anchorBefore !== result.anchorDuring
    && result.liftInline === 'translate3d(0px, -2px, 0px) scale(1.006)'
    && result.releasedInline === ''
    && result.releasedComputed === 'none'
  const output = JSON.stringify({ pass, ...result }, null, 2)
  if (resultPath) writeFileSync(resultPath, output)
  console.log(output)
  if (!pass) process.exitCode = 1
  client.socket.close()
} finally {
  await sleep(300)
  if (!app.killed) app.kill()
}
