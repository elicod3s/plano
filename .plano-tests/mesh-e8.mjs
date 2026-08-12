// Plan AGENT_MESH_INTERCONNECT E8: `PLANO.exe --mesh-deprovision` (the uninstaller hook) must
// strip the `plano` MCP key from every harness config, restore backups, and delete the skill —
// leaving other servers and user content untouched. Runs with an isolated HOME.
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function main() {
  const run = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  const HOME = path.join(os.tmpdir(), `mesh-e8-${run}`)
  const UD = path.join(os.tmpdir(), `mesh-e8ud-${run}`)
  fs.mkdirSync(HOME, { recursive: true })
  fs.mkdirSync(UD, { recursive: true })
  // A provisioned Claude config: plano key + another server + a backup that predates plano.
  fs.writeFileSync(
    path.join(HOME, '.claude.json'),
    JSON.stringify(
      {
        mcpServers: {
          github: { type: 'http', url: 'http://example.com/github' },
          plano: { type: 'http', url: 'http://127.0.0.1:56780/cli', headers: { Authorization: 'Bearer abc' } },
        },
      },
      null,
      2,
    ),
    'utf8',
  )
  fs.writeFileSync(path.join(HOME, '.claude.json.plano-backup'), JSON.stringify({ mcpServers: { github: { type: 'http', url: 'http://example.com/github' } } }), 'utf8')
  fs.mkdirSync(path.join(HOME, '.codex'), { recursive: true })
  fs.writeFileSync(path.join(HOME, '.codex', 'config.toml'), '[mcp_servers.plano]\ntype = "http"\nurl = "http://127.0.0.1:56780/cli"\n\n[mcp_servers.gh]\ntype = "http"\nurl = "http://example.com/gh"\n', 'utf8')
  fs.mkdirSync(path.join(HOME, '.claude', 'skills', 'plano-mesh'), { recursive: true })
  fs.writeFileSync(path.join(HOME, '.claude', 'skills', 'plano-mesh', 'SKILL.md'), '# PLANO Mesh\n', 'utf8')

  const app = spawn('D:/Tools/Plano/node_modules/electron/dist/electron.exe', ['.', '--mesh-deprovision'], {
    env: { ...process.env, PLANO_USER_DATA_DIR: UD, USERPROFILE: HOME, HOME },
    stdio: 'ignore',
    windowsHide: true,
  })
  const exited = await new Promise((res) => {
    app.on('exit', (code) => res(code))
    setTimeout(() => res('timeout'), 20000)
  })

  const claude = JSON.parse(fs.readFileSync(path.join(HOME, '.claude.json'), 'utf8'))
  const codex = fs.readFileSync(path.join(HOME, '.codex', 'config.toml'), 'utf8')
  const skillGone = !fs.existsSync(path.join(HOME, '.claude', 'skills', 'plano-mesh', 'SKILL.md'))

  console.log(
    'RESULT:',
    JSON.stringify({
      exitCode: exited,
      claudePlanoGone: !('plano' in (claude.mcpServers ?? {})),
      githubStillThere: !!claude.mcpServers?.github,
      backupRestored: fs.readFileSync(path.join(HOME, '.claude.json'), 'utf8').includes('example.com/github'),
      codexPlanoGone: !codex.includes('[mcp_servers.plano]'),
      codexGhStillThere: codex.includes('[mcp_servers.gh]'),
      skillGone,
    }),
  )
  process.exit(0)
}
main().catch((e) => {
  console.error('ERR', e)
  process.exit(1)
})
