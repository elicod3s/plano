/** LiveTerminal — a real xterm.js view of a daemon session, with an imperative API for the
 *  toolbar (scroll + arrow keys), since mobile browsers have no arrow keys and xterm's touch
 *  scrolling is unreliable.
 *
 *  Scroll model: the viewport FOLLOWS the live tail by default (you're watching the agent work) —
 *  xterm advances its viewport naturally as the buffer grows, no forced scrolling (a forced
 *  scrollToBottom on every 16ms data batch races xterm's write/render queue and visibly yanks /
 *  garbles the screen). Scrolling up (finger or the toolbar buttons) pauses following so you can
 *  read; the floating "↓ Latest" pill appears, and tapping it (or the toolbar Latest button)
 *  snaps back to the live tail. */
import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { apiStore, liveStore, statusStore } from '../App'

/** Imperative scroll control the toolbar calls (the phone has no keyboard, so paging through the
 *  history has to be first-class buttons, not a gesture). */
export interface TermController {
  scrollTop(): void
  pageUp(): void
  pageDown(): void
  scrollBottom(): void
}

/** The currently mounted terminal's controller. Only one LiveTerminal is mounted at a time
 *  (single-route app), so a module-level handle is safe and avoids prop drilling. */
export const termCtl: { current: TermController | null } = { current: null }

/** Only push a size to the PTY after the viewport settles AND the size actually changed — mobile
 *  URL-bar toggles fire ResizeObserver bursts, and every PTY resize makes the agent redraw (the
 *  "screen jumping while you read" effect). */
const RESIZE_DEBOUNCE_MS = 300

export function LiveTerminal({ ptyId }: { ptyId: string }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const followRef = useRef(true)
  const lastSizeRef = useRef<{ cols: number; rows: number } | null>(null)
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [atBottom, setAtBottom] = useState(true)

  useEffect(() => {
    const api = apiStore.get()
    const live = liveStore.get()
    if (!api || !live || !hostRef.current) return

    const term = new Terminal({
      fontFamily: '"JetBrains Mono", "Cascadia Code", ui-monospace, monospace',
      fontSize: 12,
      lineHeight: 1.35,
      cursorBlink: true,
      theme: { background: '#0d0d0c', foreground: '#d8d3ca' },
      scrollback: 3000,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(hostRef.current)
    termRef.current = term

    const isAtBottom = (): boolean => term.buffer.active.viewportY >= term.buffer.active.baseY

    const syncFollow = (): void => {
      const ab = isAtBottom()
      followRef.current = ab
      // setState only on change — this fires on every scroll, and React must not re-render per
      // data chunk when the state is stable.
      setAtBottom((prev) => (prev === ab ? prev : ab))
    }

    // Every viewport movement (user scroll, buffer growth, programmatic scroll) re-syncs follow.
    const scrollDisposable = term.onScroll(syncFollow)

    const scrollBottom = (): void => {
      followRef.current = true
      term.scrollToBottom()
      syncFollow()
    }
    const scrollTop = (): void => {
      term.scrollToTop()
      syncFollow()
    }
    const page = (dir: 1 | -1): void => {
      term.scrollLines(dir * Math.max(1, term.rows - 1))
      syncFollow()
    }

    termCtl.current = {
      scrollTop,
      pageUp: () => page(-1),
      pageDown: () => page(1),
      scrollBottom,
    }

    // Resize the LOCAL view immediately, but push the size to the PTY debounced + deduped.
    const resize = (): void => {
      try {
        fit.fit()
        // A PTY can only have ONE size. If another viewer (the PC) is attached, DON'T fight it:
        // resizing to the phone's small viewport would shrink the PC's terminal (and the resize
        // redraws would scramble this view). The phone becomes a passive mirror; the PC rules.
        const st = statusStore.get()?.sessions.find((s) => s.ptyId === ptyId)
        if (!st || st.viewers <= 1) {
          const size = { cols: term.cols, rows: term.rows }
          const last = lastSizeRef.current
          if (!last || last.cols !== size.cols || last.rows !== size.rows) {
            lastSizeRef.current = size
            if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current)
            resizeTimerRef.current = setTimeout(() => {
              resizeTimerRef.current = null
              live.resize(ptyId, size.cols, size.rows)
            }, RESIZE_DEBOUNCE_MS)
          }
        }
      } catch {
        /* container may be 0-sized */
      }
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(hostRef.current)

    let stopped = false
    // Buffer replay: scroll INSIDE the write callback, after xterm has fully parsed the history —
    // scrollToBottom() right after write() acts on stale buffer state while the write is still
    // queued, which leaves the viewport stranded at the top of a long replay (the original
    // "jumps to the top while the agent's new work piles up below" bug).
    void api
      .buffer(ptyId)
      .then((r) => {
        if (!stopped && r.buffer) {
          term.write(r.buffer, () => {
            if (stopped) return
            term.scrollToBottom()
            syncFollow()
          })
        }
      })
      .catch(() => undefined)

    live.attach(ptyId)
    const unsub = live.on((e) => {
      if (e.ptyId !== ptyId) return
      if (e.event === 'data' && e.data) {
        // Natural follow: xterm advances the viewport itself while parsing when it's at the
        // bottom. NO forced scrollToBottom here — with the daemon pushing 16ms batches, forcing
        // it per chunk fights the render loop and makes the screen yank/garbled.
        term.write(e.data)
      }
      if (e.event === 'exit') term.writeln('\r\n\x1b[2m[process exited]\x1b[0m')
    })

    // No auto-focus on mount: on mobile that can pop the keyboard / scroll the page. Tapping the
    // terminal focuses it (and opens the keyboard) only when the user actually wants to type.
    const onData = (d: string): void => live.write(ptyId, d)
    const disposable = term.onData(onData)

    return () => {
      stopped = true
      disposable.dispose()
      scrollDisposable.dispose()
      unsub()
      live.detach(ptyId)
      ro.disconnect()
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current)
      resizeTimerRef.current = null
      if (termCtl.current) termCtl.current = null
      term.dispose()
      termRef.current = null
    }
  }, [ptyId])

  return (
    <div className="term-shell">
      <div ref={hostRef} style={{ height: '100%', width: '100%' }} />
      {!atBottom && (
        <button
          className="term-follow-pill"
          onClick={() => termCtl.current?.scrollBottom()}
          title="Jump to the latest output and follow it"
        >
          ↓ Latest
        </button>
      )}
    </div>
  )
}
