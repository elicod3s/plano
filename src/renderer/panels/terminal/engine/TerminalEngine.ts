import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import '@xterm/xterm/css/xterm.css'
import type { TerminalProps } from '@shared/domain/panel'
import type { TerminalSettings } from '@shared/domain/settings'
import type { AgentKind, AgentVerdict, ResumableAgent } from '@shared/domain/agent'
import { agentSessionFromCommand } from '@shared/domain/agent'
import { resumeAgentSession } from '../agentResume'
import { useTerminalStore } from '@/stores/useTerminalStore'
import { useTerminalControlStore } from '@/stores/useTerminalControlStore'
import { usePanelStore } from '@/stores/usePanelStore'
import { useViewportStore } from '@/stores/useViewportStore'
import { useAgentStore } from '@/stores/useAgentStore'
import { useSpacesStore } from '@/stores/useSpacesStore'
import { useWorkspaceStore } from '@/stores/useWorkspaceStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import {
  getPersistedTerminalTab,
  persistTerminalTabPatch,
} from '@/app/agentSessionPersistence'
import { TERMINAL_FONT } from '../xtermTheme'
import { getTerminalTheme } from '../terminalThemes'
import { applyCanvasZoomMouseFix } from '../canvasZoomMouse'
import {
  FIT_RETRY_FRAMES,
  clampFontSize,
  effectiveFontSize,
  parseOsc7Cwd,
  resolveShell,
  snapFontSizeToWholeCell,
  snapRenderScale,
  isEmojiPresentationWide,
} from './render'
import { makeSmartTitle } from '../smartTitle'

// The verified setup loads xterm's WebGL renderer for every visible terminal. Its canvas renderer
// is important here: the DOM fallback paints rows as positioned spans, and those spans are clipped
// at the right edge when they inherit the canvas/panel transforms. Keep the working-set accounting
// for detach/reattach, but do not impose an application-level cap; Chromium remains the authority on
// context availability and loadWebgl() already falls back safely if allocation fails.
const MAX_WEBGL_TERMINALS = Number.POSITIVE_INFINITY
let liveWebglTerminals = 0
// Observe real box changes and coalesce a resize burst.
//
// These two numbers decide how often the PTY is told its grid changed, and a column change is far
// from free: xterm REFLOWS (re-wraps) the scrollback, and every TUI on the other side repaints.
// At 32ms/0.5px a panel drag or a canvas zoom published a SIGWINCH ~30x per second, so a full-screen
// CLI drawing into the normal buffer (Grok, omp) had its already-emitted lines re-wrapped underneath
// it while it was still writing — old and new frames ended up interleaved on the same rows
// ("000*Worked for 14m43s/30.00 por cada 500 productos"). Nothing about that is recoverable
// afterwards: the reflow rewrote the buffer.
//
// So: hold the grid still for the whole gesture and resize ONCE when it settles. 140ms is below the
// ~200ms that reads as lag but well above a drag's frame cadence, and 1.5px ignores the sub-pixel
// jitter of the zoom animation while still catching any real layout change (a cell is ~8x20px).
const FIT_DEBOUNCE_MS = 140
const FIT_RESIZE_EPSILON = 1.5

// The glyph advance a font stack has AT a given size, measured the way xterm's CharSizeService
// measures it. Feeds snapFontSizeToWholeCell so the pitch xterm floors into the cell grid and the
// advance the glyph is actually drawn with are the same whole device pixel.
// Measured only once the PRIMARY face of the stack is really available: during `font-display: swap`
// the canvas measures the FALLBACK instead (Consolas advances 0.55em where JetBrains Mono advances
// 0.60em), and a size snapped to the fallback's metrics lands the grid on the wrong pitch for the
// font actually drawn. `document.fonts.status === 'loaded'` is NOT that guarantee: a face nobody has
// requested yet is not "pending", so status reads 'loaded' while the terminal face is still absent.
// Returns 0 when it cannot measure honestly — callers then keep xterm's own metrics.
let measureCtx: CanvasRenderingContext2D | null | undefined
function advanceAt(fontFamily: string, px: number): number {
  try {
    if (typeof document === 'undefined' || !document.fonts || !(px > 0)) return 0
    const primary = fontFamily.split(',')[0].trim().replace(/^['"]|['"]$/g, '')
    // 'W' as the test string: the default ('BESbswy') reports false for symbol-only faces.
    if (primary && !document.fonts.check(`100px '${primary}'`, 'W')) return 0
    if (measureCtx === undefined) measureCtx = document.createElement('canvas').getContext('2d')
    if (!measureCtx) return 0
    // Byte-for-byte the same measurement xterm's CharSizeService makes (no weight, single 'W').
    measureCtx.font = `${px}px ${fontFamily}`
    const width = measureCtx.measureText('W').width
    // A monospace advance is ~0.5–0.7em; anything outside that is a bad measurement, not a font.
    return width > px * 0.3 && width < px * 1.2 ? width : 0
  } catch {
    return 0 // no 2D context (headless / GPU loss) — keep xterm's own metrics
  }
}

/**
 * A live terminal session that OUTLIVES React. The xterm `Terminal` instance, its addons, the PTY
 * stream wiring, the agent-detection signals and the per-terminal options/zoom subscriptions all
 * live here for the whole life of the terminal — not the life of a React mount. React only `attach`es
 * the DOM (re-parenting the existing `term.element` into a freshly-mounted render box) and `detach`es
 * it on unmount. The PTY keeps streaming into the (possibly off-screen) `Terminal` the entire time,
 * so switching TABS within a panel is a pure DOM re-parent — NO buffered replay, no flicker, no scroll
 * jump. The session is destroyed only by `dispose` (an explicit teardown, e.g. closing the tab).
 *
 * The one exception to that persistence is workspace ("space") hibernation: switching away from a
 * workspace whose terminals are kept running rips their renderer sessions down (freeing the WebGL
 * context + parser + subscriptions) while the PTY keeps running in main. Returning re-enters the
 * HMR-style `reattachPty` path — main replays its bounded 512 KB buffer once and the screen is rebuilt.
 * See app/terminalHibernation.ts + the `autoSuspendIdle` setting (a safety valve to turn it off).
 */
export interface TerminalSession {
  readonly termId: string
  readonly panelId: string
  /** Bind (or re-bind) the session to a mounted container + render box and start painting into it. */
  attach: (container: HTMLDivElement, renderBox: HTMLDivElement) => void
  /** Unbind from the DOM (React unmount). Keeps the Terminal + PTY + all wiring alive. */
  detach: () => void
  /** Destroy the renderer-side Terminal + addons + listeners. Does NOT kill the PTY — the teardown
   *  helpers in app/terminalSessions own that (they are the single PTY choke point). */
  dispose: () => void
  /** Deska-parity keyboard focus: focus this terminal's xterm helper textarea with scroll
   *  preservation and bounded retries while the DOM is still attaching. Never resizes, reattaches
   *  or recreates the Terminal and never touches PTY state. A new run supersedes any in-flight one. */
  focus: () => void
  /** Cancel any in-flight focus run for this terminal (focus moved elsewhere / component unmount). */
  cancelFocus: () => void
}

const termTheme = (id: TerminalSettings['theme'], override?: TerminalProps['theme']) =>
  getTerminalTheme(override ?? id)

function createSession(termId: string, panelId: string, removeSelf: () => void): TerminalSession {
  let disposed = false
  let ptyId: string | null = null

  // ── Current DOM binding (changes on every attach; null while detached) ─────────────────────────
  let renderBox: HTMLDivElement | null = null
  let attached = false
  let opened = false // has term.open() run yet?
  let scrollHealAttached = false // viewport 'scroll' self-heal bound once (the .xterm-viewport persists)

  // Terminal-lifetime teardown (subscriptions + IPC listeners). Cleared only on dispose.
  const unsubs: Array<() => void> = []
  // Per-attach teardown (DOM listeners + the ResizeObserver). Cleared on every detach.
  let resizeObs: ResizeObserver | null = null
  let hostCleanup: (() => void) | null = null

  // Per-PANEL props (theme is shared by all tabs); per-TERMINAL config lives in this tab.
  const panelProps = (): TerminalProps | undefined =>
    usePanelStore.getState().panels[panelId]?.props as TerminalProps | undefined
  const tab = () => getPersistedTerminalTab(panelId, termId)
  // Per-terminal font override: this tab's own value. Falls back to the panel-level LEGACY field ONLY
  // in the pre-migration window (no tab record yet); once a tab record exists — every tab created with
  // "+", and every tab after migration — it owns its zoom and never inherits the panel-level legacy.
  const fontOverride = (): number | undefined => {
    const t = tab()
    return t ? t.fontSize : panelProps()?.fontSize
  }

  const ts0 = useSettingsStore.getState().settings.terminal
  const override0 = panelProps()?.theme
  const fontOverride0 = fontOverride()

  // The current render-scale, snapped from the live canvas zoom. Established BEFORE open() so the
  // first fit measures the render box at the right size and xterm rasterizes at the right atlas.
  let currentScale = snapRenderScale(useViewportStore.getState().zoom)

  const baseFontSize = (): number =>
    effectiveFontSize(useSettingsStore.getState().settings.terminal, fontOverride())

  // Rasterize at the nearest size whose ADVANCE is a whole device pixel (see snapFontSizeToWholeCell).
  // Rounding the font size itself is not enough: an integer size still measures a fractional advance
  // (13px JetBrains Mono → 7.7999px), and xterm FLOORS that into the cell pitch, so every glyph is
  // drawn 0.8px wider than the cell it is placed in.
  const fontStack = (): string =>
    useSettingsStore.getState().settings.terminal.fontFamily || TERMINAL_FONT
  const scaledFontFor = (scale: number): number => {
    const family = fontStack()
    return snapFontSizeToWholeCell(
      Math.max(1, baseFontSize() * scale),
      window.devicePixelRatio || 1,
      (px) => advanceAt(family, px),
    )
  }
  // The render box counter-scale follows the RENDER SCALE only, never the pixel snap: folding the
  // snap in here would counter-scale the box by a fractional factor (0.9748…) and push the whole
  // canvas back off the device-pixel grid — the very thing the snap exists to prevent.
  const effScaleFor = (scale: number): number => scale

  // Cached effective on-screen scale; the mouse-fix divides the live world zoom by THIS each pointer
  // event, so caching keeps that hot path to one store read + a divide. Refreshed only when the
  // rendered font actually changes (a zoom step or a base-font change).
  let effScale = effScaleFor(currentScale)
  const refreshEffScale = (): void => {
    effScale = effScaleFor(currentScale)
  }

  // ── The Terminal instance + addons (built once, persisted) ─────────────────────────────────────
  const term = new Terminal({
    fontFamily: ts0.fontFamily || TERMINAL_FONT,
    fontSize: scaledFontFor(currentScale),
    // Clamp ≥ 1.0: the box-drawing glyphs of the bundled font stack carry ~1.32em of ink. xterm ceils
    // each row to `normalLineHeight × lineHeight`, so above ~1.3 the cell outgrows the ink and a strip
    // below every row tears vertical strokes (│ ║ ╭ sides) — measured in both the DOM and WebGL
    // renderers. The pre-glass build shipped 1.4 and the user verified it as pixel-perfect; the v9
    // experiment at 1.0 packed rows so tight that glyph ink overflowed the cell and CLI output read
    // as clipped/joined ("cut off"). Keep the effective floor at 1.4 for a terminal that matches the
    // verified build; users can still lower it via the Settings slider.
    lineHeight: Math.max(1.4, ts0.lineHeight),
    letterSpacing: 0, // non-zero corrupts selection geometry (xterm #4881)
    // Bold must be 600, not xterm's default 700. main.tsx loads JetBrains Mono at 400 and 600
    // ONLY, so a request for 700 matches the 600 face and the browser then FAKES the missing
    // weight by dilating the outlines. That synthetic bold is baked into the WebGL glyph atlas,
    // where it reads as smeared/scribbled text: dilation closes the apertures of `c` and `u`, so
    // bold lowercase starts looking like small capitals ("enCargué", "sU cUenta"). Asking for the
    // weight we actually ship makes the renderer use the real face and draw crisp bold.
    fontWeight: 400,
    fontWeightBold: 600,
    cursorBlink: ts0.cursorBlink,
    cursorStyle: ts0.cursorStyle,
    cursorWidth: 2,
    cursorInactiveStyle: 'outline',
    theme: termTheme(ts0.theme, override0),
    allowProposedApi: true,
    scrollback: ts0.scrollback,
    macOptionIsMeta: true,
    minimumContrastRatio: 1,
    // Deska parity: customGlyphs OFF → box-drawing / block / CLI-art glyphs are drawn FROM THE FONT
    // (which carry their own intra-cell metrics) instead of as vectors clipped to the cell. Measured:
    // the bundled JetBrains Mono box-drawing ink is ~1.32em, so at lineHeight 1.0 (the default) the
    // strokes overflow the cell and connect; the moment lineHeight pushes the cell past the ink
    // (~1.3), a sub-cell gap reopens below each row and tears the art — in BOTH customGlyphs modes.
    customGlyphs: false,
    rescaleOverlappingGlyphs: true, // wide/CJK/Powerline glyphs don't bleed into neighbors
    smoothScrollDuration: 0, // smooth scroll fights the zoom scroll-anchor — keep 0
    // TRUE only to get GRAYSCALE glyph antialiasing. xterm builds its glyph atlas on a 2D canvas
    // created with `alpha: allowTransparency`; with alpha:false that canvas is opaque, so Chromium
    // rasterizes every glyph with LCD SUBPIXEL antialiasing and bakes red/blue fringes into the
    // atlas — which xterm then colour-keys to alpha, so the fringes survive onto the real background.
    // Measured on one row of a normal path at 100% zoom: mean |R−B| across ink pixels was 55/255 and
    // 78% of ink pixels were strongly fringed. Subpixel AA is only correct for text painted straight
    // onto the physical grid; this canvas is composited through the world layer's transform, so every
    // letter picks up a different colour cast — the "chueco, nada centrado" look. The selection made
    // it "snap straight" purely because its lighter background washes the fringes out (measured:
    // 55 → 39), NOT because the glyphs moved (per-glyph centroid shift ≤ 0.07px).
    // The surface stays opaque: every theme's background/ANSI colours are fully opaque, and the WebGL
    // rectangle renderer paints them — this flag only tells xterm the glyph raster may carry alpha.
    allowTransparency: true,
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  term.loadAddon(new WebLinksAddon((_e, uri) => window.open(uri, '_blank')))
  const unicode = new Unicode11Addon()
  term.loadAddon(unicode)
  term.unicode.activeVersion = '11'
  // Unicode-11's wcwidth already gives 2 cells to almost every emoji, but a handful of BMP
  // emoji-presentation chars (❤ ⚡ ☀ ⭐ ⌚ …) are "ambiguous" and come out 1 cell — Windows
  // Terminal/ConPTY render them 2. Patch the active provider so they render wide, matching the
  // OS terminal. Wrapped defensively: if xterm's internals ever change shape this no-ops and the
  // (mostly correct) Unicode-11 widths remain.
  try {
    const v11 = (
      term as unknown as {
        _core: { unicodeService: { _providers: Record<string, { wcwidth(cp: number): number }> } }
      }
    )._core.unicodeService._providers['11']
    if (v11) {
      const orig = v11.wcwidth.bind(v11)
      v11.wcwidth = (cp: number): number => (isEmojiPresentationWide(cp) ? 2 : orig(cp))
    }
  } catch {
    /* keep Unicode-11 widths */
  }

  // Renderer: the WEBGL addon (Deska). DOM renderer's spans round to fractional positions under our
  // nested transforms and overlap; the 2D-canvas addon accumulates draws and ghosts. WebGL clears its
  // framebuffer every frame and rebuilds the glyph atlas crisp on cell-size change. Loaded lazily on
  // first open() — the renderer needs the element to exist — and globally budgeted so a large number
  // of terminals cannot exhaust Chromium's context allowance. Context loss falls back immediately;
  // allocating a replacement during GPU pressure is exactly the churn that used to amplify the crash.
  let webglAddon: WebglAddon | null = null
  let ownsWebglSlot = false
  const webglReloadAttempted = false
  const releaseWebgl = (): void => {
    if (!ownsWebglSlot) return
    ownsWebglSlot = false
    liveWebglTerminals = Math.max(0, liveWebglTerminals - 1)
  }
  const unloadWebgl = (): void => {
    if (webglAddon) {
      try {
        webglAddon.dispose()
      } catch {
        /* ignore */
      }
      webglAddon = null
    }
    releaseWebgl()
  }
  const loadWebgl = (): void => {
    if (webglAddon || liveWebglTerminals >= MAX_WEBGL_TERMINALS) return
    liveWebglTerminals += 1
    ownsWebglSlot = true
    try {
      const addon = new WebglAddon()
      addon.onContextLoss(() => {
        try {
          if (webglAddon !== addon) return
          addon.dispose()
        } catch {
          /* ignore */
        }
        webglAddon = null
        if (webglReloadAttempted) return // give up → DOM fallback, never loop (no console flood)
        releaseWebgl()
      })
      term.loadAddon(addon)
      webglAddon = addon
    } catch {
      releaseWebgl()
      webglAddon = null // WebGL unavailable → xterm keeps the DOM renderer
    }
  }

  // ── Render-box sizing + fit ────────────────────────────────────────────────────────────────────
  const applyRenderBoxStyle = (scale = currentScale): void => {
    if (!renderBox) return
    const eff = effScaleFor(scale)
    const pct = `${100 * eff}%`
    renderBox.style.position = 'absolute'
    renderBox.style.top = '0'
    renderBox.style.left = '0'
    renderBox.style.width = pct
    renderBox.style.height = pct
    renderBox.style.transformOrigin = '0 0'
    renderBox.style.transform = `scale(${1 / eff})`
  }

  // FIT (Deska's safeFit): no horizontal reserve needed (render-scale keeps on-screen scale ≈ 1, so
  // FitAddon's column count is exact); only correct a sub-pixel VERTICAL overflow so the bottom row
  // isn't clipped by the overflow:hidden box. One resize() per fit → one SIGWINCH for a TUI.
  const safeFit = (scrollBottom = true): void => {
    if (!renderBox || !term.element || renderBox.clientWidth === 0 || renderBox.clientHeight === 0)
      return
    const proposed = fit.proposeDimensions()
    if (!proposed || !Number.isFinite(proposed.cols) || !Number.isFinite(proposed.rows)) return

    // FitAddon computes the maximum grid that reaches the viewport edge. The scrollbar gutter
    // (`scrollbar-gutter: stable` on .xterm-viewport) already reserves the strip the scrollbar
    // occupies, so the last column can never slide under it — there is no need to sacrifice a
    // column here. (A `-1` used to sit here: it stole one cell from every TUI, so full-width
    // agents like omp clipped their rightmost column and the panel looked like a gray square
    // was covering the content.)
    let cols = Math.max(2, Math.floor(proposed.cols))
    let rows = Math.max(1, Math.floor(proposed.rows))

    const xel = term.element
    const cellHeight = xel.offsetHeight > 0 && term.rows > 0 ? xel.offsetHeight / term.rows : 0
    if (cellHeight > 0 && rows * cellHeight > renderBox.offsetHeight + 0.5) {
      rows = Math.max(1, rows - 1)
    }

    if (cols !== term.cols || rows !== term.rows) term.resize(cols, rows)

    try {
      term.refresh(0, term.rows - 1)
      if (scrollBottom) term.scrollToBottom()
    } catch {
      /* ignore */
    }
  }

  // Push the live grid size to the PTY only when it truly changed (one SIGWINCH per real change).
  let lastCols = term.cols
  let lastRows = term.rows
  const publishSize = (): void => {
    if (ptyId && (term.cols !== lastCols || term.rows !== lastRows)) {
      lastCols = term.cols
      lastRows = term.rows
      window.plano.terminal.resize(ptyId, term.cols, term.rows)
    }
  }

  // rAF-coalesced explicit fit, with a few retries while a just-(re)attached render box still
  // measures zero (the layout gap right after term.element is re-parented into a new container).
  let fitRaf = 0
  const requestFit = (frames = FIT_RETRY_FRAMES): void => {
    if (fitRaf) cancelAnimationFrame(fitRaf)
    fitRaf = requestAnimationFrame(() => {
      fitRaf = 0
      if (disposed || !renderBox) return
      if (renderBox.clientWidth === 0 || renderBox.clientHeight === 0) {
        if (frames > 0) requestFit(frames - 1)
        return
      }
      try {
        safeFit()
        publishSize()
      } catch {
        /* fit can throw mid-teardown */
      }
    })
  }

  const applyFontSize = (): void => {
    term.options.fontSize = scaledFontFor(currentScale)
    refreshEffScale()
  }

  // ── Canvas-zoom re-raster (Deska model) ─────────────────────────────────────────────────────────
  // On a render-scale STEP change, ATOMICALLY set the counter-scaled box, currentScale and the font in
  // ONE frame so they can NEVER disagree. There is deliberately NO fit here. Two reasons:
  //   1. cols/rows are scale-INVARIANT: the box width is container×eff and the cell width is baseCell×eff,
  //      so cols = box/cell = container/baseCell regardless of zoom. Zooming must not change the grid.
  //   2. The fit that DOES run (on a real layout change) is owned by the renderBox ResizeObserver, which
  //      fires only AFTER the box has actually laid out at its new size. Fitting here instead raced the
  //      box's %-width reflow: getComputedStyle returned the OLD box width while the font/cell was already
  //      NEW, so the fit paired a new cell with the old box → wrong column count → the grid kept the
  //      previous scale's width (clip when zooming out, underfill when zooming in). Measured live.
  // A plain repaint finishes the visual rebuild; the observer corrects cols if a real resize warrants it.
  let scaleRaf = 0
  const applyScale = (scale: number): void => {
    if (scaleRaf) cancelAnimationFrame(scaleRaf)
    scaleRaf = requestAnimationFrame(() => {
      scaleRaf = 0
      if (disposed || !attached || !renderBox) return
      applyRenderBoxStyle(scale)
      currentScale = scale
      applyFontSize()
      try {
        term.refresh(0, term.rows - 1)
      } catch {
        /* refresh can throw mid-teardown */
      }
    })
  }
  const onZoom = (): void => {
    if (disposed || !attached) return
    const target = snapRenderScale(useViewportStore.getState().zoom)
    if (target === currentScale) return
    if (scaleRaf) cancelAnimationFrame(scaleRaf)
    scaleRaf = requestAnimationFrame(() => {
      scaleRaf = requestAnimationFrame(() => {
        scaleRaf = 0
        if (disposed || !attached || !renderBox) return
        const settled = snapRenderScale(useViewportStore.getState().zoom)
        if (settled === currentScale) return
        applyScale(settled)
      })
    })
  }
  unsubs.push(useViewportStore.subscribe(onZoom))

  // ── Shell-ready latch (gates agent-resume so the resume command lands at a live prompt) ──────────
  let shellReady = false
  const shellReadyWaiters: Array<() => void> = []
  const markShellReady = (): void => {
    if (shellReady) return
    shellReady = true
    shellReadyWaiters.splice(0).forEach((f) => f())
  }
  const whenShellReady = (): Promise<void> =>
    shellReady
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          shellReadyWaiters.push(resolve)
          setTimeout(resolve, 2500)
        })

  // ── Agent-session capture (so a workspace reopen can resume the conversation) ────────────────────
  let lastCaptureKind: AgentKind | null = null
  let captureRetryTimer: number | undefined
  let captureInFlight = false
  const idRequired = new Set<ResumableAgent>(['claude', 'codex', 'gemini'])
  const stopCaptureRetry = (): void => {
    window.clearTimeout(captureRetryTimer)
    captureRetryTimer = undefined
  }
  const scheduleCaptureRetry = (id: string): void => {
    if (disposed || captureRetryTimer !== undefined) return
    captureRetryTimer = window.setTimeout(() => {
      captureRetryTimer = undefined
      const current = useAgentStore.getState().byPty[id]
      if (current?.active) captureAgentSession(id, current, true)
    }, 1500)
  }
  const clearAgentSessionProp = (): void => {
    if (tab()?.agentSession) persistTerminalTabPatch(panelId, termId, { agentSession: undefined })
  }
  const captureAgentSession = (id: string, verdict: AgentVerdict, retry = false): void => {
    if (!verdict.active || !verdict.kind) {
      stopCaptureRetry()
      lastCaptureKind = null
      clearAgentSessionProp()
      return
    }
    const kindChanged = verdict.kind !== lastCaptureKind
    lastCaptureKind = verdict.kind
    if (!retry && !kindChanged && verdict.phase !== 'idle') return
    if (captureInFlight) {
      scheduleCaptureRetry(id)
      return
    }
    captureInFlight = true
    const liveCwd = useTerminalStore.getState().byPanel[termId]?.cwd ?? ''
    void window.plano.agent
      .resolveSession(id, liveCwd)
      .then((ref) => {
        if (disposed) return
        const current = useAgentStore.getState().byPty[id]
        if (!current?.active || current.kind !== verdict.kind) return
        if (!ref || (idRequired.has(ref.agent) && !ref.sessionId)) {
          scheduleCaptureRetry(id)
          return
        }
        const cur = tab()?.agentSession
        if (cur && cur.agent === ref.agent && cur.sessionId === ref.sessionId && cur.cwd === ref.cwd)
          return
        stopCaptureRetry()
        persistTerminalTabPatch(panelId, termId, { agentSession: ref })
      })
      .catch(() => scheduleCaptureRetry(id))
      .finally(() => {
        captureInFlight = false
      })
  }
  unsubs.push(stopCaptureRetry)

  // OSC-7 cwd reports (consumed → never displayed) drive the live git badge; also latch shell-ready.
  const oscCwd = term.parser.registerOscHandler(7, (payload) => {
    const cwd = parseOsc7Cwd(payload)
    if (cwd) useTerminalStore.getState().setCwd(termId, cwd)
    markShellReady()
    return true
  })
  unsubs.push(() => oscCwd.dispose())

  // Imperative controls for the panel-chrome toolbar (Clear / scroll-to-bottom). Registered for the
  // life of the Terminal (survives tab switches now); cleared on dispose.
  useTerminalControlStore.getState().register(termId, {
    clear: () => {
      term.clear()
      term.focus()
    },
    scrollToBottom: () => term.scrollToBottom(),
  })

  // Live-apply terminal settings + per-terminal theme/font override. A signature guard keeps the
  // panel-store subscription cheap during unrelated changes (e.g. dragging another panel).
  let lastSig = JSON.stringify([
    ts0.fontFamily, ts0.fontSize, ts0.lineHeight, ts0.cursorStyle, ts0.cursorBlink, ts0.scrollback, ts0.theme, override0, fontOverride0,
  ])
  const applyTerminalOptions = (): void => {
    const t = useSettingsStore.getState().settings.terminal
    const override = panelProps()?.theme
    const sig = JSON.stringify([
      t.fontFamily, t.fontSize, t.lineHeight, t.cursorStyle, t.cursorBlink, t.scrollback, t.theme, override, fontOverride(),
    ])
    if (sig === lastSig) return
    lastSig = sig
    term.options.fontFamily = t.fontFamily || TERMINAL_FONT
    // Re-assert the shipped bold weight: a live terminal created before this fix (or by an
    // older build) is still on xterm's synthetic-bold default until something reapplies it.
    term.options.fontWeight = 400
    term.options.fontWeightBold = 600
    term.options.fontSize = scaledFontFor(currentScale)
    refreshEffScale()
    term.options.lineHeight = Math.max(1, t.lineHeight)
    term.options.cursorStyle = t.cursorStyle
    term.options.cursorBlink = t.cursorBlink
    term.options.scrollback = t.scrollback
    term.options.theme = termTheme(t.theme, override)
    requestFit()
  }
  unsubs.push(useSettingsStore.subscribe(applyTerminalOptions))
  // Only react to THIS panel's props changing — a drag/resize of any OTHER panel was refiltering +
  // re-stringifying the whole options signature for every live terminal each frame. Immer gives
  // each panel a fresh `props` object only when ITS props actually change, so a reference check on
  // `state.panels[panelId].props` skips the rest at O(1).
  unsubs.push(
    usePanelStore.subscribe((state, prev) => {
      if (state.panels[panelId]?.props === prev.panels[panelId]?.props) return
      applyTerminalOptions()
    }),
  )

  // FONT-LOAD RE-FIT. xterm measures the cell ONCE at open(); bundled webfonts (font-display: swap)
  // often aren't loaded yet, so it measures a narrower fallback and FitAddon over-counts columns.
  // document.fonts.ready covers ALL bundled families (incl. the symbol layers); flipping fontFamily
  // forces a re-measure with the now-loaded font, then a fit (which only resizes the PTY on a real
  // cols/rows change, so this converges with no extra redraws).
  const remeasureAndFit = (): void => {
    if (disposed || !term.element) return
    const fam = useSettingsStore.getState().settings.terminal.fontFamily || TERMINAL_FONT
    term.options.fontFamily = 'monospace'
    term.options.fontFamily = fam
    // Re-snap the size too: the size chosen at construction used whatever face was loaded THEN (a
    // fallback, mid-`font-display: swap`), so its advance ratio — and therefore the whole-pixel size
    // derived from it — belongs to the wrong font. Now the real face is loaded, so this lands the
    // cell pitch on the grid for the font actually being drawn.
    applyFontSize()
    requestFit()
  }
  if (typeof document !== 'undefined' && document.fonts) {
    const px = ts0.fontSize > 0 ? ts0.fontSize : 13
    // Wait for the exact full terminal face, not Fontsource's separate JetBrains subsets. The
    // latter can report ready while xterm is still holding fallback glyphs in its atlas.
    void document.fonts.load(`${px}px "PLANO Terminal Text"`).then(remeasureAndFit).catch(() => {})
    void document.fonts.ready.then(remeasureAndFit)
  }

  // Copy-on-select (opt-in): mirror the selection to the clipboard as it's made.
  const selDisposable = term.onSelectionChange(() => {
    if (!useSettingsStore.getState().settings.terminal.copyOnSelect) return
    const sel = term.getSelection()
    if (sel) void window.plano.clipboard.writeText(sel)
  })
  unsubs.push(() => selDisposable.dispose())

  // ── Clipboard helpers ────────────────────────────────────────────────────────────────────────
  const pasteText = (text: string): void => {
    const trimmed = (text || '').replace(/[\r\n]+$/, '')
    if (trimmed) term.paste(trimmed)
  }
  const readClipboard = async (): Promise<string> => {
    try {
      const viaMain = await window.plano.clipboard.readText()
      if (viaMain) return viaMain
    } catch {
      /* fall through to the renderer clipboard */
    }
    try {
      return await navigator.clipboard.readText()
    } catch {
      return ''
    }
  }
  const pasteFromClipboard = async (): Promise<void> => pasteText(await readClipboard())
  const copySelection = (): void => {
    const sel = term.getSelection()
    if (sel) void window.plano.clipboard.writeText(sel)
  }

  // Per-terminal font zoom (classic terminal Ctrl +/−). Stored on THIS tab's config so each terminal
  // remembers its own zoom and it persists with the workspace; the panel-store subscription re-applies.
  const adjustFontSize = (delta: number): void => {
    const t = useSettingsStore.getState().settings.terminal
    const current = effectiveFontSize(t, tab()?.fontSize)
    const next = clampFontSize(current + delta)
    if (next !== current) persistTerminalTabPatch(panelId, termId, { fontSize: next })
  }

  // Ctrl/Cmd+C copies only with a selection (else stays SIGINT); Ctrl/Cmd+V falls through to OS paste
  // (handled by the native paste listener); Ctrl +/− zooms this terminal's font. Bound to the Terminal.
  term.attachCustomKeyEventHandler((e): boolean => {
    if (e.type !== 'keydown') return true
    const mod = e.ctrlKey || e.metaKey
    if (!mod) return true
    if (e.key === '=' || e.key === '+') {
      e.preventDefault()
      adjustFontSize(1)
      return false
    }
    if (e.key === '-') {
      e.preventDefault()
      adjustFontSize(-1)
      return false
    }
    const key = e.key.toLowerCase()
    if (key === 'v') return false
    if (key === 'c' && term.hasSelection()) {
      e.preventDefault()
      copySelection()
      return false
    }
    return true
  })

  // ── PTY stream wiring (bound once; stays live so an off-screen Terminal keeps mirroring) ─────────
  const wire = (id: string): void => {
    unsubs.push(
      window.plano.terminal.onData((e) => {
        if (e.ptyId === id) term.write(e.data)
      }),
      window.plano.terminal.onExit((e) => {
        if (e.ptyId === id) {
          term.writeln('\r\n\x1b[2m[process exited]\x1b[0m')
          useTerminalStore.getState().setStatus(termId, 'exited')
        }
      }),
      window.plano.agent.onSignal((e) => {
        if (e.ptyId !== id) return
        useAgentStore.getState().setVerdict(id, e.verdict)
        // WinPTY (the default Windows PTY backend — ConPTY crashes on 25H2 26200.8313) swallows
        // the TUI's startup `\x1b[?2004h` bracketed-paste handshake, so xterm never enables
        // bracketed paste and a multi-line paste into an agent lands as one Enter per line
        // (each line becomes its own prompt). Re-assert the mode here, driven by detection:
        // agent TUIs all support bracketed paste; plain shells get it off again on exit.
        term.write(e.verdict.active ? '\x1b[?2004h' : '\x1b[?2004l')
        captureAgentSession(id, e.verdict)
      }),
    )

    // Best-effort capture of the prompts the user sends to a detected agent (no AI). Buffer printable
    // keystrokes while the agent is active; finalize on Enter; skip noise (slash-commands, menu nav).
    // The FIRST real prompt is frozen for the header identity strip; the LAST one keeps updating so
    // the "last prompt" peek can recall what was last asked without scrolling back through the output.
    let promptBuf = ''
    let firstCaptured = false
    const looksLikePrompt = (text: string): boolean =>
      text.length >= 3 && !text.startsWith('/') && /[\p{L}\p{N}]/u.test(text)
    const capturePrompt = (data: string): void => {
      if (!useAgentStore.getState().byPty[id]?.active) {
        promptBuf = ''
        firstCaptured = false
        return
      }
      for (const ch of data) {
        if (ch === '\r' || ch === '\n') {
          const text = promptBuf.replace(/\s+/g, ' ').trim()
          promptBuf = ''
          if (looksLikePrompt(text)) {
            const store = useAgentStore.getState()
            const first = !firstCaptured
            if (first) {
              firstCaptured = true
              store.setPrompt(id, text.slice(0, 120))
              // Smart tab title: derive from the user's first prompt (the actual task), local
              // and instant. Persisted on the tab so the tab bar, mesh and manager all show it.
              // A user-set title (or a title already generated) is never overwritten.
              const smart = makeSmartTitle(text)
              if (smart && !tab()?.title) {
                persistTerminalTabPatch(panelId, termId, { title: smart })
              }
            }
            // Keep the full-ish latest prompt (capped) for the on-demand peek.
            store.setLastPrompt(id, text.slice(0, 2000))
            // Forward to the CANONICAL context in main (mesh timeline + search).
            try {
              window.plano.agentMesh.reportPrompt({
                ptyId: id,
                text: text.slice(0, 4000),
                first,
                source: 'keyboard',
                at: Date.now(),
              })
            } catch {
              /* main may be mid-teardown; the renderer store is already updated */
            }
          }
        } else if (ch === '\x7f' || ch === '\b') {
          promptBuf = promptBuf.slice(0, -1)
        } else if (ch === '\x1b') {
          promptBuf = ''
          return
        } else if (ch >= ' ') {
          promptBuf += ch
        }
      }
    }

    // Track a straightforward shell command line while no agent is active. When Auto-approve is
    // armed and the user types `codex`/`claude` manually, replace that still-unsubmitted line with
    // the flagged command before Enter reaches the shell. Complex cursor/history edits are left
    // untouched rather than guessing at shell state.
    let shellLine = ''
    let shellLineTrackable = true
    const rewriteShellLaunch = (data: string): string => {
      if (useAgentStore.getState().byPty[id]?.active) {
        shellLine = ''
        shellLineTrackable = true
        return data
      }
      let outgoing = ''
      for (const ch of data) {
        if (ch === '\r' || ch === '\n') {
          const command = shellLine
          if (shellLineTrackable && command) {
            const cwd = useTerminalStore.getState().byPanel[termId]?.cwd ?? ''
            const explicit = agentSessionFromCommand(command, cwd)
            if (explicit) persistTerminalTabPatch(panelId, termId, { agentSession: explicit })
            const approved = command
            if (approved !== command) {
              outgoing += '\x7f'.repeat(command.length) + approved + ch
              shellLine = ''
              shellLineTrackable = true
              continue
            }
          }
          shellLine = ''
          shellLineTrackable = true
        } else if (ch === '\x7f' || ch === '\b') {
          shellLine = shellLine.slice(0, -1)
        } else if (ch === '\x03' || ch === '\x15') {
          shellLine = ''
          shellLineTrackable = true
        } else if (ch === '\x1b' || ch === '\t' || ch < ' ') {
          shellLineTrackable = false
        } else if (shellLineTrackable) {
          shellLine += ch
        }
        outgoing += ch
      }
      return outgoing
    }

    term.onData((data) => {
      capturePrompt(data)
      window.plano.terminal.write(id, rewriteShellLaunch(data))
    })
  }

  // ── PTY lifecycle: fresh spawn vs HMR reattach ──────────────────────────────────────────────────
  const spawnPty = (): void => {
    const t0 = tab()
    // Panel-level cwd/shell/agentSession are LEGACY single-terminal fields that exist only until the
    // first mount migrates them into tab[0] (see TerminalPanel). Read them ONLY in that pre-migration
    // window — i.e. when this terminal has no tab record yet. Once a tab record exists (every tab made
    // with "+", and every tab after migration), its OWN fields are the sole source, so a brand-new tab
    // never inherits the panel's old agent conversation / cwd / shell. This is what stops the "+"
    // button from re-opening an agent that was resumed long ago.
    const legacy = t0 ? undefined : panelProps()
    const savedAgent = t0?.agentSession ?? legacy?.agentSession
    const termCwd = savedAgent?.cwd ?? t0?.cwd ?? legacy?.cwd
    const cwd = termCwd ?? useWorkspaceStore.getState().folderPath ?? undefined
    // One-shot launch command (e.g. `claude` from a voice command). Runs once the shell is ready;
    // skipped when we're resuming a saved agent (that flow drives its own command).
    const boot = t0?.bootCommand ?? legacy?.bootCommand

    void window.plano.terminal
      .create({
        panelId,
        terminalId: termId,
        spaceId: useSpacesStore.getState().activeId ?? '',
        cols: term.cols,
        rows: term.rows,
        cwd,
        autoDetectRoot: !termCwd,
        shell: t0?.shell ?? legacy?.shell ?? resolveShell(ts0),
        predictiveHistory: ts0.predictiveHistory,
        // Launch an agent (voice "open Claude Code") via the shell's startup so it appears instantly.
        // Skipped when resuming a saved agent — that flow drives its own resume command below.
        bootCommand: savedAgent || !boot ? undefined : boot,
      })
      .then((res) => {
        if (disposed) {
          void window.plano.terminal.kill(res.ptyId)
          return
        }
        ptyId = res.ptyId
        useTerminalStore.getState().attach(termId, {
          ptyId: res.ptyId,
          pid: res.pid,
          shellName: res.shellName,
          status: 'ready',
          cwd: res.cwd || undefined,
          panelId,
        })
        wire(res.ptyId)
        // The PTY was created at the pre-fit 80×24 default; now that ptyId exists, publish the real
        // fitted grid (the mount-time fit ran before ptyId was set, so its publishSize was a no-op).
        requestFit()

        // The boot command (agent launch) was injected into the shell's startup by main, so it's
        // already running — just clear the one-shot prop so a reattach / workspace reopen never
        // re-launches it. (Resuming a saved agent is handled separately, below.)
        if (boot) {
          if (t0) persistTerminalTabPatch(panelId, termId, { bootCommand: undefined })
          else usePanelStore.getState().updateProps<'terminal'>(panelId, { bootCommand: undefined })
        }

        // Reopen the agent conversation this terminal last had (gated by the setting). Only on a true
        // fresh spawn — reattach never resumes. Fully guarded (cwd match + on-disk existence) inside.
        if (savedAgent && useSettingsStore.getState().settings.general.restoreAgentSessions) {
          void resumeAgentSession({
            ptyId: res.ptyId,
            panelId,
            termId,
            saved: savedAgent,
            spawnCwd: res.cwd || savedAgent.cwd,
            liveCwd: useTerminalStore.getState().byPanel[termId]?.cwd || undefined,
            whenShellReady,
            isDisposed: () => disposed,
          })
        }
      })
  }

  // Reachable only on a dev HMR reload: the renderer reloaded (this registry is brand-new) but a PTY
  // + its store entry survived in main. Reattach to it and replay main's buffer ONCE so the screen is
  // reconstructed. (Normal space/tab switches never get here — the session persists, so getOrCreate
  // returns it without re-creating, and the live Terminal never lost its content.)
  const reattachPty = (id: string): void => {
    ptyId = id
    wire(id)
    void window.plano.terminal.attach(id).then((res) => {
      if (disposed) return
      if (res?.ok) {
        if (res.buffer) {
          term.write(res.buffer)
          term.scrollToBottom()
        }
        if (res.exited) {
          term.writeln('\r\n\x1b[2m[process exited]\x1b[0m')
          useTerminalStore.getState().setStatus(termId, 'exited')
        } else {
          requestFit() // fit then publishSize nudges a fullscreen TUI to repaint at the live size
        }
      } else {
        // Backing shell gone: show it ended, forget the dead session (store + registry) so a later
        // remount spawns fresh instead of looping on a ghost reattach.
        term.writeln('\r\n\x1b[2m[session ended]\x1b[0m')
        useTerminalStore.getState().setStatus(termId, 'exited')
        useAgentStore.getState().clear(id)
        useTerminalStore.getState().drop(termId)
        removeSelf()
      }
    })
  }

  // Decide the PTY source ONCE, synchronously, at session creation. A store entry that already exists
  // for this termId means a PTY survived a renderer reload (HMR) → reattach; otherwise spawn fresh.
  const existing = useTerminalStore.getState().byPanel[termId]
  if (existing) reattachPty(existing.ptyId)
  else spawnPty()

  // ── attach / detach / dispose ────────────────────────────────────────────────────────────────
  const attach = (nextContainer: HTMLDivElement, nextRenderBox: HTMLDivElement): void => {
    if (disposed) return
    // Re-bind to the freshly mounted DOM. (StrictMode/the same-node case is a harmless no-op re-bind.)
    detachDom()
    renderBox = nextRenderBox
    attached = true

    // Snap to the live zoom so a reattach restores the exact atlas/size the user left.
    currentScale = snapRenderScale(useViewportStore.getState().zoom)
    applyRenderBoxStyle()

    if (!opened) {
      term.open(renderBox)
      opened = true
      // Keep mouse selection / reporting / link-hover aligned with the on-screen scale (= world zoom ÷
      // render-box counter-scale). Patches the mouse service, which exists after open() and persists
      // across re-parenting, so this is applied exactly ONCE.
      applyCanvasZoomMouseFix(term, () => useViewportStore.getState().zoom / effScale)
    } else if (term.element && term.element.parentElement !== renderBox) {
      // Returning from another space / tab: move the existing, still-live element into the new box.
      renderBox.appendChild(term.element)
    }
    applyFontSize()
    // WebGL slots belong to VISIBLE terminals, not to whichever tabs happened to open first. Hidden
    // tabs release their renderer in detachDom(); the newly active tab can now claim the slot instead
    // of silently falling back to the DOM renderer (whose transformed rows can visually overlap).
    loadWebgl()

    // Deska parity (registry.ts attach): self-heal the off-by-one where the DOM scrollbar reaches the
    // bottom but xterm's viewportY lands one row short of baseY, hiding the freshest line. Bound ONCE to
    // the persistent .xterm-viewport (it survives reparents) and torn down on dispose, so re-attaches
    // never stack listeners.
    if (!scrollHealAttached && term.element) {
      const vp = term.element.querySelector('.xterm-viewport') as HTMLElement | null
      if (vp) {
        const onVpScroll = (): void => {
          if (vp.scrollHeight - vp.scrollTop - vp.clientHeight < 2) {
            try {
              term.scrollToBottom()
            } catch {
              /* ignore */
            }
          }
        }
        vp.addEventListener('scroll', onVpScroll, { passive: true })
        unsubs.push(() => vp.removeEventListener('scroll', onVpScroll))
        scrollHealAttached = true
      }
    }

    // Host listeners live on the (per-attach) container. PASTE on the native event is the most
    // reliable path; right-click pastes from the clipboard; both pre-empt xterm's own handlers.
    const onPaste = (e: ClipboardEvent): void => {
      e.preventDefault()
      e.stopImmediatePropagation()
      pasteText(e.clipboardData?.getData('text/plain') ?? '')
    }
    const onContextMenu = (e: MouseEvent): void => {
      e.preventDefault()
      void pasteFromClipboard()
    }
    nextContainer.addEventListener('paste', onPaste, true)
    nextContainer.addEventListener('contextmenu', onContextMenu)

    // ResizeObserver on the exact box FitAddon measures. This is the verified smooth-setup
    // behavior: it stays dormant at rest and coalesces a resize burst into one fit. The removed
    // watchdog forced clientWidth/offsetWidth layout reads for every visible terminal on every
    // animation frame, so its idle cost grew linearly with terminal count.
    let fitTimer: ReturnType<typeof setTimeout> | null = null
    let observerRaf = 0
    let lastFitW = 0
    let lastFitH = 0
    const runObservedFit = (): void => {
      if (disposed || !attached || renderBox !== nextRenderBox) return
      const w = renderBox.clientWidth
      const h = renderBox.clientHeight
      if (w === 0 || h === 0) return
      if (
        Math.abs(w - lastFitW) < FIT_RESIZE_EPSILON &&
        Math.abs(h - lastFitH) < FIT_RESIZE_EPSILON
      ) return
      lastFitW = w
      lastFitH = h
      try {
        // Deska parity: a resize that doesn't change the grid (or one made while the user has scrolled
        // up) must NOT yank the viewport to the bottom — re-pin only when we were at the bottom AND the
        // grid actually changed.
        const vp = term.element?.querySelector('.xterm-viewport') as HTMLElement | null
        const wasAtBottom = vp ? Math.abs(vp.scrollTop - (vp.scrollHeight - vp.clientHeight)) < 5 : true
        const prevCols = term.cols
        const prevRows = term.rows
        safeFit(false)
        publishSize()
        if (term.cols !== prevCols || term.rows !== prevRows) {
          if (wasAtBottom) term.scrollToBottom()
          // The reflow that just ran rewrote the buffer under whatever the TUI had drawn. Repaint
          // every row from OUR side too: the CLI redraws on SIGWINCH at its own pace, and until it
          // does, the rows xterm reflowed are the only thing on screen. Without this the stale
          // fragments stay visible for as long as the app takes to notice the resize.
          term.refresh(0, term.rows - 1)
        }
      } catch {
        /* fit can throw on zero-size frames during transitions */
      }
    }
    const scheduleObservedFit = (): void => {
      if (disposed || !attached || renderBox !== nextRenderBox) return
      const w = renderBox.clientWidth
      const h = renderBox.clientHeight
      if (
        Math.abs(w - lastFitW) < FIT_RESIZE_EPSILON &&
        Math.abs(h - lastFitH) < FIT_RESIZE_EPSILON
      ) return
      if (fitTimer !== null) clearTimeout(fitTimer)
      if (observerRaf) cancelAnimationFrame(observerRaf)
      fitTimer = setTimeout(() => {
        fitTimer = null
        observerRaf = requestAnimationFrame(() => {
          observerRaf = 0
          runObservedFit()
        })
      }, FIT_DEBOUNCE_MS)
    }
    resizeObs = new ResizeObserver(scheduleObservedFit)
    resizeObs.observe(nextRenderBox)

    hostCleanup = () => {
      nextContainer.removeEventListener('paste', onPaste, true)
      nextContainer.removeEventListener('contextmenu', onContextMenu)
      if (fitTimer !== null) clearTimeout(fitTimer)
      if (observerRaf) cancelAnimationFrame(observerRaf)
    }

    requestFit()
    term.focus()
  }

  // Tear down ONLY the per-attach DOM bindings; the Terminal, PTY and all subscriptions stay alive.
  const detachDom = (): void => {
    attached = false
    if (resizeObs) {
      resizeObs.disconnect()
      resizeObs = null
    }
    if (fitRaf) {
      cancelAnimationFrame(fitRaf)
      fitRaf = 0
    }
    if (scaleRaf) {
      cancelAnimationFrame(scaleRaf)
      scaleRaf = 0
    }
    hostCleanup?.()
    hostCleanup = null
    // Keep the small WebGL budget as a working-set budget. Without this, an inactive tab retained its
    // slot forever and later visible tabs (often the agent named Hermes) alone used the DOM fallback.
    unloadWebgl()
    renderBox = null
  }

  // ── Deska-parity keyboard focus ─────────────────────────────────────────────────────────────────
  // Runs are per-session and supersede each other: `focus()` cancels the previous run and bumps the
  // run id so stale callbacks become no-ops. The wait loop tolerates a DOM that is temporarily
  // detached during tab/workspace attachment; after the first success a short recheck window keeps
  // re-asserting focus so a detach/reattach race cannot drop it. Every timer is tracked and cleared
  // by `cancelFocus` (unmount / focus moved elsewhere) and by `dispose`.
  const FOCUS_WAIT_ATTEMPTS = 80 // 80 × 25 ms = 2 s — Deska parity: DOM may lag a tab/workspace attach
  const FOCUS_RECHECK_ATTEMPTS = 20 // 20 × 25 ms = 0.5 s post-success detach/reattach race window
  const FOCUS_INTERVAL_MS = 25
  let focusRunId = 0
  let focusTimers: number[] = [] // window.setTimeout ids (DOM lib)
  const cancelFocusRun = (): void => {
    focusTimers.forEach((t) => window.clearTimeout(t))
    focusTimers = []
  }

  const focus = (): void => {
    if (disposed) return
    cancelFocusRun()
    const runId = ++focusRunId
    const isCurrent = (): boolean => runId === focusRunId && !disposed

    // ONE focus attempt. Returns true only when the xterm helper textarea (or, as a fallback, the
    // xterm element itself) actually received DOM focus. Scroll is captured BEFORE focusing and
    // restored immediately AND on the next animation frame — focus({ preventScroll }) alone does not
    // fully protect against xterm's own focus-time scroll anchoring.
    const applyFocus = (): boolean => {
      if (disposed || !attached || !term.element || !term.element.isConnected) return false
      const vp = term.element.querySelector('.xterm-viewport') as HTMLElement | null
      const savedScrollTop = vp ? vp.scrollTop : null
      let ok = false
      try {
        const textarea = term.element.querySelector('.xterm-helper-textarea') as HTMLElement | null
        if (textarea) {
          textarea.focus({ preventScroll: true })
          ok = document.activeElement === textarea
        }
        if (!ok) {
          term.focus()
          ok = textarea
            ? document.activeElement === textarea || document.activeElement === term.element
            : document.activeElement === term.element
        }
      } catch {
        ok = false // focus() can throw while the element is mid-detach
      }
      if (savedScrollTop !== null && vp && vp.isConnected) {
        vp.scrollTop = savedScrollTop
        requestAnimationFrame(() => {
          if (runId === focusRunId && !disposed && vp.isConnected) vp.scrollTop = savedScrollTop
        })
      }
      return ok
    }

    // Post-success window: keep re-asserting focus in case the DOM detaches and reattaches again
    // (tab switch / workspace reattach race). Bounded, then the run ends with no timers left behind.
    const startRecheck = (): void => {
      let rechecks = 0
      const tick = (): void => {
        if (!isCurrent()) return
        if (rechecks++ >= FOCUS_RECHECK_ATTEMPTS) {
          focusTimers = []
          return
        }
        const t = window.setTimeout(() => {
          if (!isCurrent()) return
          applyFocus()
          tick()
        }, FOCUS_INTERVAL_MS)
        focusTimers.push(t)
      }
      tick()
    }

    // First attempt immediately; if the DOM isn't connected yet, retry on a bounded 25 ms cadence.
    if (applyFocus()) {
      startRecheck()
      return
    }
    let attempts = 0
    const waitTick = (): void => {
      if (!isCurrent()) return
      if (attempts++ >= FOCUS_WAIT_ATTEMPTS) {
        focusTimers = []
        return
      }
      const t = window.setTimeout(() => {
        if (!isCurrent()) return
        if (applyFocus()) {
          startRecheck()
          return
        }
        waitTick()
      }, FOCUS_INTERVAL_MS)
      focusTimers.push(t)
    }
    waitTick()
  }

  const cancelFocus = (): void => {
    focusRunId++ // invalidate any in-flight run
    cancelFocusRun()
  }

  const dispose = (): void => {
    if (disposed) return
    disposed = true
    cancelFocus()
    detachDom()
    unsubs.forEach((u) => u())
    unsubs.length = 0
    useTerminalControlStore.getState().unregister(termId)
    // Dispose WebGL BEFORE the terminal so its GL context is freed promptly (Deska) — GL contexts are
    // otherwise reclaimed only on GC.
    unloadWebgl()
    term.dispose()
  }

  return { termId, panelId, attach, detach: detachDom, dispose, focus, cancelFocus }
}

/**
 * The renderer-side terminal registry. Owns every live `TerminalSession`, keyed by terminal (tab) id,
 * independently of React. `useXterm` is a thin seam that `getOrCreate`s a session on mount and
 * `detach`es it on unmount; the teardown helpers call `dispose` when a terminal is truly closed.
 */
class TerminalEngine {
  private sessions = new Map<string, TerminalSession>()

  has(termId: string): boolean {
    return this.sessions.has(termId)
  }
  /** Snapshot used by the workspace safety budget; never expose the mutable registry itself. */
  liveSessions(): Array<{ termId: string; panelId: string }> {
    return [...this.sessions.values()].map(({ termId, panelId }) => ({ termId, panelId }))
  }


  /** Idempotent: returns the existing session (so a remount/StrictMode double-invoke never respawns)
   *  or creates one (which decides spawn-vs-reattach exactly once). */
  getOrCreate(termId: string, panelId: string): TerminalSession {
    const existing = this.sessions.get(termId)
    if (existing) return existing
    // removeSelf (fired async from a dead-shell reattach) fully disposes the orphaned session, not
    // just its map entry, so its xterm instance + subscriptions don't leak.
    const session = createSession(termId, panelId, () => this.dispose(termId))
    this.sessions.set(termId, session)
    return session
  }

  attach(termId: string, container: HTMLDivElement, renderBox: HTMLDivElement): void {
    this.sessions.get(termId)?.attach(container, renderBox)
  }

  detach(termId: string): void {
    this.sessions.get(termId)?.detach()
  }

  /** Deska-parity keyboard focus for the terminal (tab) whose DOM is mounted. Keyed by terminal TAB
   *  id; never exposes the mutable registry and never resizes/reattaches/recreates the Terminal or
   *  touches PTY state. A new call supersedes any in-flight focus run for the same terminal. */
  focus(termId: string): void {
    this.sessions.get(termId)?.focus()
  }

  /** Cancel any in-flight focus run for a terminal (focus moved elsewhere / component unmount). */
  cancelFocus(termId: string): void {
    this.sessions.get(termId)?.cancelFocus()
  }

  /** Destroy a session's renderer-side Terminal and forget it. The PTY is killed separately by the
   *  teardown helpers (the single PTY choke point), so this never double-kills. */
  dispose(termId: string): void {
    const session = this.sessions.get(termId)
    if (!session) return
    session.dispose()
    this.sessions.delete(termId)
  }

  /** Destroy every session belonging to a panel — a safety net for closing a panel whose tab was
   *  still mid-spawn (no store entry yet for the per-tab teardown to find). */
  disposePanel(panelId: string): void {
    for (const [id, session] of this.sessions) {
      if (session.panelId === panelId) {
        session.dispose()
        this.sessions.delete(id)
      }
    }
  }
}

export const terminalEngine = new TerminalEngine()
