/** TerminalToolbar — scroll controls (Top / PgUp / PgDn / Latest) + the four arrow keys the phone
 *  keyboard lacks. Arrows send ANSI sequences to the SHELL without touching terminal focus (no
 *  keyboard open/close side effects); scroll buttons drive the terminal VIEWPORT (xterm's touch
 *  scrolling is unreliable, so paging the history must be explicit). */
import { liveStore } from '../App'
import { termCtl } from './LiveTerminal'

export function TerminalToolbar({ ptyId }: { ptyId: string }) {
  const key = (seq: string): void => {
    liveStore.get()?.write(ptyId, seq)
  }

  return (
    <div className="term-toolbar">
      <div className="term-scroll-row">
        <button className="tt-btn slim" title="Jump to the top of the history" onClick={() => termCtl.current?.scrollTop()}>
          Top
        </button>
        <button className="tt-btn slim" title="Scroll up one page" onClick={() => termCtl.current?.pageUp()}>
          PgUp
        </button>
        <button className="tt-btn slim" title="Scroll down one page" onClick={() => termCtl.current?.pageDown()}>
          PgDn
        </button>
        <button
          className="tt-btn slim accent"
          title="Jump to the latest output and follow it"
          onClick={() => termCtl.current?.scrollBottom()}
        >
          Latest
        </button>
      </div>
      <div className="term-keys-row">
        <button className="tt-btn" title="Left" onClick={() => key('\x1b[D')}>
          ←
        </button>
        <button className="tt-btn" title="Up" onClick={() => key('\x1b[A')}>
          ↑
        </button>
        <button className="tt-btn" title="Down" onClick={() => key('\x1b[B')}>
          ↓
        </button>
        <button className="tt-btn" title="Right" onClick={() => key('\x1b[C')}>
          →
        </button>
        <span className="tt-sep" />
        <button className="tt-btn" title="Esc" onClick={() => key('\x1b')}>
          Esc
        </button>
      </div>
    </div>
  )
}
