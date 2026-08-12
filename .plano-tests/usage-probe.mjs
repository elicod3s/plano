// PLAN_USAGE_POPOVER probe (extends PLAN_STATUS_BAR_LIVE_USAGE) — the daemon started the way the
// APP starts it (`--userData <dir>` as an argv flag, PLANO_USER_DATA_DIR deliberately NOT
// exported). All provider endpoints are served by LOCAL MOCK SERVERS so the assertions are
// deterministic and no real credential ever leaves the machine:
//   (a) the Claude statusLine hook scripts + settings merge are installed and idempotent
//       (second boot leaves the file byte-identical).
//   (b) a synthetic POST /usage/claude with a REAL-shaped payload (incl. seven_day_opus →
//       premiumWeekly "Fable") lands as a `claude` provider with THREE windows.
//   (c) a synthetic codex rollout parses into session/weekly by window_minutes.
//   (d) providers with NO credentials (gemini, omp) are ABSENT — never 0%.
//   (e) grok: the mock billing endpoint (the real cli-chat-proxy.grok.com/v1/billing?format=
//       credits shape) is called with the xAI headers and parses to a weekly window.
//   (f) opencode-go: the mock _server workspaces call + /workspace/<id>/go page (the real
//       server-fn protocol) are called with the pasted cookie and parse to session/weekly/monthly.
//   (g) with credentials removed, grok and opencode-go are ABSENT (the row rule: absent means
//       not installed, never "we didn't implement it").
// Prints `RESULT: {ok:true,…}` including the resulting provider snapshot.
import { spawn, spawnSync } from 'node:child_process'
import net from 'node:net'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ELECTRON = 'D:/Tools/Plano/node_modules/electron/dist/electron.exe'
const DAEMON = 'D:/Tools/Plano/out/main/daemon.js'
const WEBROOT = 'D:/Tools/Plano/web-dist'
const SERVER_ID = 'def39973159c7f0483d8793a822b8dbb10d067e12c65455fcb4608459ba0234f'
const COOKIE = 'Fe26.2**testcookie'
const WID = 'wrk_abc123'

function rpc(host, method, params) {
  return new Promise((res, rej) => {
    const socket = net.connect(host.port, '127.0.0.1')
    const timer = setTimeout(() => { socket.destroy(); rej(new Error('tcp timeout ' + method)) }, 15000)
    let buf = ''
    let sent = false
    socket.on('connect', () => socket.write(JSON.stringify({ id: 1, method: 'hello', params: { token: host.token } }) + '\n'))
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8')
      for (const line of buf.split('\n').filter(Boolean)) {
        let msg
        try { msg = JSON.parse(line) } catch { continue }
        if (msg.id === 1 && !sent) { sent = true; socket.write(JSON.stringify({ id: 2, method, params }) + '\n'); continue }
        if (msg.id === 2) { clearTimeout(timer); socket.destroy(); res(msg.result); return }
      }
    })
    socket.on('error', rej)
  })
}

function postJson(port, body) {
  return new Promise((res, rej) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/usage/claude', method: 'POST', headers: { 'Content-Type': 'application/json' } },
      (resp) => { let d = ''; resp.on('data', (c) => (d += c.toString('utf8'))); resp.on('end', () => res({ status: resp.statusCode, body: d })) },
    )
    req.on('error', rej)
    req.end(JSON.stringify(body))
  })
}

/** Local mock for cli-chat-proxy.grok.com/v1 + opencode.ai (the _server protocol). */
function startMock() {
  const seen = { grok: null, workspaces: null, page: null }
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const cookie = req.headers.cookie ?? ''
    if (url.pathname === '/v1/billing') {
      seen.grok = {
        authorization: req.headers.authorization ?? null,
        xai: req.headers['x-xai-token-auth'] ?? null,
        userid: req.headers['x-userid'] ?? null,
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          config: {
            currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', start: '2026-08-08T19:35:08.380403+00:00', end: '2026-08-15T19:35:08.380403+00:00' },
            creditUsagePercent: 46.0,
            billingPeriodStart: '2026-08-08T19:35:08.380403+00:00',
            billingPeriodEnd: '2026-08-15T19:35:08.380403+00:00',
          },
        }),
      )
      return
    }
    if (url.pathname === '/_server') {
      seen.workspaces = {
        serverId: req.headers['x-server-id'] ?? null,
        instance: req.headers['x-server-instance'] ?? null,
        cookie,
        authorization: req.headers.authorization ?? null,
      }
      const authed = cookie.includes('Fe26.2**testcookie')
      // Authenticated → the server-fn script carries the workspace ids; unauthenticated → the
      // exact "public actor" error shape Orca sees without a session.
      const body = authed
        ? `;0x2a6;((self.$R=self.$R||{})["server-fn:${Math.random().toString(36)}"]=[],($R=>$R[0]={id:"${WID}"}))`
        : `;0x2a6;((self.$R=self.$R||{})["server-fn:${Math.random().toString(36)}"]=[],($R=>$R[0]=Object.assign(new Error("actor of type \\"public\\" is not associated with an account"),{stack:"Error"})))`
      res.writeHead(200, { 'Content-Type': 'text/javascript' })
      res.end(body)
      return
    }
    if (url.pathname === `/workspace/${WID}/go`) {
      seen.page = { cookie }
      res.writeHead(200, { 'Content-Type': 'text/html' })
      // The real page renders UNQUOTED keys (`rollingUsage:{usagePercent:12,...}`) — the parser
      // mirrors Orca's regexes, which require that exact shape.
      res.end(
        '<!doctype html><html><head><title>Go</title></head><body><script>window.__GO__={' +
          'rollingUsage:{usagePercent:12,resetInSec:3600},' +
          'weeklyUsage:{usagePercent:34,resetInSec:604800},' +
          'monthlyUsage:{usagePercent:7,resetInSec:2592000}' +
        '}</script></body></html>',
      )
      return
    }
    res.writeHead(404)
    res.end('not found')
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, seen }))
  })
}

function bootDaemon(env) {
  const daemon = spawn(ELECTRON, [DAEMON, '--userData', env.UD, '--webRoot', WEBROOT], {
    env: env.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    windowsHide: true,
  })
  daemon.stderr.on('data', (c) => fs.appendFileSync(path.join(env.UD, 'probe-daemon.err'), c.toString('utf8')))
  daemon.unref()
  return daemon
}

async function waitHost(UD) {
  for (let i = 0; i < 50; i += 1) {
    try {
      const h = JSON.parse(fs.readFileSync(path.join(UD, 'agent-host.json'), 'utf8'))
      // Verify the daemon actually answers with THIS file's token: a crashed prior run can leave
      // a stale file (or a live daemon) behind, and the probe must never talk to the wrong host.
      const ok = await new Promise((res) => {
        const s = net.connect(h.port, '127.0.0.1')
        const t = setTimeout(() => { s.destroy(); res(false) }, 1500)
        s.on('connect', () => s.write(JSON.stringify({ id: 1, method: 'hello', params: { token: h.token } }) + '\n'))
        s.on('data', () => { clearTimeout(t); s.destroy(); res(true) })
        s.on('error', () => { clearTimeout(t); res(false) })
      })
      if (ok) return h
    } catch {}
    await sleep(400)
  }
  throw new Error('daemon never came up (or host file races a stale daemon)')
}

async function main() {
  const run = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  const UD = path.join(os.tmpdir(), `plano-usage-${run}`)
  const HOME = path.join(os.tmpdir(), `plano-usage-home-${run}`)
  const CODEHOME = path.join(os.tmpdir(), `plano-usage-codex-${run}`)
  fs.mkdirSync(path.join(UD, 'bin'), { recursive: true })
  fs.mkdirSync(path.join(HOME, '.claude'), { recursive: true })
  fs.mkdirSync(path.join(HOME, '.grok'), { recursive: true })
  fs.mkdirSync(path.join(HOME, '.local', 'share', 'opencode'), { recursive: true })
  fs.writeFileSync(path.join(HOME, '.claude', '.credentials.json'), '{"dummy":true}', 'utf8')
  // Real-shaped credentials: grok's auth.x.ai entry (OAuth JWT), opencode's sk- API key.
  fs.writeFileSync(
    path.join(HOME, '.grok', 'auth.json'),
    JSON.stringify({
      'https://auth.x.ai::11111111-2222-3333-4444-555555555555': {
        key: 'synthetic-jwt-token', auth_mode: 'oauth', user_id: 'user-123', email: 'probe@example.com',
        expires_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
      },
    }),
  )
  fs.writeFileSync(path.join(HOME, '.local', 'share', 'opencode', 'auth.json'), JSON.stringify({ 'opencode-go': { type: 'api', key: 'sk-synthetic' } }))
  // The pasted opencode.ai web-session cookie (Settings → Usage).
  fs.writeFileSync(path.join(UD, 'settings.json'), JSON.stringify({ usage: { opencodeCookie: COOKIE } }))
  fs.mkdirSync(CODEHOME, { recursive: true })

  const { server: mock, port: mockPort, seen } = await startMock()

  const baseEnv = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    HOME,
    USERPROFILE: HOME,
    CODEX_HOME: CODEHOME,
    GROK_CLI_CHAT_PROXY_BASE_URL: `http://127.0.0.1:${mockPort}/v1`,
    OPENCODE_BASE_URL: `http://127.0.0.1:${mockPort}`,
  }
  delete baseEnv.PLANO_USER_DATA_DIR

  // ── boot #1: every credential present ────────────────────────────────────
  bootDaemon({ UD, env: baseEnv })
  const host = await waitHost(UD)

  // (a) hook scripts + settings merge
  const cmdHook = path.join(UD, 'bin', 'plano-statusline.cmd')
  const shHook = path.join(UD, 'bin', 'plano-statusline')
  const claudeSettings = path.join(HOME, '.claude', 'settings.json')
  const a_hookFiles = fs.existsSync(cmdHook) && fs.existsSync(shHook)
  const a_merged = (() => {
    try {
      const doc = JSON.parse(fs.readFileSync(claudeSettings, 'utf8'))
      return doc.statusLine?.type === 'command' && typeof doc.statusLine.command === 'string' && doc.statusLine.command.includes('plano-statusline.cmd')
    } catch { return false }
  })()
  const firstBootSettings = (() => { try { return fs.readFileSync(claudeSettings, 'utf8') } catch { return null } })()

  // (b) synthetic Claude payload — all three windows, resets_at as epoch seconds AND ISO.
  const nowS = Math.floor(Date.now() / 1000)
  const post = await postJson(host.webPort, {
    session_id: 'synthetic',
    rate_limits: {
      five_hour: { used_percentage: 4, resets_at: nowS + 3600 * 5 },
      seven_day: { used_percentage: 53, resets_at: new Date(Date.now() + 3600 * 1000).toISOString() },
      seven_day_opus: { used_percentage: 74, resets_at: nowS + 3600 * 60 },
    },
  })
  const b_postOk = post.status === 200
  // Parameterized so boot #2's snapshot hits ITS daemon, never the killed boot #1 host.
  const claudeEntry = (h = host) => ((rpc(h, 'usage:get', {}) || { providers: [] }))
  let snap = await claudeEntry()
  const claudeP = snap.providers.find((p) => p.provider === 'claude')
  const b_claude =
    !!claudeP && claudeP.status === 'ok' &&
    Math.round(claudeP.session?.usedPercent ?? -1) === 4 &&
    Math.round(claudeP.weekly?.usedPercent ?? -1) === 53 &&
    Math.round(claudeP.premiumWeekly?.usedPercent ?? -1) === 74 &&
    claudeP.premiumLabel === 'Fable' &&
    claudeP.source === 'statusline'

  // (c) synthetic codex rollout (the real event_msg/token_count shape; classification by window).
  fs.writeFileSync(path.join(CODEHOME, 'auth.json'), '{"tokens":{"id_token":"synthetic"}}', 'utf8')
  const rolloutDir = path.join(CODEHOME, 'sessions', '2026', '08', '12')
  fs.mkdirSync(rolloutDir, { recursive: true })
  fs.writeFileSync(
    path.join(rolloutDir, 'rollout-2026-08-12T00-00-00-synthetic.jsonl'),
    JSON.stringify({
      timestamp: new Date().toISOString(), ordinal: 3, type: 'event_msg',
      payload: {
        type: 'token_count', info: { total_token_usage: { total_tokens: 100 } },
        rate_limits: {
          limit_id: 'codex',
          primary: { used_percent: 28, window_minutes: 10080, resets_at: nowS + 7 * 86400 },
          secondary: { used_percent: 41, window_minutes: 300, resets_at: nowS + 5 * 3600 },
          credits: { has_credits: false, unlimited: false, balance: '0' }, plan_type: 'plus',
        },
      },
    }) + '\n', 'utf8',
  )
  await rpc(host, 'usage:refresh', {})
  await sleep(2000)
  snap = await claudeEntry()
  const codexP = snap.providers.find((p) => p.provider === 'codex')
  const c_codex =
    !!codexP && codexP.status === 'ok' &&
    Math.round(codexP.session?.usedPercent ?? -1) === 41 &&
    Math.round(codexP.weekly?.usedPercent ?? -1) === 28 &&
    codexP.source === 'session-file'

  // (e) grok — mock billing called with the xAI headers, parsed to a weekly window.
  const grokP = snap.providers.find((p) => p.provider === 'grok')
  const grokResets = Date.parse('2026-08-15T19:35:08.380403+00:00')
  const e_grok =
    !!grokP && grokP.status === 'ok' &&
    Math.round(grokP.weekly?.usedPercent ?? -1) === 46 &&
    grokP.weekly?.windowMinutes === 10080 &&
    typeof grokP.weekly?.resetsAt === 'number' && Math.abs(grokP.weekly.resetsAt - grokResets) < 1000 &&
    grokP.source === 'api' &&
    seen.grok?.xai === 'xai-grok-cli' &&
    String(seen.grok?.authorization ?? '').startsWith('Bearer ') &&
    seen.grok?.userid === 'user-123'

  // (f) opencode-go — the _server workspaces call + /workspace/<id>/go page with the cookie.
  const ocP = snap.providers.find((p) => p.provider === 'opencode-go')
  const f_opencode =
    !!ocP && ocP.status === 'ok' &&
    Math.round(ocP.session?.usedPercent ?? -1) === 12 &&
    Math.round(ocP.weekly?.usedPercent ?? -1) === 34 &&
    Math.round(ocP.monthly?.usedPercent ?? -1) === 7 &&
    ocP.session?.windowMinutes === 300 && ocP.weekly?.windowMinutes === 10080 && ocP.monthly?.windowMinutes === 43200 &&
    ocP.source === 'api' &&
    seen.workspaces?.serverId === SERVER_ID &&
    typeof seen.workspaces?.instance === 'string' && seen.workspaces.instance.startsWith('server-fn:') &&
    String(seen.workspaces?.cookie ?? '').includes(COOKIE) &&
    String(seen.page?.cookie ?? '').includes(COOKIE)

  // (d) providers without credentials (gemini, omp) are ABSENT; no 0 % meters anywhere.
  const d_absent =
    !snap.providers.some((p) => p.provider === 'gemini' || p.provider === 'omp') &&
    snap.providers.every((p) => p.session?.usedPercent !== 0 && p.weekly?.usedPercent !== 0 && p.monthly?.usedPercent !== 0 && p.premiumWeekly?.usedPercent !== 0)

  // ── boot #2: SAME dirs, credentials REMOVED → claude merge idempotent + grok/opencode absent.
  try { spawnSync('taskkill', ['/PID', String(host.pid), '/T', '/F'], { stdio: 'ignore', timeout: 8000 }) } catch {}
  await sleep(800)
  fs.rmSync(path.join(HOME, '.grok', 'auth.json'))
  fs.rmSync(path.join(HOME, '.local', 'share', 'opencode', 'auth.json'))
  fs.writeFileSync(path.join(UD, 'settings.json'), JSON.stringify({ usage: {} }))
  bootDaemon({ UD, env: baseEnv })
  const host2 = await waitHost(UD)
  await sleep(2500) // let the boot refresh (file + network) land
  const snap2 = await claudeEntry(host2)
  const secondBootSettings = (() => { try { return fs.readFileSync(claudeSettings, 'utf8') } catch { return null } })()
  const a_idempotent =
    firstBootSettings !== null && secondBootSettings === firstBootSettings && (secondBootSettings.match(/statusLine/g) || []).length === 1
  const g_absent =
    !snap2.providers.some((p) => p.provider === 'grok' || p.provider === 'opencode-go') &&
    snap2.providers.some((p) => p.provider === 'claude') // claude stays (credentials still seeded)

  try { spawnSync('taskkill', ['/PID', String(host2.pid), '/T', '/F'], { stdio: 'ignore', timeout: 8000 }) } catch {}
  try { mock.close() } catch {}

  const ok = a_hookFiles && a_merged && a_idempotent && b_postOk && b_claude && c_codex && d_absent && e_grok && f_opencode && g_absent
  console.log(
    'RESULT:',
    JSON.stringify({
      ok,
      a: { hookFiles: a_hookFiles, merged: a_merged, idempotent: a_idempotent },
      b: { postOk: b_postOk, claude: b_claude, claudeWindows: claudeP ? { session: claudeP.session, weekly: claudeP.weekly, premiumWeekly: claudeP.premiumWeekly, premiumLabel: claudeP.premiumLabel } : null },
      c: { codex: c_codex },
      d: { absent: d_absent, presentProviders: snap.providers.map((p) => p.provider).sort() },
      e: { grok: e_grok, grokRequestHeaders: seen.grok },
      f: { opencode: f_opencode, opencodeRequest: { serverIdOk: seen.workspaces?.serverId === SERVER_ID, instanceOk: typeof seen.workspaces?.instance === 'string' && seen.workspaces.instance.startsWith('server-fn:') } },
      g: { absentWithoutCredentials: g_absent, boot2Providers: snap2.providers.map((p) => p.provider).sort() },
      snapshot: snap,
    }),
  )
  process.exit(0)
}

main().catch((e) => {
  console.error('ERROR:', e && e.stack ? e.stack : String(e))
  process.exit(1)
})
