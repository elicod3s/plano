/** Terminal screen — a real xterm.js view of a daemon session (shared LiveTerminal). */
import { go, statusStore } from '../App'
import { LiveTerminal } from '../components/LiveTerminal'
import { TerminalToolbar } from '../components/TerminalToolbar'
import { BackButton } from '../components/BackButton'

export function TerminalScreen({ ptyId }: { ptyId: string }) {
  return (
    <>
      <header className="topbar">
        <BackButton onClick={() => go({ name: 'home' })} />
        <h1 style={{ fontSize: 15 }}>{statusStore.get()?.sessions.find((s) => s.ptyId === ptyId)?.title || 'Terminal'}</h1>
        <div style={{ width: 36 }} />
      </header>
      <div style={{ flex: 1, minHeight: 0, padding: '6px 14px 0', display: 'flex', flexDirection: 'column' }}>
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <LiveTerminal ptyId={ptyId} />
        </div>
        <TerminalToolbar ptyId={ptyId} />
      </div>
    </>
  )
}
