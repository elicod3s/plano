const fs = require('fs')
const PORT = 9222

async function getTargets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json`)
  return res.json()
}

async function main() {
  let targets = []
  for (let i = 0; i < 90; i++) {
    try { targets = await getTargets() } catch {}
    const page = targets.find((t) => t.type === 'page')
    if (page) break
    await new Promise((r) => setTimeout(r, 1000))
  }
  const page = targets.find((t) => t.type === 'page')
  if (!page) { console.log('NO PAGE TARGET'); process.exit(1) }

  const ws = new WebSocket(page.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
  }
  const send = (method, params = {}) => new Promise((resolve) => {
    const mid = ++id
    pending.set(mid, resolve)
    ws.send(JSON.stringify({ id: mid, method, params }))
  })
  await new Promise((r) => { ws.onopen = r })
  await send('Runtime.enable')
  await send('Page.enable')
  await new Promise((r) => setTimeout(r, 12000))

  const evalRes = await send('Runtime.evaluate', {
    expression: `(() => {
      const wraps = [...document.querySelectorAll('.md-table-wrap')]
      const info = wraps.map((w, i) => {
        const rows = w.querySelectorAll('tbody tr').length
        const cols = w.querySelector('thead tr')?.children.length ?? w.querySelector('tr')?.children.length ?? 0
        const chips = w.querySelectorAll('.md-chip').length
        const epChips = w.querySelectorAll('.md-chip.ep').length
        const timeChips = w.querySelectorAll('.md-chip.time').length
        const oks = w.querySelectorAll('.md-ok').length
        const quotes = w.querySelectorAll('td.quote').length
        const nums = w.querySelectorAll('td.num').length
        const meta = w.querySelector('.md-table-meta')?.textContent
        const firstCell = w.querySelector('tbody td')?.textContent?.slice(0, 60)
        return { t: i + 1, rows, cols, chips, epChips, timeChips, oks, quotes, nums, meta, firstCell }
      })
      const fileTabs = [...document.querySelectorAll('[class*=file-tab], [class*=FileTab], [class*=tab-title]')].map(e => e.textContent).filter(Boolean).slice(0, 8)
      return JSON.stringify({ tables: info, fileTabs })
    })()`,
    returnByValue: true,
  })
  console.log('EVAL:', evalRes.result?.result?.value)

  const shot = await send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync('/tmp/plano-shot2.png', Buffer.from(shot.result.data, 'base64'))
  console.log('shot saved')
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
