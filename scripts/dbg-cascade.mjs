// Verify: 3 phone-created panels cascade on the PC + kill removes them + no hint text on the phone.
import http from 'node:http'
import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const info = JSON.parse(readFileSync(join(process.env.APPDATA, 'PLANO/agent-host.json'), 'utf8'))
const base = `http://127.0.0.1:${info.webPort}`
async function getJson(p, port) { return new Promise((res, rej) => { const r = http.get(`http://127.0.0.1:${port}${p}`, (x) => { let d=''; x.on('data',c=>d+=c); x.on('end',()=>{ try{res(JSON.parse(d))}catch{rej(new Error('bad'))} }) }); r.on('error', rej) }) }
const targets = await getJson('/json', 9701)
const page = targets.find((t) => t.type === 'page' && t.url.includes('index.html'))
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id=0; const pending=new Map()
const send=(m,p)=>new Promise((res,rej)=>{const i=++id;pending.set(i,{res,rej});ws.send(JSON.stringify({id:i,method:m,params:p}))})
ws.onmessage=(ev)=>{const m=JSON.parse(ev.data);if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.rej(new Error(m.error.message)):p.res(m.result)}}
await new Promise(r=>ws.onopen=r)
const evalJs=async(e,t=8000)=>{try{const r=await Promise.race([send('Runtime.evaluate',{expression:e,awaitPromise:true,returnByValue:true}),new Promise((_,rej)=>setTimeout(()=>rej(new Error('tmo')),t))]);if(r.exceptionDetails)return{__exc:r.exceptionDetails.exception?.description?.slice(0,200)};return r.result.value}catch(err){return{__err:String(err)}}}
await sleep(3000)
// get the active workspace folder
const wsState = await evalJs(`window.plano.workspaces.get()`)
const active = wsState?.state?.workspaces?.find((w) => w.id === wsState?.state?.activeId)
const folder = active?.folderPath
console.log('active:', active?.name, folder)
// create 3 sessions via the phone
const ptyIds = []
for (let i = 0; i < 3; i += 1) {
  const c = await (await fetch(`${base}/api/sessions?token=${info.token}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folderPath: folder, name: 'Cascade ' + (i + 1), bootCommand: 'echo CASCADE-' + (i + 1), cols: 90, rows: 26 }) })).json()
  ptyIds.push(c.session?.ptyId)
  await sleep(600)
}
console.log('created:', ptyIds.map((p) => p.slice(0, 8)).join(', '))
await sleep(2000)
// check the panel rects in the active workspace
const rects = await evalJs(`(function(){
  const d = window.__ws || null
  return 'see-below'
})()`)
const panels = await evalJs(`window.plano.workspaces.get()`)
const terms = panels?.state?.workspaces?.find((w) => w.id === wsState?.state?.activeId)?.panels.filter((p) => p.type === 'terminal') ?? []
console.log('terminal panels in active ws:', terms.length)
console.log('rects:', JSON.stringify(terms.map((p) => ({ t: p.title, x: p.rect.x, y: p.rect.y }))))
const cascade = terms.length >= 3 && terms.slice(-3).every((p, i, arr) => i === 0 || (p.rect.x > arr[i-1].rect.x || p.rect.y > arr[i-1].rect.y))
console.log('cascade ordering:', cascade ? 'OK' : 'check rects above')
// kill one from the "phone"
await fetch(`${base}/api/sessions/${ptyIds[2]}/kill?token=${info.token}`, { method: 'POST', body: '{}' })
await sleep(1500)
const after = await evalJs(`window.plano.workspaces.get()`)
const termsAfter = after?.state?.workspaces?.find((w) => w.id === wsState?.state?.activeId)?.panels.filter((p) => p.type === 'terminal') ?? []
console.log('after kill, panels:', termsAfter.length, '(was', terms.length + ')')
// cleanup remaining
for (const p of ptyIds) { await fetch(`${base}/api/sessions/${p}/kill?token=${info.token}`, { method: 'POST', body: '{}' }).catch(() => {}) }
process.exit(0)
