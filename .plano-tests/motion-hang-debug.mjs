// Debug: run App 1 scenario sequence (zoomTo 100 → escape → pointercancel → focus-states)
// step by step with per-call timeouts, to find where the E2E hangs after drag@125.
import { spawn, spawnSync } from 'node:child_process'
import http from 'node:http'
import WebSocket from 'ws'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const EXE = 'D:/Tools/Plano/node_modules/electron/dist/electron.exe'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const getJson = (p, port) =>
  new Promise((res, rej) => {
    http
      .get(`http://127.0.0.1:${port}${p}`, (r) => {
        let d = ''
        r.on('data', (c) => (d += c))
        r.on('end', () => res(JSON.parse(d)))
      })
      .on('error', rej)
  })

const RUN = Date.now().toString(36)
const port = 9700 + (Date.now() % 50)

async function main() {
  const userData = join(tmpdir(), `plano-dbg-a-${RUN}`)
  const project = join(tmpdir(), `plano-dbg-project-${RUN}`)
  mkdirSync(userData, { recursive: true })
  mkdirSync(project, { recursive: true })
  writeFileSync(
    join(userData, 'workspaces.json'),
    JSON.stringify({
      schemaVersion: 1,
      savedAt: new Date().toISOString(),
      activeId: 's1',
      workspaces: [
        {
          id: 's1',
          name: 'S',
          folderPath: project,
          viewport: { x: 0, y: 0, zoom: 1 },
          regions: [],
          panels: [{ id: 'p1', type: 'terminal', rect: { x: 100, y: 100, width: 900, height: 520 }, z: 1, title: 'Terminal', props: { tabs: [{ id: 't1' }], activeTabId: 't1', terminalNumber: 1 } }],
        },
      ],
    }),
  )
  writeFileSync(join(userData, 'session.json'), JSON.stringify({ folderPath: project }))
  writeFileSync(
    join(userData, 'settings.json'),
    JSON.stringify({
      version: 9,
      general: { restoreLastWorkspace: true, restoreAgentSessions: false, showFilesOnLaunch: false, warnBeforeQuit: false, confirmClosePanelWithProcess: false, agentDoneSound: false },
      appearance: { theme: 'monolith', accent: '#FFFFFF', gridStyle: 'dots', gridOpacity: 1, grain: false, reduceMotion: false },
      editor: { fontSize: 13, tabSize: 2, wordWrap: true, lineNumbers: true },
      terminal: { shell: 'cmd', shellPath: '', fontFamily: '', fontSize: 0, lineHeight: 1.4, cursorStyle: 'bar', cursorBlink: false, scrollback: 5000, theme: 'campbell', copyOnSelect: false, predictiveHistory: false, smartActions: false, autoSuspendIdle: true, keepAgentsOnQuit: true },
      canvas: { snapToGrid: true, showMinimap: false, zoomSensitivity: 1, autosave: true },
      browser: {},
      privacy: { telemetry: false, saveTerminalHistory: true },
      advanced: { hardwareAcceleration: true },
      agentMesh: {},
      voice: {},
    }),
  )
  const app = spawn(EXE, ['.', `--remote-debugging-port=${port}`, '--force-frame-rate=60'], {
    env: { ...process.env, PLANO_USER_DATA_DIR: userData },
    stdio: 'ignore',
    windowsHide: true,
  })
  app.unref()
  let page
  for (let i = 0; i < 100 && !page; i++) {
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
    new Promise((res, rej) => {
      const i = ++id
      const t = setTimeout(() => {
        pend.delete(i)
        rej(new Error('CDP TIMEOUT ' + method))
      }, 25000)
      pend.set(i, (m) => {
        clearTimeout(t)
        res(m)
      })
      ws.send(JSON.stringify({ id: i, method, params }))
    })
  const ev = async (label, e) => {
    try {
      const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })
      if (r.exceptionDetails) return { __exc: r.exceptionDetails.exception?.description?.slice(0, 300) }
      console.log('STEP OK:', label, JSON.stringify(r.result?.value ?? null).slice(0, 120))
      return r.result?.value
    } catch (err) {
      console.log('STEP HUNG/TIMEOUT:', label, err.message)
      return null
    }
  }
  await send('Page.bringToFront', {}).catch(() => {})
  await ev('focus', `window.focus(); 'ok'`)

  // install minimal helpers (same as E2E installHelpers)
  await ev(
    'helpers',
    `(() => {
      window.__e2e = window.__e2e || {}
      Element.prototype.setPointerCapture = function () {}
      Element.prototype.releasePointerCapture = function () {}
      window.__e2e.raf = () => new Promise((res) => { const t = setTimeout(() => res(false), 2600); requestAnimationFrame(() => { clearTimeout(t); res(true) }) })
      window.__e2e.waitOpacity = (el, expected, timeoutMs = 8000) => new Promise((res) => { const t0 = performance.now(); const tick = async () => { const v = getComputedStyle(el).opacity; if (v === expected || performance.now() - t0 > timeoutMs) { res(v); return } await window.__e2e.raf(); tick() }; tick() })
      window.__e2e.zoomButtonText = () => { const b = document.querySelector('[title="Reset zoom"]'); return b ? b.textContent.trim() : null }
      window.__e2e.panel = () => { const shell = document.querySelector('[data-panel-type="terminal"]'); if (!shell) return null; return { shell, anchor: shell.closest('[style*="translate3d"]') || shell.parentElement, header: shell.querySelector('.cursor-grab') } }
      'ok'
    })()`,
  )
  await ev('waitReady', `(async () => { for (let i=0;i<100;i++){ const s=document.querySelector('[data-panel-type="terminal"] .xterm'); if (s) return {ok:true}; await new Promise(r=>setTimeout(r,300)) } return {ok:false} })()`)

  // 1. drag@125 equivalent: drag the header 128px, then release.
  await ev(
    'drag125',
    `(async () => {
      const p = window.__e2e.panel()
      const { shell, anchor, header } = p
      const b0 = header.getBoundingClientRect()
      const start = { x: b0.left + b0.width / 2, y: b0.top + b0.height / 2 }
      header.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: start.x, clientY: start.y, pointerId: 8, button: 0, buttons: 1 }))
      for (let i = 1; i <= 4; i += 1) {
        header.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: start.x + i * 40, clientY: start.y, pointerId: 8, button: 0, buttons: 1 }))
        await window.__e2e.raf()
      }
      const movedX = anchor.style.transform ? Math.round(parseFloat(anchor.style.transform.match(/-?[0-9.]+/)?.[0] ?? '0')) : 0
      header.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: start.x + 160, clientY: start.y, pointerId: 8, button: 0, buttons: 0 }))
      await window.__e2e.waitOpacity(shell, '1')
      return { movedX }
    })()`,
  )

  // 2. zoomTo 100
  await ev('zoom100', `document.querySelector('[title="Reset zoom"]').click(); 'ok'`)
  await sleep(1500)
  await ev('zoomText', `window.__e2e.zoomButtonText()`)

  // 3. escape-cancel sequence
  await ev(
    'escape',
    `(async () => {
      const p = window.__e2e.panel()
      const { shell, anchor, header } = p
      const rectBefore = anchor.style.transform
      const b0 = header.getBoundingClientRect()
      const start = { x: b0.left + b0.width / 2, y: b0.top + b0.height / 2 }
      header.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: start.x, clientY: start.y, pointerId: 9, button: 0, buttons: 1 }))
      for (let i = 1; i <= 3; i += 1) {
        header.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: start.x + i * 40, clientY: start.y, pointerId: 9, button: 0, buttons: 1 }))
        await window.__e2e.raf()
      }
      header.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      header.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: start.x + 120, clientY: start.y, pointerId: 9, button: 0, buttons: 0 }))
      const op = await window.__e2e.waitOpacity(shell, '1')
      return { rectUnchanged: anchor.style.transform === rectBefore, opacity: op }
    })()`,
  )

  // 4. pointercancel
  await ev(
    'pointercancel',
    `(async () => {
      const p = window.__e2e.panel()
      const { shell, anchor, header } = p
      const rectBefore = anchor.style.transform
      const b0 = header.getBoundingClientRect()
      const start = { x: b0.left + b0.width / 2, y: b0.top + b0.height / 2 }
      header.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: start.x, clientY: start.y, pointerId: 10, button: 0, buttons: 1 }))
      for (let i = 1; i <= 3; i += 1) {
        header.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: start.x + i * 40, clientY: start.y, pointerId: 10, button: 0, buttons: 1 }))
        await window.__e2e.raf()
      }
      header.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, clientX: start.x + 120, clientY: start.y, pointerId: 10, button: 0, buttons: 0 }))
      return { rectUnchanged: anchor.style.transform === rectBefore }
    })()`,
  )

  // 5. focus-states (reduced)
  await ev('clearFocus', `(() => {
    const canvas = document.querySelector('[data-canvas-background]')
    const r = canvas.getBoundingClientRect()
    canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 24, clientY: r.height - 60, pointerId: 22, button: 0, buttons: 1 }))
    canvas.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 24, clientY: r.height - 60, pointerId: 22, button: 0, buttons: 0 }))
    'ok'
  })()`)
  await ev('opacityAfterClear', `(() => { const s = document.querySelector('[data-panel-type="terminal"]'); return getComputedStyle(s).opacity })()`)
  await sleep(400)
  await ev('opacityAfterClearSettled', `(() => { const s = document.querySelector('[data-panel-type="terminal"]'); return getComputedStyle(s).opacity })()`)

  console.log('DONE — no hang')
  await ev('close', `window.plano.window.close()`).catch(() => {})
  await sleep(800)
  try {
    spawnSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore', timeout: 8000 })
  } catch {}
  process.exit(0)
}

main().catch((e) => {
  console.error('ERR', e)
  process.exit(1)
})
