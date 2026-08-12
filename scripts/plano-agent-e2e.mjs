// REAL-AGENT E2E: launch Claude Code inside a PLANO terminal, quit the app, verify the agent
// process survives AND is still detected on relaunch (the exact herdr-style user scenario).
import { spawn } from 'node:child_process'
import http from 'node:http'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const EXE = process.argv[2]
const USER_DATA = process.argv[3]
const PORT = Number(process.argv[4])
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// seed a project + workspace with a terminal panel
const PROJECT = join(tmpdir(), 'plano-e2e-agent-project')
mkdirSync(PROJECT, { recursive: true })
writeFileSync(join(PROJECT, 'package.json'), '{"name":"plano-agent-e2e"}\n')
mkdirSync(USER_DATA, { recursive: true })
writeFileSync(join(USER_DATA, 'workspaces.json'), JSON.stringify({
  schemaVersion: 1, savedAt: new Date().toISOString(), activeId: 's1',
  workspaces: [{ id: 's1', name: 'Agent', folderPath: PROJECT, viewport: { x: 0, y: 0, zoom: 1 }, regions: [], panels: [{ id: 'p1', type: 'terminal', rect: { x: 100, y: 100, width: 1000, height: 600 }, z: 1, title: 'Terminal', props: { tabs: [{ id: 't1' }], activeTabId: 't1', terminalNumber: 1 } }] }],
}, null, 2))
writeFileSync(join(USER_DATA, 'session.json'), JSON.stringify({ folderPath: PROJECT }))
writeFileSync(join(USER_DATA, 'settings.json'), readFileSync('D:/Tools/Plano/scripts/plano-e2e-seed-settings.json', 'utf8').replace('"__KEEP__"', 'true'))

async function getJson(path, port) {
  return new Promise((res, rej) => {
    const req = http.get(`http://127.0.0.1:${port}${path}`, (r) => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>{ try{res(JSON.parse(d))}catch{rej(new Error('bad'))} }) })
    req.on('error', rej); req.setTimeout(1500, () => req.destroy(new Error('timeout')))
  })
}
async function waitCdp(port, ms=30000) {
  const dl = Date.now()+ms
  while (Date.now()<dl) {
    try { const t = await getJson('/json', port); const p = t.find(x => x.type==='page' && x.url.includes('index.html')); if (p) return p } catch {}
    await sleep(400)
  }
  throw new Error('no cdp')
}
async function connect(port) {
  const page = await waitCdp(port)
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  let id=0; const pending=new Map()
  const send=(m,p)=>new Promise((res,rej)=>{const i=++id;pending.set(i,{res,rej});ws.send(JSON.stringify({id:i,method:m,params:p}))})
  ws.onmessage=(ev)=>{const m=JSON.parse(ev.data);if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.rej(new Error(m.error.message)):p.res(m.result)}}
  await new Promise(r=>ws.onopen=r)
  const evalJs=async(e)=>{const r=await send('Runtime.evaluate',{expression:e,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)return{__exc:r.exceptionDetails.exception?.description?.slice(0,300)};return r.result.value}
  return { ws, evalJs }
}
const pidAlive = (pid) => { if (!pid) return false; try { process.kill(pid,0); return true } catch { return false } }

let failures = 0
const ok = (name, cond, extra='') => { console.log(`${cond?'PASS':'FAIL'} ${name}${extra?' — '+extra:''}`); if(!cond) failures++ }

// ── launch 1 ────────────────────────────────────────────────────────────────
console.log('== launch 1: start Claude Code ==')
let app = spawn(EXE, ['.', `--remote-debugging-port=${PORT}`], { env: { ...process.env, PLANO_USER_DATA_DIR: USER_DATA }, stdio: 'ignore', windowsHide: true })
app.unref()
let c = await connect(PORT)
await c.evalJs(`window.__log=[]; window.__unsub=window.plano.terminal.onData(e=>{ if(!window.__log.includes(e.ptyId)) window.__log.push(e.ptyId) }); 'ok'`)
let ptyId=null
for (let i=0;i<30&&!ptyId;i++){ await sleep(500); const l = await c.evalJs('window.__log'); if (Array.isArray(l)&&l.length) ptyId=l[0] }
ok('terminal spawned', !!ptyId)
const rest1 = await c.evalJs(`window.plano.terminal.restore()`)
const shellPid = rest1.sessions?.find(s=>s.ptyId===ptyId)?.pid
ok('shell pid', typeof shellPid==='number' && shellPid>0, `pid=${shellPid}`)

// launch Claude Code inside the terminal
await c.evalJs(`window.plano.terminal.write('${ptyId}', 'claude\\r')`)
// wait for agent detection (mesh snapshot shows an active agent)
let agentPid = null, agentName = null
for (let i=0;i<60;i++){
  await sleep(1000)
  const snap = await c.evalJs(`window.plano.agentMesh.getSnapshot()`)
  const agent = (snap?.agents||[]).find(a => a.pid > 0 && a.verdict?.active)
  if (agent) { agentPid = agent.pid; agentName = agent.verdict?.kind || agent.terminalTitle; break }
}
ok('Claude Code detected as running agent', !!agentPid, agentName ? `agent=${agentName} pid=${agentPid}` : 'not detected')
console.log('  [info] detected agent:', agentName, 'pid', agentPid)

// ── quit ───────────────────────────────────────────────────────────────────
console.log('== quit app ==')
await c.evalJs(`window.plano.window.close()`)
for (let i=0;i<40;i++){ try { await getJson('/json', PORT) } catch { break } await sleep(300) }
await sleep(2000)
ok('agent process survives app quit', pidAlive(agentPid), `pid=${agentPid}`)
const hostFile = existsSync(join(USER_DATA,'agent-host.json')) ? JSON.parse(readFileSync(join(USER_DATA,'agent-host.json'),'utf8')) : null
ok('host survives', !!hostFile && pidAlive(hostFile.pid))

// ── launch 2: reattach + still detected ─────────────────────────────────────
console.log('== launch 2: reattach ==')
app = spawn(EXE, ['.', `--remote-debugging-port=${PORT+1}`], { env: { ...process.env, PLANO_USER_DATA_DIR: USER_DATA }, stdio: 'ignore', windowsHide: true })
app.unref()
c = await connect(PORT+1)
let reattached = null
for (let i=0;i<30;i++){
  await sleep(500)
  reattached = await c.evalJs(`window.plano.terminal.restore()`)
  if (Array.isArray(reattached?.sessions) && reattached.sessions.some(s=>s.ptyId===ptyId)) break
}
const sess = reattached?.sessions?.find(s=>s.ptyId===ptyId)
ok('same session restored on relaunch', !!sess && sess.pid === shellPid, `pid=${sess?.pid} vs ${shellPid}`)

// the agent must STILL be running + detected after relaunch
let agent2 = null
for (let i=0;i<60;i++){
  await sleep(1000)
  const snap = await c.evalJs(`window.plano.agentMesh.getSnapshot()`)
  const a = (snap?.agents||[]).find(a => a.pid === agentPid)
  if (a && a.verdict?.active) { agent2 = a; break }
}
ok('agent still running + detected after relaunch', !!agent2, agent2 ? `${agent2.verdict?.kind} pid=${agentPid} phase=${agent2.verdict?.phase}` : 'gone')

// write to the agent from the NEW app — it must land in the SAME live session. The agent TUI
// echoes typed input in its rendered frame, so a raw data-stream check proves the write reached it.
await c.evalJs(`window.__out2 = ''; window.plano.terminal.onData(e => { if (e.ptyId === '${ptyId}') window.__out2 += e.data })`)
await c.evalJs(`window.plano.terminal.write('${ptyId}', 'ALIVE-FROM-RELAUNCH')`)
let echoed = false
for (let i = 0; i < 20 && !echoed; i += 1) {
  await sleep(500)
  echoed = String(await c.evalJs(`window.__out2`)).includes('ALIVE-FROM-RELAUNCH')
}
ok('write from relaunched app lands in the same live agent session', echoed)

// cleanup: interrupt the agent + close app + kill host
await c.evalJs(`window.plano.terminal.write('${ptyId}', '\\x03')`).catch(()=>{})
await c.evalJs(`window.plano.window.close()`).catch(()=>{})
await sleep(1500)
if (hostFile) { try { spawn('taskkill',['/PID',String(hostFile.pid),'/F','/T'],{stdio:'ignore'}).unref() } catch {} }

console.log(failures === 0 ? '\nAGENT E2E ALL PASSED' : `\nAGENT E2E ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
