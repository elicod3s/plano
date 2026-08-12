// v5 A2 probe: the production provisioning path — the daemon started the way the APP starts it
// (`--userData <dir>` as an argv flag, PLANO_USER_DATA_DIR deliberately NOT exported).
//   P1 the `plano` CLI is installed into <userData>/bin.
//   P2 a spawned shell has that bin dir on its PATH (the bug: cleanEnv read the env var only,
//      so in every real install no agent could find `plano`).
//   P3 `plano` actually RESOLVES inside that shell (where/command -v finds it).
//   P4 every installed harness got its mesh briefing (Claude/Kiro skill + AGENTS.md blocks),
//      written into a throwaway HOME so the real one is never touched.
import { spawn, spawnSync } from 'node:child_process'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ELECTRON = 'D:/Tools/Plano/node_modules/electron/dist/electron.exe'

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
  const UD = path.join(os.tmpdir(), `mesh-path-${run}`)
  const PRJ = path.join(os.tmpdir(), `mesh-pathp-${run}`)
  // A throwaway HOME: provisioning writes into harness config dirs, and a probe must never
  // touch the user's real ~/.codex, ~/.gemini, … Only dirs that exist count as installed, so
  // seed the ones we assert on.
  const HOME = path.join(os.tmpdir(), `mesh-home-${run}`)
  fs.mkdirSync(UD, { recursive: true })
  fs.mkdirSync(PRJ, { recursive: true })
  for (const d of ['.codex', '.gemini', '.cursor', '.pi', path.join('.config', 'opencode'), path.join('.kiro', 'skills')]) {
    fs.mkdirSync(path.join(HOME, d), { recursive: true })
  }
  fs.writeFileSync(path.join(HOME, '.codex', 'AGENTS.md'), '# my own notes\n\nkeep me\n', 'utf8')

  // Exactly how AgentHostClient.spawnDaemon does it: argv flag, no PLANO_USER_DATA_DIR.
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

  const binDir = path.join(UD, 'bin')
  const p1 = fs.existsSync(path.join(binDir, 'plano-cli.js')) && fs.existsSync(path.join(binDir, 'plano.cmd'))

  // A real shell through the daemon, then ask IT where plano is — the agent's own view.
  const ptyId = `probe-${run}-0001-0001-000000000001`
  const created = await rpc(host, 'create', { ptyId, panelId: 'p1', terminalId: 't1', spaceId: 's1', cwd: PRJ, cols: 120, rows: 30 })
  if (created?.ok === false) throw new Error('create failed: ' + JSON.stringify(created))
  await sleep(2500)
  // `where.exe`, not `where`: in PowerShell (the default shell here) bare `where` is an alias of
  // Where-Object and silently does nothing. This asks the SHELL ITSELF to resolve `plano`.
  await rpc(host, 'write', { ptyId, data: 'where.exe plano\r' })
  await sleep(4000)
  const buffer = ((await rpc(host, 'attach', { ptyId }))?.buffer ?? '').replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
  const flat = buffer.replace(/\r?\n/g, '').toLowerCase()
  const variants = [binDir, (() => { try { return fs.realpathSync.native(binDir) } catch { return binDir } })()]
  const p2 = variants.some((v) => flat.includes(v.toLowerCase()))
  const p3 = variants.some((v) => flat.includes(`${v.toLowerCase()}\\plano.cmd`))

  const briefed = {
    codex: fs.existsSync(path.join(HOME, '.codex', 'AGENTS.md')) && fs.readFileSync(path.join(HOME, '.codex', 'AGENTS.md'), 'utf8'),
    gemini: fs.existsSync(path.join(HOME, '.gemini', 'GEMINI.md')) && fs.readFileSync(path.join(HOME, '.gemini', 'GEMINI.md'), 'utf8'),
    opencode: fs.existsSync(path.join(HOME, '.config', 'opencode', 'AGENTS.md')),
    cursor: fs.existsSync(path.join(HOME, '.cursor', 'AGENTS.md')),
    pi: fs.existsSync(path.join(HOME, '.pi', 'AGENTS.md')),
    claudeSkill: fs.existsSync(path.join(HOME, '.claude', 'skills', 'plano-mesh', 'SKILL.md')),
    kiroSkill: fs.existsSync(path.join(HOME, '.kiro', 'skills', 'plano-mesh', 'SKILL.md')),
  }
  const p4 =
    typeof briefed.codex === 'string' &&
    briefed.codex.includes('BEGIN PLANO MESH') &&
    briefed.codex.includes('keep me') && // user content preserved, never clobbered
    typeof briefed.gemini === 'string' &&
    briefed.gemini.includes('plano agent-context') &&
    briefed.opencode &&
    briefed.cursor &&
    briefed.pi &&
    briefed.claudeSkill &&
    briefed.kiroSkill

  console.log(
    'RESULT:',
    JSON.stringify({
      ok: p1 && p2 && p3 && p4,
      p1: { ok: p1, binDir },
      p2: { ok: p2 },
      p3: { ok: p3, tail: p2 && p3 ? null : buffer.slice(-320) },
      p4: { ok: p4, ...Object.fromEntries(Object.entries(briefed).map(([k, v]) => [k, typeof v === 'string' ? v.includes('BEGIN PLANO MESH') : v])) },
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
