/**
 * Terminal glyph-alignment probe (BRIEF_TERMINAL_GLYPH_ALIGNMENT.md).
 *
 * Launches PLANO from the repo build with an ISOLATED userData (never the installed app), opens one
 * terminal, prints a known sample line, and MEASURES:
 *   1. cell metrics       — measured char advance, device/css cell size, integer-ness
 *   2. effective font     — term font-size actually handed to xterm (via the DOM/CSS xterm writes)
 *   3. transforms         — every transform between the xterm canvas and the page, plus the canvas'
 *                           device-pixel alignment (bounding rect × dpr → integer?)
 *   4. rasterisation      — per-glyph ink centroid of one text row, UNSELECTED vs SELECTED, from a
 *                           real screenshot. This is the symptom the user sees ("chueco" until a
 *                           selection redraws it), measured as numbers instead of adjectives.
 *
 * Usage: node .plano-tests/glyph-align-probe.mjs <port> [zoom] [label]
 */
import { spawn, spawnSync } from 'node:child_process'
import http from 'node:http'
import WebSocket from 'ws'
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = Number(process.argv[2] || 9377)
const ZOOM = Number(process.argv[3] || 1)
const LABEL = process.argv[4] || 'probe'
// APP_DIR lets the same probe drive an OLD build checked out in a git worktree.
const REPO = process.env.APP_DIR || 'D:/Tools/Plano'
const EXE = join(REPO, 'node_modules/electron/dist/electron.exe')
const UD = join(tmpdir(), `plano-glyph-ud-${PORT}`)
const PROJECT = join(tmpdir(), 'plano-glyph-project')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const getJson = (p) =>
  new Promise((res, rej) => {
    http
      .get(`http://127.0.0.1:${PORT}${p}`, (r) => {
        let d = ''
        r.on('data', (c) => (d += c))
        r.on('end', () => {
          try {
            res(JSON.parse(d))
          } catch (e) {
            rej(e)
          }
        })
      })
      .on('error', rej)
  })

if (!existsSync(EXE)) {
  console.error('no electron binary at', EXE)
  process.exit(1)
}

// ── seed an isolated userData (NEVER the user's installed PLANO) ────────────────────────────────
rmSync(UD, { recursive: true, force: true })
mkdirSync(UD, { recursive: true })
mkdirSync(PROJECT, { recursive: true })
writeFileSync(join(PROJECT, 'package.json'), '{"name":"glyph-probe"}\n')
writeFileSync(
  join(UD, 'workspaces.json'),
  JSON.stringify({
    schemaVersion: 1,
    savedAt: new Date().toISOString(),
    activeId: 'sp1',
    workspaces: [
      {
        id: 'sp1',
        name: 'Glyph',
        folderPath: PROJECT,
        viewport: { x: 0, y: 0, zoom: ZOOM },
        regions: [],
        panels: [
          {
            id: 'panel-glyph',
            type: 'terminal',
            rect: { x: 80, y: 60, width: 900, height: 460 },
            z: 1,
            title: 'Terminal',
            props: { tabs: [{ id: 'tab-glyph' }], activeTabId: 'tab-glyph', terminalNumber: 1 },
          },
        ],
      },
    ],
  }),
)
writeFileSync(join(UD, 'session.json'), JSON.stringify({ folderPath: PROJECT }))
writeFileSync(
  join(UD, 'settings.json'),
  JSON.stringify({
    version: 9,
    general: { restoreLastWorkspace: true, restoreAgentSessions: false, showFilesOnLaunch: false, warnBeforeQuit: false, confirmClosePanelWithProcess: false, agentDoneSound: false },
    appearance: { theme: 'monolith', accent: '#FFFFFF', gridStyle: 'dots', gridOpacity: 1, grain: false, reduceMotion: true },
    editor: {},
    terminal: { shell: 'cmd', shellPath: '', fontFamily: '', fontSize: 0, lineHeight: 1.0, cursorStyle: 'bar', cursorBlink: false, scrollback: 5000, theme: 'campbell', copyOnSelect: true, predictiveHistory: false, smartActions: false, autoSuspendIdle: true, keepAgentsOnQuit: false },
    canvas: { snapToGrid: true, showMinimap: false, zoomSensitivity: 1, autosave: false },
    browser: {},
    privacy: { telemetry: false, saveTerminalHistory: true },
    advanced: { hardwareAcceleration: true },
    agentMesh: { enabled: false },
    voice: { enabled: false },
  }),
)

const app = spawn(
  EXE,
  [
    '.',
    `--remote-debugging-port=${PORT}`,
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--disable-background-timer-throttling',
  ],
  { cwd: REPO, env: { ...process.env, PLANO_USER_DATA_DIR: UD }, stdio: 'ignore', windowsHide: false },
)
app.unref()

const kill = () => {
  try {
    spawnSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore', timeout: 8000 })
  } catch {}
}

async function main() {
  let page
  for (let i = 0; i < 120 && !page; i += 1) {
    try {
      const t = await getJson('/json')
      page = t.find((x) => x.type === 'page' && x.url.includes('index.html'))
    } catch {}
    if (!page) await sleep(500)
  }
  if (!page) throw new Error('no CDP page')

  const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 })
  await new Promise((res, rej) => {
    ws.once('open', res)
    ws.once('error', rej)
  })
  let id = 0
  const pend = new Map()
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString())
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
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.result?.exceptionDetails) return { __error: JSON.stringify(r.result.exceptionDetails).slice(0, 400) }
    return r.result?.result?.value
  }

  await send('Page.bringToFront')
  // catch the ptyId of the first terminal that streams data
  await ev(`(() => { window.__pty = null; window.plano.terminal.onData(e => { window.__pty = e.ptyId }); return true })()`)

  for (let i = 0; i < 90; i += 1) {
    const ready = await ev(`!!document.querySelector('.xterm canvas') && !!window.__pty`)
    if (ready === true) break
    await sleep(500)
  }
  await sleep(2500)

  // Normalise the canvas camera, then apply the requested zoom through the REAL UI controls
  // (×1.25 per step) so the measurement runs at a zoom the user can actually produce.
  await ev(`(() => { document.querySelector('[title="Reset zoom"]')?.click(); return true })()`)
  await sleep(900)
  const steps = Number(process.env.ZOOM_STEPS || 0)
  for (let i = 0; i < Math.abs(steps); i += 1) {
    await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>(x.getAttribute('aria-label')||x.title)===${steps > 0 ? "'Zoom in'" : "'Zoom out'"}); b&&b.click(); return !!b })()`)
    await sleep(500)
  }
  await sleep(1200)
  const zoomLabel = await ev(`document.querySelector('[title="Reset zoom"]')?.textContent?.trim() || null`)

  // BOLD=1 reproduces the user's second report: BOLD words render scribbled — lowercase closing up
  // into small-capital shapes — and snap to correct letterforms the instant they are selected.
  // Emitted through node so the escape survives every shell verbatim, and built from character
  // codes so no backslash has to cross a shell boundary. Long on purpose: the probe measures the
  // inkiest row, and this must out-ink the echoed command line above it. `selectionText` in the
  // output proves which row was actually measured.
  const BOLD_WORDS = 'dashboard gestor de tareas fixer de proyectos CLI tool metricas del sistema persistencia local'
  const BOLD_SAMPLE =
    'node -e "process.stdout.write(String.fromCharCode(27)+' +
    `'[1m${BOLD_WORDS}'` +
    '+String.fromCharCode(27)+' +
    "'[0m'" +
    '+String.fromCharCode(13)+String.fromCharCode(10))"'
  // STATUS=1 replays the user's REAL Claude Code status line, byte for byte — captured by running
  // their ~/.claude/statusline.js with a synthetic payload. Emoji segments, SGR 1 (bold) and
  // SGR 2 (DIM) separators, and colours. Reported symptom: the emoji render fine while the text on
  // that row comes out tiny and illegible. Written to a file rather than squeezed through a shell
  // one-liner so not a single byte depends on quoting or codepage.
  const statusFile = join(PROJECT, 'plano-status-sample.js')
  const E = 'E'
  const statusJs =
    `const c = String.fromCodePoint\nconst ${E} = '\\x1b'\n` +
    `process.stdout.write(\n` +
    `  c(128193) + ' ' + ${E} + '[36m' + ${E} + '[1m' + 'Plano' + ${E} + '[0m' + ${E} + '[2m' + ' \\u2502 ' + ${E} + '[0m' +\n` +
    `  c(129302) + ' ' + ${E} + '[35m' + 'Opus 5' + ${E} + '[0m' + ${E} + '[2m' + ' \\u2502 ' + ${E} + '[0m' +\n` +
    `  c(127807) + ' ' + ${E} + '[32m' + 'mac-build-odla' + ${E} + '[0m' + ${E} + '[33m' + ' \\u25cf' + ${E} + '[0m' + ${E} + '[2m' + ' \\u2502 ' + ${E} + '[0m' +\n` +
    `  c(128176) + ' ' + ${E} + '[2m' + '$0.4200' + ${E} + '[0m' + '\\r\\n')\n`
  writeFileSync(statusFile, statusJs, 'utf8')
  const STATUS_SAMPLE = `node "${statusFile.replace(/\\/g, '/')}"`
  // Deterministic sample: the exact shape of the user's screenshot (label + aligned path column).
  const SAMPLE = process.env.STATUS
    ? STATUS_SAMPLE
    : process.env.BOLD
      ? BOLD_SAMPLE
      : 'echo Claude Code  C:\\Users\\Administrator\\Desktop\\FINAL_1080p.mp4'
  await ev(`(() => { window.plano.terminal.write(window.__pty, ${JSON.stringify(SAMPLE + '\r')}); return true })()`)
  await sleep(1800)
  // CLI art sample: box drawing, Braille spinner, Claude's star marks, blocks, checks. Must still
  // render after any font/atlas change (CLAUDE.md: the layered fallback exists for exactly these).
  if (process.env.GLYPH_SAMPLE) {
    await ev(`(() => { window.plano.terminal.write(window.__pty, ${JSON.stringify('chcp 65001>nul\r')}); return true })()`)
    await sleep(900)
    await ev(`(() => { window.plano.terminal.write(window.__pty, ${JSON.stringify('echo ╭──╮ │ ⣋⠙⠹ ✻✳ █▉ ✓✗\r')}); return true })()`)
    await sleep(1500)
  }

  // ── 1..3: metrics + transforms, derived purely from the DOM xterm actually produced ───────────
  const metrics = await ev(`(() => {
    const xterm = document.querySelector('.xterm')
    if (!xterm) return { error: 'no xterm' }
    const screen = xterm.querySelector('.xterm-screen')
    const canvases = [...xterm.querySelectorAll('canvas')].map(c => ({
      cls: c.className,
      deviceW: c.width, deviceH: c.height,
      styleW: c.style.width, styleH: c.style.height,
      rect: (r => ({ x: r.x, y: r.y, w: r.width, h: r.height }))(c.getBoundingClientRect()),
    }))
    const rowsEl = xterm.querySelector('.xterm-rows')
    const domRendererActive = !!(rowsEl && rowsEl.children.length && rowsEl.textContent.trim().length)

    // The TERMINAL's real font. xterm 5.5 measures with canvas TextMetrics, so there is no
    // .xterm-char-measure-element to read: use the exact stack/size this probe seeded into
    // settings (fontSize 0 → the 13px default, fontFamily '' → TERMINAL_FONT) and CROSS-CHECK it
    // below against the canvas width (cols × cell must be exact).
    const me = document.querySelector('.xterm-char-measure-element')
    const fontFamily = me ? getComputedStyle(me).fontFamily : ${JSON.stringify(
      '"PLANO Terminal Text", "PLANO Term Symbols", "PLANO Term Dingbats", "Cascadia Mono", "Cascadia Code", Consolas, "Courier New", ui-monospace, SFMono-Regular, Menlo, "DejaVu Sans Mono", "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", monospace',
    )}
    const fontSize = me ? getComputedStyle(me).fontSize : '13px'
    const xtermMeasured = me ? { offsetWidth: me.offsetWidth, offsetHeight: me.offsetHeight, text: (me.textContent || '').length } : null

    // Measured OUTSIDE the zoomed world layer, so ancestor scale can't distort it.
    const probe = document.createElement('span')
    probe.style.cssText = 'position:absolute;top:-9999px;left:-9999px;white-space:pre;font-kerning:none;'
    probe.style.fontFamily = fontFamily
    probe.style.fontSize = fontSize
    probe.textContent = 'W'.repeat(32)
    document.body.appendChild(probe)
    const advance = (xtermMeasured ? xtermMeasured.offsetWidth / Math.max(1, xtermMeasured.text) : probe.offsetWidth / 32)
    const advanceExact = probe.getBoundingClientRect().width / 32 // true fractional advance
    probe.textContent = 'W'
    const charH = xtermMeasured ? xtermMeasured.offsetHeight : probe.offsetHeight
    probe.remove()

    // The font's OWN advance, straight from the text metrics (no rounding at all).
    const mctx = document.createElement('canvas').getContext('2d')
    mctx.font = fontSize + ' ' + fontFamily
    const measureText = mctx.measureText('W'.repeat(32)).width / 32
    const perChar = {}
    for (const ch of ['W', 'i', 'C', ':', '_', '1', '\\u25c7', '\\u2500']) {
      perChar[ch] = mctx.measureText(ch).width
    }

    const dpr = window.devicePixelRatio
    // xterm 5.5 measures the advance with canvas TextMetrics (fractional), then:
    //   device.char.width = floor(advance × dpr)   ← the cell pitch every glyph is placed on
    const measuredAdvance = xtermMeasured ? advance : measureText
    const deviceCharWidth = Math.floor(measuredAdvance * dpr)
    const deviceCharHeight = Math.ceil(charH * dpr)
    // Cross-check the derived pitch against the canvas the renderer actually allocated: the device
    // canvas width MUST be an exact multiple of the cell width (cols × cell), so a wrong guess shows.
    const deviceCanvasW = canvases[0] ? canvases[0].deviceW : 0
    const pitchDivides = deviceCharWidth > 0 && deviceCanvasW % deviceCharWidth === 0
    const divisorsInRange = []
    for (let w = 4; w <= 20; w++) if (deviceCanvasW % w === 0) divisorsInRange.push({ cell: w, cols: deviceCanvasW / w })

    // transform chain from the xterm element up to <body>
    const chain = []
    let el = xterm
    for (let i = 0; i < 14 && el && el !== document.documentElement; i += 1) {
      const s = getComputedStyle(el)
      const r = el.getBoundingClientRect()
      if (s.transform !== 'none' || el === xterm || el.dataset.wheelOwn !== undefined) {
        chain.push({
          tag: el.tagName, cls: (el.className || '').toString().slice(0, 48),
          transform: s.transform, rectX: r.x, rectY: r.y, w: r.width, h: r.height,
        })
      }
      el = el.parentElement
    }

    // Mirror of the engine's advanceRatio(): the ratio it snaps the font size with, and whether the
    // primary face was actually available when it measured.
    const firstFam = fontFamily.split(',')[0].trim().replace(/^['"]|['"]$/g, '')
    const ratioCtx = document.createElement('canvas').getContext('2d')
    ratioCtx.font = '400 100px ' + fontFamily
    const stackRatio = ratioCtx.measureText('W'.repeat(32)).width / 32 / 100
    const firstFamReady = document.fonts.check("100px '" + firstFam + "'", 'W')
    const fonts = {
      terminalText: document.fonts.check(fontSize + ' "PLANO Terminal Text"'),
      symbols: document.fonts.check(fontSize + ' "PLANO Term Symbols"'),
      dingbats: document.fonts.check(fontSize + ' "PLANO Term Dingbats"'),
      jetbrains: document.fonts.check(fontSize + ' "JetBrains Mono"'),
      status: document.fonts.status,
    }

    const first = canvases[0]
    const cols = first ? first.deviceW / Math.max(1, deviceCharWidth) : 0
    return {
      dpr, fontFamily, fontSize, xtermMeasured,
      advance, advanceExact, measureText, measuredAdvance, perChar, charH,
      deviceCharWidth, deviceCharHeight, pitchDivides, divisorsInRange,
      // The gap the cell grid loses to Math.floor: every glyph is rasterised at its natural advance
      // but placed on this narrower pitch.
      pitchDeficitPx: measuredAdvance * dpr - deviceCharWidth,
      cssCellWidth: deviceCharWidth / dpr,
      derivedCols: cols, colsIsInteger: Number.isInteger(cols),
      canvases, screenStyle: screen ? { w: screen.style.width, h: screen.style.height } : null,
      domRendererActive, chain, fonts, firstFam, firstFamReady, stackRatio,
      // Populated only while a temporary debug hook is present in TerminalEngine (it is NOT shipped).
      // To dump xterm's live cell metrics again, re-add in applyFontSize():
      //   window.__termDbgNow = () => ({ fontSize: term.options.fontSize,
      //     charSize: term._core._charSizeService, dimensions: term._core._renderService.dimensions })
      dbg: window.__termDbgNow ? window.__termDbgNow() : null,
    }
  })()`)

  // ── 4: per-glyph ink metrics of one text row, UNSELECTED vs SELECTED ─────────────────────────
  // Locate the row that carries the sample text by scanning ink columns of the screenshot clip.
  const geom = await ev(`(() => {
    const xterm = document.querySelector('.xterm')
    const r = xterm.getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height }
  })()`)

  // Cell pitch + canvas origin INSIDE the screenshot clip, so the pixel analysis can sit on the
  // exact grid xterm renders to.
  const cellW = metrics?.cssCellWidth || 8
  const originX = (metrics?.canvases?.[0]?.rect?.x ?? geom.x) - Math.floor(geom.x)

  const shot = async (tag, forcedBand = null) => {
    const res = await send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
      clip: { x: Math.floor(geom.x), y: Math.floor(geom.y), width: Math.ceil(geom.w), height: Math.ceil(geom.h), scale: 1 },
    })
    const b64 = res.result?.data
    if (!b64) return { __error: 'no screenshot ' + tag }
    if (process.env.SHOT_DIR) {
      writeFileSync(join(process.env.SHOT_DIR, `${LABEL}-${tag}.png`), Buffer.from(b64, 'base64'))
      // 8× nearest-neighbour crop of the text band: what "chueco" actually looks like, per pixel.
      const zoomed = await ev(`(async () => {
        const img = new Image(); img.src = 'data:image/png;base64,' + ${JSON.stringify(b64)}
        await img.decode()
        const band = ${JSON.stringify(forcedBand)}
        const y0 = band ? Math.max(0, band.top - 4) : 60
        const h = band ? band.height + 8 : 24
        const w = 150, S = 8
        const c = document.createElement('canvas'); c.width = w * S; c.height = h * S
        const g = c.getContext('2d'); g.imageSmoothingEnabled = false
        g.drawImage(img, 0, y0, w, h, 0, 0, w * S, h * S)
        return c.toDataURL('image/png').split(',')[1]
      })()`)
      if (typeof zoomed === 'string') {
        writeFileSync(join(process.env.SHOT_DIR, `${LABEL}-${tag}-8x.png`), Buffer.from(zoomed, 'base64'))
      }
    }
    // decode + analyse INSIDE the page (it has a decoder); return numbers only
    return ev(`(async () => {
      const img = new Image()
      img.src = 'data:image/png;base64,' + ${JSON.stringify(b64)}
      await img.decode()
      const c = document.createElement('canvas')
      c.width = img.naturalWidth; c.height = img.naturalHeight
      const g = c.getContext('2d', { willReadFrequently: true })
      g.drawImage(img, 0, 0)
      const d = g.getImageData(0, 0, c.width, c.height).data
      const lum = (i) => (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114)
      const cellW = ${JSON.stringify(cellW)}
      const originX = ${JSON.stringify(originX)}   // canvas left edge inside this clip

      // Per-row ink using a LOCAL background (the selection paints a lighter band, so an absolute
      // threshold would count the selection rectangle as ink).
      const rowStats = []
      for (let y = 0; y < c.height; y++) {
        const vals = []
        for (let x = 0; x < c.width; x++) vals.push(lum((y * c.width + x) * 4))
        const sorted = [...vals].sort((a, b) => a - b)
        const bg = sorted[Math.floor(sorted.length * 0.5)]           // median = the row's background
        let ink = 0
        for (const v of vals) if (v - bg > 25) ink += v - bg
        rowStats.push({ bg, ink, vals })
      }
      const forced = ${JSON.stringify(forcedBand)}
      let best = 0
      for (let y = 1; y < rowStats.length; y++) if (rowStats[y].ink > rowStats[best].ink) best = y
      let top = best, bot = best
      const thr = rowStats[best].ink * 0.05
      while (top > 0 && rowStats[top - 1].ink > thr) top--
      while (bot < c.height - 1 && rowStats[bot + 1].ink > thr) bot++
      // Comparing two renderings of the SAME row: reuse the first pass's band so the selection's
      // brighter background cannot shift the measurement window.
      if (forced) { top = forced.top; bot = forced.bot; best = Math.round((top + bot) / 2) }

      // Per-CELL ink metrics on the cell grid xterm claims to draw on.
      const cells = []
      const nCells = Math.floor((c.width - originX) / cellW)
      for (let k = 0; k < nCells; k++) {
        const x0 = Math.round(originX + k * cellW)
        const x1 = Math.round(originX + (k + 1) * cellW)
        let sum = 0, wx = 0, wy = 0
        for (let y = top; y <= bot; y++) {
          const bg = rowStats[y].bg
          for (let x = x0; x < x1 && x < c.width; x++) {
            const v = rowStats[y].vals[x] - bg
            if (v > 25) { sum += v; wx += v * (x - x0); wy += v * y }
          }
        }
        cells.push(sum > 0 ? { k, ink: Math.round(sum), cx: wx / sum, cy: wy / sum } : { k, ink: 0, cx: null, cy: null })
      }
      // Colour-fringe magnitude: LCD/subpixel antialiasing tints each stroke edge red or blue, and
      // the tint differs per glyph (each letter's ink starts at its own sub-pixel phase). On a dark
      // terminal that reads as letters sitting at slightly different offsets — the "chueco" look.
      let fringeSum = 0, fringeN = 0, fringeStrong = 0
      for (let y = top; y <= bot; y++) {
        const bg = rowStats[y].bg
        for (let x = 0; x < c.width; x++) {
          const i = (y * c.width + x) * 4
          if (rowStats[y].vals[x] - bg > 25) {
            const rb = Math.abs(d[i] - d[i + 2])
            fringeSum += rb; fringeN++
            if (rb > 24) fringeStrong++
          }
        }
      }

      // RENDERED cell pitch, straight from the pixels: autocorrelate the column-ink profile of a
      // long ASCII row. The peak lag is the pitch xterm actually drew on, with no app internals.
      const prof = []
      for (let x = 0; x < c.width; x++) {
        let s = 0
        for (let y = top; y <= bot; y++) { const v = rowStats[y].vals[x] - rowStats[y].bg; if (v > 25) s += v }
        prof.push(s)
      }
      const mean = prof.reduce((a, b) => a + b, 0) / (prof.length || 1)
      const corr = []
      for (let lag = 4; lag <= 24; lag++) {
        let num = 0, n = 0
        for (let x = 0; x + lag < prof.length; x++) { num += (prof[x] - mean) * (prof[x + lag] - mean); n++ }
        corr.push({ lag, r: n ? num / n : 0 })
      }
      const peak = corr.reduce((a, b) => (b.r > a.r ? b : a), corr[0])

      const inked = cells.filter(c2 => c2.ink > 0)
      const cys = inked.map(c2 => c2.cy)
      const meanY = cys.reduce((a, b) => a + b, 0) / (cys.length || 1)
      const sdY = Math.sqrt(cys.reduce((a, b) => a + (b - meanY) ** 2, 0) / (cys.length || 1))
      const cxs = inked.map(c2 => c2.cx)
      const meanX = cxs.reduce((a, b) => a + b, 0) / (cxs.length || 1)
      const sdX = Math.sqrt(cxs.reduce((a, b) => a + (b - meanX) ** 2, 0) / (cxs.length || 1))
      return {
        band: { top, bot, height: bot - top + 1 }, bandBg: rowStats[best].bg,
        // Surface opacity check: the terminal must stay ONE continuous opaque surface. Sampled at
        // three heights — a second rectangle (xterm viewport / unrendered area showing through)
        // would make these medians disagree.
        surfaceBg: [0.08, 0.5, 0.92].map(f => rowStats[Math.floor(c.height * f)].bg),
        cellW, originX, inkedCells: inked.length,
        pitchPeakLag: peak.lag, pitchCorr: corr.map(c2 => [c2.lag, Math.round(c2.r)]),
        fringeMeanRB: fringeN ? +(fringeSum / fringeN).toFixed(2) : null,
        fringeStrongPct: fringeN ? +((fringeStrong / fringeN) * 100).toFixed(1) : null,
        inkPixels: fringeN,
        centroidYMean: meanY, centroidYSd: sdY,
        centroidXMean: meanX, centroidXSd: sdX,
        cells: cells.slice(0, 64).map(c2 => c2.ink ? { k: c2.k, ink: c2.ink, cx: +c2.cx.toFixed(3), cy: +c2.cy.toFixed(3) } : { k: c2.k, ink: 0 }),
      }
    })()`)
  }

  const before0 = await shot('probe-band')
  // Second pass with the band known, so the saved 8× crop frames the text row exactly.
  const before = await shot('before', before0?.band || null)

  // Drag-select the text band (screen coords) exactly like the user does.
  await ev(`(() => {
    window.__evt = { down: 0, move: 0, up: 0, target: null, targets: [], path: null }
    const rec = (k) => (e) => { window.__evt[k]++; if (k === 'down') { window.__evt.target = (e.target.className || e.target.tagName || '').toString().slice(0, 40); window.__evt.targets.push(window.__evt.target); window.__evt.path = e.composedPath().slice(0, 6).map(n => (n.className || n.tagName || '').toString().slice(0, 30)) } }
    window.addEventListener('mousedown', rec('down'), true)
    window.addEventListener('mousemove', rec('move'), true)
    window.addEventListener('mouseup', rec('up'), true)
    return true
  })()`)
  const bandY = geom.y + (before?.band ? (before.band.top + before.band.bot) / 2 : 40)
  const x0 = geom.x + 6
  const x1 = geom.x + geom.w - 26
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0, y: bandY, buttons: 0 })
  await sleep(80)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: bandY, button: 'left', clickCount: 1, buttons: 1 })
  await sleep(80)
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x0, y: bandY, button: 'left', clickCount: 1, buttons: 0 })
  await sleep(300)
  await sleep(60)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: bandY, button: 'left', clickCount: 1, buttons: 1, pointerType: 'mouse' })
  await sleep(150)
  for (let s = 1; s <= 6; s += 1) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0 + ((x1 - x0) * s) / 6, y: bandY, button: 'left', buttons: 1, pointerType: 'mouse' })
    await sleep(70)
  }
  await sleep(150)
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x1, y: bandY, button: 'left', clickCount: 1, buttons: 0, pointerType: 'mouse' })
  await sleep(800)
  const evtLog = await ev(`JSON.stringify(window.__evt)`)
  // copyOnSelect is ON in the seeded settings, so a REAL xterm selection lands in the clipboard.
  const selectionText = await ev('window.plano.clipboard.readText()')
  const after = await shot('after', before && before.band ? before.band : null)

  const out = { label: LABEL, zoom: ZOOM, zoomLabel, metrics, before, after, selectionText, evtLog }
  console.log(JSON.stringify(out, null, 1))

  await ev('window.plano.window.close()').catch(() => {})
  await sleep(900)
  kill()
  process.exit(0)
}

main().catch(async (e) => {
  console.error('PROBE ERROR', e)
  kill()
  process.exit(1)
})
