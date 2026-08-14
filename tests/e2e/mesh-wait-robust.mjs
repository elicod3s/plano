// Probe: `plano wait` must always ANSWER instead of sitting on keepalives.
//   W1 a peer that ALREADY finished answers immediately with its transcript (alreadyIdle),
//      instead of blocking on a next turn that never comes — the reported hang.
//   W2 --next-turn keeps the old semantics: it does NOT return until a real new turn ends.
//   W3 a peer stuck on a permission prompt comes back `blocked`, not a timeout.
// No model calls: the agents are plain shells with a reported verdict, so this runs in ~1 min.
import { spawn, spawnSync } from 'node:child_process'
import net from 'node:net'
import { createHmac } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ELECTRON = 'D:/Tools/Plano/node_modules/electron/dist/electron.exe'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function rpc(host, method, params) {
  return new Promise((res, rej) => {
    const socket = net.connect(host.port, '127.0.0.1')
    const timer = setTimeout(() => {
      socket.destroy()
      rej(new Error('tcp timeout ' + method))
    }, 15000)
    let buf = ''
    let sent = false
    socket.on('connect', () => socket.write(JSON.stringify({ id: 1, method: 'hello', params: { token: host.token } }) + '\n'))
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8')
      for (const line of buf.split('\n').filter(Boolean)) {
        let msg
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }
        if (msg.id === 1 && !sent) {
          sent = true
          socket.write(JSON.stringify({ id: 2, method, params }) + '\n')
          continue
        }
        if (msg.id === 2) {
          clearTimeout(timer)
          socket.destroy()
          res(msg.result)
          return
        }
      }
    })
    socket.on('error', rej)
  })
}

async function main() {
  const run = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  const UD = path.join(os.tmpdir(), `mesh-wait-${run}`)
  const PRJ = path.join(os.tmpdir(), `mesh-waitp-${run}`)
  const HOME = path.join(os.tmpdir(), `mesh-waith-${run}`)
  fs.mkdirSync(UD, { recursive: true })
  fs.mkdirSync(PRJ, { recursive: true })
  fs.mkdirSync(HOME, { recursive: true })

  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', HOME, USERPROFILE: HOME }
  delete env.PLANO_USER_DATA_DIR
  const daemon = spawn(ELECTRON, ['D:/Tools/Plano/out/main/daemon.js', '--userData', UD, '--webRoot', 'D:/Tools/Plano/web-dist'], {
    env,
    stdio: 'ignore',
    detached: true,
    windowsHide: true,
  })
  daemon.unref()
  let host = null
  for (let i = 0; i < 40 && !host; i += 1) {
    try {
      host = JSON.parse(fs.readFileSync(path.join(UD, 'agent-host.json'), 'utf8'))
    } catch {}
    await sleep(400)
  }
  if (!host) throw new Error('daemon never wrote agent-host.json')

  const mk = async (n) => {
    const ptyId = `wait${run}-000${n}-0000-0000-00000000000${n}`
    await rpc(host, 'create', { ptyId, panelId: `p${n}`, terminalId: `t${n}`, spaceId: 's1', cwd: PRJ, cols: 120, rows: 30 })
    return ptyId
  }
  // B must be an agent the DAEMON itself detects: a reported verdict alone leaves the session
  // pinned to idle (the detect loop only drives working/awaiting-input for a harness it matched
  // in the process tree), so the state machine under test would never move. A stub on the real
  // claude-code module path satisfies the signature and echoes whatever is typed — enough to
  // produce genuine busy→idle turns and a genuine permission prompt, with no model involved.
  const stubDir = path.join(PRJ, 'node_modules', '@anthropic-ai', 'claude-code')
  fs.mkdirSync(stubDir, { recursive: true })
  fs.writeFileSync(
    path.join(stubDir, 'cli.js'),
    [
      "process.stdout.write('stub agent ready\\n')",
      "process.stdin.setEncoding('utf8')",
      "process.stdin.on('data', (d) => { for (const line of String(d).split(/\\r?\\n/)) { if (line.trim()) process.stdout.write('> ' + line.trim() + '\\n') } })",
      'setInterval(() => {}, 1 << 30)',
    ].join('\n'),
    'utf8',
  )
  const ptyA = await mk(1)
  const ptyB = await mk(2)
  await sleep(3000)
  await rpc(host, 'write', { ptyId: ptyB, data: `node "${path.join(stubDir, 'cli.js').replace(/\\/g, '\\\\')}"\r` })
  // Wait until the daemon's own detection puts B on the roster as an agent.
  let detected = false
  for (let i = 0; i < 40 && !detected; i += 1) {
    await sleep(1000)
    const s = await rpc(host, 'sessions', {})
    detected = (s?.sessions ?? []).some((x) => x.ptyId === ptyB && x.agentKind)
  }
  if (!detected) throw new Error('stub agent never detected on B')
  const secret = fs.readFileSync(path.join(UD, 'mesh', 'master-secret'), 'utf8').trim()
  const tokenA = createHmac('sha256', secret).update(ptyA).digest('hex')
  const cliJs = path.join(UD, 'bin', 'plano-cli.js')
  const cliEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1', PLANO_MESH_URL: `http://127.0.0.1:${host.webPort ?? 56780}/cli`, PLANO_MESH_TOKEN: tokenA }
  const cliSync = (args, timeoutMs = 60000) => spawnSync(ELECTRON, [cliJs, ...args], { env: cliEnv, encoding: 'utf8', timeout: timeoutMs, windowsHide: true })
  const cliAsync = (args) => spawn(ELECTRON, [cliJs, ...args], { env: cliEnv, windowsHide: true })
  const parse = (s) => {
    try {
      return JSON.parse(s)
    } catch {
      return null
    }
  }

  // Let B settle at its prompt so it is genuinely, stably idle.
  await sleep(6000)

  // ---- W1: an already-finished peer answers at once, with its transcript ----
  const t1 = Date.now()
  const r1 = parse(cliSync(['wait', ptyB, '--json', '--timeout-ms', '60000'], 90000).stdout) ?? {}
  const ms1 = Date.now() - t1
  const w1 = r1.ok === true && r1.alreadyIdle === true && r1.state === 'idle' && (r1.tail ?? '').length > 0 && ms1 < 20000

  // ---- W2: --next-turn still waits for a REAL next turn ----
  const child = cliAsync(['wait', ptyB, '--next-turn', '--json', '--timeout-ms', '60000'])
  let out2 = ''
  let done2 = false
  child.stdout.on('data', (d) => (out2 += d))
  child.on('close', () => (done2 = true))
  await sleep(4000)
  const stillWaiting = !done2 // must NOT have answered while B just sits there
  await rpc(host, 'write', { ptyId: ptyB, data: 'turn-two-output\r' })
  const t2 = Date.now()
  while (!done2 && Date.now() - t2 < 45000) await sleep(400)
  const r2 = parse(out2) ?? {}
  const w2 = stillWaiting && done2 && r2.ok === true && r2.state === 'idle' && r2.alreadyIdle !== true

  // ---- W3: a peer stuck on a permission prompt reports blocked ----
  await rpc(host, 'write', { ptyId: ptyB, data: 'Do you want to proceed? (y/n)\r' })
  await sleep(4000)
  const t3 = Date.now()
  const r3 = parse(cliSync(['wait', ptyB, '--json', '--timeout-ms', '60000'], 90000).stdout) ?? {}
  const ms3 = Date.now() - t3
  const w3 = r3.ok === true && r3.blocked === true && r3.state === 'awaiting-input' && ms3 < 30000

  console.log(
    'RESULT:',
    JSON.stringify({
      ok: w1 && w2 && w3,
      w1: { ok: w1, alreadyIdle: r1.alreadyIdle, state: r1.state, ms: ms1, tailBytes: (r1.tail ?? '').length },
      w2: { ok: w2, stillWaitingAt4s: stillWaiting, finished: done2, state: r2.state, deltaBytes: (r2.delta ?? '').length },
      w3: { ok: w3, blocked: r3.blocked, state: r3.state, ms: ms3 },
    }),
  )

  try {
    spawnSync('taskkill', ['/PID', String(host.pid), '/T', '/F'], { stdio: 'ignore', timeout: 8000 })
  } catch {}
  process.exit(0)
}

main().catch((e) => {
  console.error('ERROR:', e && e.stack ? e.stack : String(e))
  process.exit(1)
})
