import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import '@xterm/xterm/css/xterm.css'
import type { TerminalProps } from '@shared/domain/panel'
import type { TerminalSettings } from '@shared/domain/settings'
import type { AgentKind, AgentVerdict } from '@shared/domain/agent'
import { resumeAgentSession } from '../agentResume'
import { useTerminalStore } from '@/stores/useTerminalStore'
import { useTerminalControlStore } from '@/stores/useTerminalControlStore'
import { usePanelStore } from '@/stores/usePanelStore'
import { useViewportStore } from '@/stores/useViewportStore'
import { useAgentStore } from '@/stores/useAgentStore'
import { useWorkspaceStore } from '@/stores/useWorkspaceStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { TERMINAL_FONT } from '../xtermTheme'
import { getTerminalTheme } from '../terminalThemes'
import { applyCanvasZoomMouseFix } from '../canvasZoomMouse'
import {
  FIT_DEBOUNCE_MS,
  FIT_RESIZE_EPSILON,
  FIT_RETRY_FRAMES,
  clampFontSize,
  effectiveFontSize,
  parseOsc7Cwd,
  resolveShell,
  snapRenderScale,
} from './render'

/**
 * A live terminal session that OUTLIVES React. The xterm `Terminal` instance, its addons, the PTY
 * stream wiring, the agent-detection signals and the per-terminal options/zoom subscriptions all
 * live here for the whole life of the terminal — not the life of a React mount. React only `attach`es
 * the DOM (re-parenting the existing `term.element` into a freshly-mounted render box) and `detach`es
 * it on unmount. The PTY keeps streaming into the (possibly off-screen) `Terminal` the entire time,
 * so returning to a space / switching back to a tab is a pure DOM re-parent — NO buffered replay, no
 * flicker, no scroll jump. The session is destroyed only by `dispose` (an explicit teardown).
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
  const tab = () => panelProps()?.tabs?.find((t) => t.id === termId)
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

  // Rasterize at fontSize = ROUND(base × renderScale) (integer → no fractional cell → no grid drift
  // / re-raster flicker), then derive the box counter-scale from that rounded font (effScale =
  // roundedFont / base) so box + cell stay proportional and the grid fills the container with no clip.
  const scaledFontFor = (scale: number): number => Math.max(1, Math.round(baseFontSize() * scale))
  const effScaleFor = (scale: number): number => scaledFontFor(scale) / baseFontSize()

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
    // Clamp ≥ 1.0: custom-glyph block-art is clipped to the cell, so lineHeight > 1 reopens a strip
    // below each row that tears box-drawing apart (xterm #2572); < 1 crushes the rows.
    lineHeight: Math.max(1, ts0.lineHeight),
    letterSpacing: 0, // non-zero corrupts selection geometry (xterm #4881)
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
    // (which carry their own intra-cell metrics) instead of as vectors clipped to the cell. Clipped
    // vectors tear when lineHeight > 1 reopens a sub-cell gap (xterm #2572); font glyphs just gain
    // leading. This is what lets Deska run lineHeight 1.4 with intact art — so we match it.
    customGlyphs: false,
    rescaleOverlappingGlyphs: true, // wide/CJK/Powerline glyphs don't bleed into neighbors
    smoothScrollDuration: 0, // smooth scroll fights the zoom scroll-anchor — keep 0
    allowTransparency: false, // opaque bg lets WebGL skip per-cell alpha blending
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  term.loadAddon(new WebLinksAddon((_e, uri) => window.open(uri, '_blank')))
  const unicode = new Unicode11Addon()
  term.loadAddon(unicode)
  term.unicode.activeVersion = '11'

  // Renderer: the WEBGL addon (Deska). DOM renderer's spans round to fractional positions under our
  // nested transforms and overlap; the 2D-canvas addon accumulates draws and ghosts. WebGL clears its
  // framebuffer every frame and rebuilds the glyph atlas crisp on cell-size change. Context loss gets
  // a ONE-SHOT guarded reload (no console-flood loop); a second loss falls back to xterm's DOM
  // renderer. Loaded lazily on first open() — the renderer needs the element to exist.
  let webglAddon: WebglAddon | null = null
  let webglReloadAttempted = false
  const loadWebgl = (): void => {
    if (webglAddon) {
      try {
        webglAddon.dispose()
      } catch {
        /* ignore */
      }
      webglAddon = null
    }
    try {
      const addon = new WebglAddon()
      addon.onContextLoss(() => {
        try {
          addon.dispose()
        } catch {
          /* ignore */
        }
        webglAddon = null
        if (webglReloadAttempted) return // give up → DOM fallback, never loop (no console flood)
        webglReloadAttempted = true
        loadWebgl()
      })
      term.loadAddon(addon)
      webglAddon = addon
    } catch {
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

    // FitAddon computes the maximum grid that reaches the viewport edge. Keep one full cell free
    // before the scrollbar: this absorbs Chromium's fractional-pixel rounding and guarantees that
    // no rightmost glyph can be painted into the clipping/gutter strip.
    let cols = Math.max(2, Math.floor(proposed.cols) - 1)
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
  const clearAgentSessionProp = (): void => {
    if (tab()?.agentSession)
      usePanelStore.getState().updateTerminalTab(panelId, termId, { agentSession: undefined })
  }
  const captureAgentSession = (id: string, verdict: AgentVerdict): void => {
    if (!verdict.active || !verdict.kind) {
      lastCaptureKind = null
      clearAgentSessionProp()
      return
    }
    const kindChanged = verdict.kind !== lastCaptureKind
    lastCaptureKind = verdict.kind
    if (!kindChanged && verdict.phase !== 'idle') return
    const liveCwd = useTerminalStore.getState().byPanel[termId]?.cwd ?? ''
    void window.plano.agent
      .resolveSession(id, liveCwd)
      .then((ref) => {
        if (disposed || !ref) return
        const cur = tab()?.agentSession
        if (cur && cur.agent === ref.agent && cur.sessionId === ref.sessionId && cur.cwd === ref.cwd)
          return
        usePanelStore.getState().updateTerminalTab(panelId, termId, { agentSession: ref })
      })
      .catch(() => {})
  }

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
  unsubs.push(usePanelStore.subscribe(applyTerminalOptions))

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
    requestFit()
  }
  if (typeof document !== 'undefined' && document.fonts) {
    const px = ts0.fontSize > 0 ? ts0.fontSize : 13
    void document.fonts.load(`${px}px "JetBrains Mono"`).then(remeasureAndFit).catch(() => {})
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
    if (next !== current) usePanelStore.getState().updateTerminalTab(panelId, termId, { fontSize: next })
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
        captureAgentSession(id, e.verdict)
      }),
    )

    // Best-effort capture of the FIRST real prompt sent to a detected agent (no AI). Buffer printable
    // keystrokes while the agent is active; finalize on Enter; skip noise (slash-commands, menu nav).
    let promptBuf = ''
    let promptCaptured = false
    const looksLikePrompt = (text: string): boolean =>
      text.length >= 3 && !text.startsWith('/') && /[\p{L}\p{N}]/u.test(text)
    const capturePrompt = (data: string): void => {
      if (!useAgentStore.getState().byPty[id]?.active) {
        promptBuf = ''
        promptCaptured = false
        return
      }
      if (promptCaptured) return
      for (const ch of data) {
        if (ch === '\r' || ch === '\n') {
          const text = promptBuf.replace(/\s+/g, ' ').trim()
          promptBuf = ''
          if (looksLikePrompt(text)) {
            promptCaptured = true
            useAgentStore.getState().setPrompt(id, text.slice(0, 120))
            break
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

    term.onData((data) => {
      capturePrompt(data)
      window.plano.terminal.write(id, data)
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
        cols: term.cols,
        rows: term.rows,
        cwd,
        autoDetectRoot: !termCwd,
        shell: t0?.shell ?? legacy?.shell ?? resolveShell(ts0),
        predictiveHistory: ts0.predictiveHistory,
        // Launch an agent (voice "open Claude Code") via the shell's startup so it appears instantly.
        // Skipped when resuming a saved agent — that flow drives its own resume command below.
        bootCommand: savedAgent ? undefined : boot,
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
          if (t0) usePanelStore.getState().updateTerminalTab(panelId, termId, { bootCommand: undefined })
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
      loadWebgl()
      // Keep mouse selection / reporting / link-hover aligned with the on-screen scale (= world zoom ÷
      // render-box counter-scale). Patches the mouse service, which exists after open() and persists
      // across re-parenting, so this is applied exactly ONCE.
      applyCanvasZoomMouseFix(term, () => useViewportStore.getState().zoom / effScale)
    } else if (term.element && term.element.parentElement !== renderBox) {
      // Returning from another space / tab: move the existing, still-live element into the new box.
      renderBox.appendChild(term.element)
    }
    applyFontSize()

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

    // ResizeObserver on the RENDER BOX (Deska parity). The render box is the exact element xterm is
    // opened into and the one FitAddon measures, so observing it makes a fit run on EVERY layout change
    // that matters: a real panel resize (container changes → the box's %-width resolves to new px) AND a
    // render-scale step (applyScale changes the box's %-width). Crucially the fit then runs AFTER the box
    // has actually laid out at its new size — which is what fixes the zoom clip/underfill (the old
    // container-observer never fired on a render-scale change, and applyScale's own fit raced the box's
    // reflow). A pure pan/zoom is a CSS transform that does NOT change the box's layout size, so the
    // observer stays quiet during gestures. Epsilon + ~32ms debounce coalesce a drag/pinch into one fit.
    let fitTimer: ReturnType<typeof setTimeout> | null = null
    let observerRaf = 0
    let lastFitW = 0
    let lastFitH = 0
    const runObservedFit = (): void => {
      if (!renderBox) return
      const w = renderBox.clientWidth
      const h = renderBox.clientHeight
      if (w === 0 || h === 0) return
      if (Math.abs(w - lastFitW) < FIT_RESIZE_EPSILON && Math.abs(h - lastFitH) < FIT_RESIZE_EPSILON)
        return
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
        if (wasAtBottom && (term.cols !== prevCols || term.rows !== prevRows)) term.scrollToBottom()
      } catch {
        /* fit can throw on zero-size frames during transitions */
      }
    }
    const scheduleObservedFit = (): void => {
      if (!renderBox) return
      const w = renderBox.clientWidth
      const h = renderBox.clientHeight
      if (Math.abs(w - lastFitW) < FIT_RESIZE_EPSILON && Math.abs(h - lastFitH) < FIT_RESIZE_EPSILON)
        return
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
    renderBox = null
  }

  const dispose = (): void => {
    if (disposed) return
    disposed = true
    detachDom()
    unsubs.forEach((u) => u())
    unsubs.length = 0
    useTerminalControlStore.getState().unregister(termId)
    // Dispose WebGL BEFORE the terminal so its GL context is freed promptly (Deska) — GL contexts are
    // otherwise reclaimed only on GC.
    if (webglAddon) {
      try {
        webglAddon.dispose()
      } catch {
        /* ignore */
      }
      webglAddon = null
    }
    term.dispose()
  }

  return { termId, panelId, attach, detach: detachDom, dispose }
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
