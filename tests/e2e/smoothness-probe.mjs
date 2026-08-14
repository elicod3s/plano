// Canvas-smoothness verification, step by step (each evaluate logs its raw value).
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
  version: 11,
  general: { restoreLastWorkspace: true, restoreAgentSessions: false, showFilesOnLaunch: false, warnBeforeQuit: false, confirmClosePanelWithProcess: false, agentDoneSound: false },
  appearance: { theme: 'monolith', accent: '#FFFFFF', gridStyle: 'none', gridOpacity: 1, reduceMotion: false, canvasBackground: { kind: 'theme', colors: ['#141414', '#1d1d2b'], angle: 135 }, canvasGlow: 0, gridSize: 'standard' },
  editor: { fontSize: 13, tabSize: 2, wordWrap: true, lineNumbers: true },
  terminal: { shell: 'cmd' },
  canvas: { snapToGrid: true, showMinimap: false, zoomSensitivity: 1, autosave: false },
  browser: {},
  privacy: { telemetry: false, saveTerminalHistory: true },
  advanced: { hardwareAcceleration: true },
  agentMesh: {},
  voice: {},
}
async function main() {
  const run = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  const UD = path.join(os.tmpdir(), `sm2-${run}`)
  const PRJ = path.join(os.tmpdir(), `sm2p-${run}`)
  fs.mkdirSync(UD, { recursive: true })
  for (let d = 0; d < 60; d += 1) {
    const dir = path.join(PRJ, 'src', `mod${String(d).padStart(2, '0')}`)
    fs.mkdirSync(dir, { recursive: true })
    for (let f = 0; f < 40; f += 1) fs.writeFileSync(path.join(dir, `file${String(f).padStart(3, '0')}.ts`), `// ${d}-${f}\n`)
  }
  fs.writeFileSync(path.join(PRJ, 'package.json'), '{}')
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
            { id: 'e1', type: 'editor', rect: { x: 60, y: 60, width: 880, height: 600 }, z: 1, title: 'Files', props: { folderPath: PRJ, filePath: undefined, sidebarOpen: true } },
            { id: 't1', type: 'terminal', rect: { x: 1000, y: 80, width: 420, height: 300 }, z: 2, title: 'T', props: { folderPath: PRJ, command: '' } },
          ],
        },
      ],
    }),
  )
  fs.writeFileSync(path.join(UD, 'session.json'), JSON.stringify({ folderPath: PRJ }))
  fs.writeFileSync(path.join(UD, 'settings.json'), JSON.stringify(SETTINGS))
  const port = 9730 + (Date.now() % 20)
  const app = spawn('D:/Tools/Plano/node_modules/electron/dist/electron.exe', ['.', `--remote-debugging-port=${port}`, '--disable-background-timer-throttling', '--disable-renderer-backgrounding'], {
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
      const t = setTimeout(() => { pend.delete(i); rej(new Error('CDP_TIMEOUT ' + method)) }, 30000)
      pend.set(i, (m) => { clearTimeout(t); res(m) })
      ws.send(JSON.stringify({ id: i, method, params }))
    })
  const ev = async (label, e) => {
    console.log('STEP:', label)
    const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) return { __exc: (r.exceptionDetails.exception?.description || '').slice(0, 250) }
    return r.result?.result?.value
  }
  await send('Runtime.enable', {}).catch(() => {})
  const exceptions = []
  ws.on('message', (d) => { const m = JSON.parse(d); if (m.method === 'Runtime.exceptionThrown') exceptions.push((m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text || '').slice(0, 300)); if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') exceptions.push('CONSOLE: ' + (m.params.args?.[0]?.value || '').slice(0, 200)); })
  await send('Page.bringToFront', {}).catch(() => {})
  await sleep(7000)
  await ev('stubs', `(() => { Element.prototype.setPointerCapture = function () {}; Element.prototype.releasePointerCapture = function () {}; 'ok' })()`)

  const results = {}
  const rawProbe = await send('Runtime.evaluate', { expression: '(() => { return true })()', returnByValue: true });
  console.log('RAW_TRUE:', JSON.stringify(rawProbe));
  const rawAsync = await send('Runtime.evaluate', { expression: '(async () => ({ n: 7 }))()', awaitPromise: true, returnByValue: true });
  console.log('RAW_ASYNC:', JSON.stringify(rawAsync));
  // S2: expand the tree (root → src → 60 mods) then count MOUNTED rows.
  const rawSrc = await send('Runtime.evaluate', { expression: "(() => { const p=document.querySelector('[data-panel-type=\"editor\"]'); return p ? 'panel' : 'nopanel' })()", returnByValue: true });
  console.log('RAW_SRC:', JSON.stringify(rawSrc));
  const src = await ev('src', `(() => { const p=document.querySelector('[data-panel-type="editor"]'); const b=[...p.querySelectorAll('button')].find(x=>(x.textContent||'').trim()==='src'); b?.click(); return !!b })()`)
  await sleep(800)
  const mods = await ev('mods', `(async () => {
    const sleep=(ms)=>new Promise(r=>setTimeout(r,ms))
    const p=document.querySelector('[data-panel-type="editor"]')
    let clicked=0
    for (let i=0;i<60;i+=1){
      const b=[...p.querySelectorAll('button')].find(x=>(x.textContent||'').trim()==='mod'+String(i).padStart(2,'0'))
      if(b){b.click(); clicked+=1; await sleep(20)}
    }
    return { clicked }
  })()`)
  await sleep(1200)
  const dom = await ev('dom', `(() => {
    const p=document.querySelector('[data-panel-type="editor"]')
    const buttons=[...p.querySelectorAll('button')]
    const files=buttons.filter((b)=>/^file\\d+\\.ts$/.test((b.textContent||'').trim()))
    return { mountedFileRows: files.length, totalButtons: buttons.length }
  })()`)
  results.S2 = { src, mods, dom }

  // S0/S6: pan the canvas — frame cadence + world-transform writes per frame (A1).
  const pan = await ev('pan', `(async () => {
    const sleep=(ms)=>new Promise(r=>setTimeout(r,ms))
    const root=document.querySelector('[data-canvas-background]')
    const world=document.querySelector('[data-world-layer]')
    const samples=[]
    let prev=performance.now()
    let writes=0
    let last=world.style.transform
    root.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,clientX:100,clientY:720,pointerId:81,button:0,buttons:1}))
    const deadline=Date.now()+15000
    for(let i=0;i<90;i+=1){
      if(Date.now()>deadline) return { timeout:true, frames:i }
      await new Promise((r)=>setTimeout(r,16))
      const now=performance.now()
      samples.push(now-prev); prev=now
      root.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,clientX:100+i*3,clientY:720+Math.sin(i/7)*24,pointerId:81,button:0,buttons:1}))
      if(world.style.transform!==last){writes+=1; last=world.style.transform}
    }
    root.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,clientX:370,clientY:720,pointerId:81,button:0,buttons:0}))
    samples.sort((a,b)=>a-b)
    return {
      avg: Math.round(samples.reduce((a,b)=>a+b,0)/samples.length*10)/10,
      p95: Math.round(samples[Math.floor(samples.length*.95)]*10)/10,
      over25: samples.filter((v)=>v>25).length,
      worldWrites: writes,
    }
  })()`)
  results.pan = pan

  // S3: 1-char filter — bounded (no crawl).
  const filter = await ev('filter', `(async () => {
    const sleep=(ms)=>new Promise(r=>setTimeout(r,ms))
    const p=document.querySelector('[data-panel-type="editor"]')
    const input=[...p.querySelectorAll('input')].find((i)=>i.placeholder==='Filter files')
    if(!input) return { found:false }
    const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set
    setter.call(input,'f')
    input.dispatchEvent(new Event('input',{bubbles:true}))
    await sleep(700)
    return { found:true, value:input.value }
  })()`)
  results.S3 = filter

  const domDump = await send('Runtime.evaluate', { expression: "(() => ({ canvas: !!document.querySelector('canvas'), panels: document.querySelectorAll('[data-panel-type]').length, types: [...document.querySelectorAll('[data-panel-type]')].map((x) => x.getAttribute('data-panel-type')), surfaces: document.querySelectorAll('[data-surface-layer]').length, bodyText: document.body.innerText.slice(0, 120) }))()", returnByValue: true });
  console.log('DOMDUMP:', JSON.stringify(domDump.result?.result?.value));
  console.log('EXCEPTIONS:', JSON.stringify(exceptions));
  console.log('RESULT:', JSON.stringify(results))
  await ev('window.plano.window.close()').catch(() => {})
  await sleep(700)
  try {
    spawnSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore', timeout: 8000 })
  } catch {}
  process.exit(0)
}
main().catch((e) => { console.error('FATAL', e.message)
  console.error('ERR', e)
  process.exit(1)
})
