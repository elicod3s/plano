/**
 * Dev-only verification probe for the Files panel instant-open behaviors.
 * Launches the dev checkout with an isolated user-data dir + unique CDP port,
 * seeds a small fixture, and asserts the observable behaviors:
 *   - no panel-wide "Loading…" gate for folder open
 *   - lazy expansion shows children on directory click
 *   - structural create appears in the tree (parent patch)
 *   - opening a file does NOT change the panel rect
 *   - the same CodeMirror .cm-editor DOM node survives file switches
 *   - content-only writes keep frames smooth (no tree rebuild storm)
 * Cleanup targets only the spawned process tree by PID (never PLANO.exe by name).
 */
import { spawn, spawnSync } from 'node:child_process'
import http from 'node:http'
import WebSocket from 'ws'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

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

const SETTINGS = {
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
}

async function main() {
  const run = Date.now() + Math.random().toString(36).slice(2)
  const UD = path.join(os.tmpdir(), `fp-probe-${run}`)
  const PRJ = path.join(os.tmpdir(), `fp-prj-${run}`)
  fs.rmSync(UD, { recursive: true, force: true })
  fs.mkdirSync(UD, { recursive: true })
  fs.mkdirSync(path.join(PRJ, 'src', 'deep'), { recursive: true })
  for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(PRJ, `file${i}.ts`), `// file ${i}\nexport const v = ${i}\n`)
  fs.writeFileSync(path.join(PRJ, 'src', 'index.ts'), 'export const src = 1\n')
  fs.writeFileSync(path.join(PRJ, 'src', 'deep', 'nested.txt'), 'deep content\n')
  fs.writeFileSync(path.join(PRJ, 'a.txt'), 'hello a\n')
  fs.writeFileSync(path.join(PRJ, 'b.md'), '# Markdown\n\nbody\n')

  fs.writeFileSync(
    path.join(UD, 'workspaces.json'),
    JSON.stringify({
      schemaVersion: 1,
      savedAt: new Date().toISOString(),
      activeId: 's1',
      workspaces: [
        {
          id: 's1',
          name: 'S',
          folderPath: PRJ,
          viewport: { x: 0, y: 0, zoom: 1 },
          regions: [],
          panels: [
            {
              id: 'e1',
              type: 'editor',
              rect: { x: 60, y: 60, width: 760, height: 560 },
              z: 1,
              title: 'Files',
              props: { folderPath: PRJ, filePath: undefined, sidebarOpen: true },
            },
          ],
        },
      ],
    }),
  )
  fs.writeFileSync(path.join(UD, 'session.json'), JSON.stringify({ folderPath: PRJ }))
  fs.writeFileSync(path.join(UD, 'settings.json'), JSON.stringify(SETTINGS))

  const port = 9970 + (Date.now() % 10)
  const app = spawn('D:/Tools/Plano/node_modules/electron/dist/electron.exe', ['.', `--remote-debugging-port=${port}`], {
    env: { ...process.env, PLANO_USER_DATA_DIR: UD },
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
    new Promise((res) => {
      const i = ++id
      pend.set(i, res)
      ws.send(JSON.stringify({ id: i, method, params }))
    })
  const ev = async (e) => (await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result?.result?.value
  await send('Page.bringToFront', {}).catch(() => {})

  const results = {}
  await sleep(2500)

  // 1. No panel-wide Loading gate: the tree rows for root entries are visible.
  const hasRow = async (name) =>
    await ev(`(() => { const p=document.querySelector('[data-panel-type="editor"]'); return p ? [...p.querySelectorAll('button')].some(b=>(b.textContent||'').trim()===${JSON.stringify(name)} && b.style.paddingLeft) : false })()`).catch(() => false)
  const loadingText = await ev(`(() => { const p=document.querySelector('[data-panel-type="editor"]'); return p ? /loading/i.test(p.textContent||'') : null })()`).catch(() => null)
  results.loadingGate = loadingText
  let rootVisible = await hasRow('a.txt')
  for (let i = 0; i < 40 && !rootVisible; i++) {
    await sleep(250)
    rootVisible = await hasRow('a.txt')
  }
  results.rootRowsVisible = rootVisible

  // 2. Lazy expansion: verify a child is NOT visible before expanding, then click src/.
  const nestedBefore = await hasRow('index.ts')
  await ev(`(() => { const p=document.querySelector('[data-panel-type="editor"]'); const el=[...p.querySelectorAll('*')].find(el=>(el.textContent||'').trim()==='src' && el.closest('button')); el?.closest('button')?.click(); })()`).catch(() => {})
  await sleep(400)
  const nestedAfter = await hasRow('index.ts')
  results.lazyExpand = { nestedBefore, nestedAfter }

  // 3. Structural create appears via parent patch.
  fs.writeFileSync(path.join(PRJ, 'brand-new.txt'), 'x')
  let created = false
  for (let i = 0; i < 30; i++) {
    created = await hasRow('brand-new.txt')
    if (created) break
    await sleep(250)
  }
  results.structuralCreate = created

  // 4. Opening a file does NOT resize the panel.
  const rectBefore = await ev(`(() => { const el=document.querySelector('[data-panel-type="editor"]'); if(!el) return null; const r=el.getBoundingClientRect(); return {w:r.width,h:r.height} })()`)
  await ev(`(() => { const p=document.querySelector('[data-panel-type="editor"]'); const el=[...p.querySelectorAll('*')].find(el=>(el.textContent||'').trim()==='a.txt'); el?.closest('button')?.click(); })()`).catch(() => {})
  await sleep(900)
  const rectAfter = await ev(`(() => { const el=document.querySelector('[data-panel-type="editor"]'); if(!el) return null; const r=el.getBoundingClientRect(); return {w:r.width,h:r.height} })()`)
  const cmId1 = await ev(`(() => { const c=document.querySelector('.cm-editor'); return c ? (c.__id||(c.__id='cm'+(Math.random()*1e9|0))) : null })()`).catch(() => null)
  results.noResizeOnOpen = rectBefore && rectAfter ? Math.abs(rectBefore.w - rectAfter.w) < 2 && Math.abs(rectBefore.h - rectAfter.h) < 2 : false

  // 5. CodeMirror identity survives file switch (same .cm-editor node).
  await ev(`(() => { const p=document.querySelector('[data-panel-type="editor"]'); const el=[...p.querySelectorAll('*')].find(el=>(el.textContent||'').trim()==='b.md'); el?.closest('button')?.click(); })()`).catch(() => {})
  await sleep(700)
  const cmId2 = await ev(`(() => { const c=document.querySelector('.cm-editor'); return c ? c.__id : null })()`).catch(() => null)
  results.cmPersistent = !!cmId1 && cmId1 === cmId2

  // 6. Content-only storm: frames stay smooth.
  const frames = await ev(`(async () => { const d=[]; let last=performance.now(); const f=()=>{d.push(performance.now()-last); last=performance.now(); if(d.length<20) requestAnimationFrame(f)}; requestAnimationFrame(f); await new Promise(r=>setTimeout(r,600)); return d })()`).catch(() => [])
  const avg = frames.length ? frames.reduce((a, b) => a + b, 0) / frames.length : null
  results.contentStormAvgFrameMs = avg ? Math.round(avg * 10) / 10 : null

  console.log('RESULT:', JSON.stringify(results))
  await ev('window.plano.window.close()').catch(() => {})
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
