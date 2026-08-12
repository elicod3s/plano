/** Agent detail — the LIVE terminal of the agent (same view as the PC), with interrupt/kill.
 *  Typing happens DIRECTLY in the terminal — no separate text box needed. */
import { apiStore, go, liveStore, statusStore } from '../App'
import { agentRow } from '../lib/agents'
import { LiveTerminal } from '../components/LiveTerminal'
import { TerminalToolbar } from '../components/TerminalToolbar'
import { BackButton } from '../components/BackButton'

export function AgentDetailScreen({ ptyId }: { ptyId: string }) {
  const status = statusStore.use()
  const session = status?.sessions.find((s) => s.ptyId === ptyId)
  const row = agentRow(session?.agentKind ?? null)

  const interrupt = (): void => {
    void apiStore.get()?.interrupt(ptyId).catch(() => undefined)
  }
  const kill = (): void => {
    void apiStore.get()?.kill(ptyId).then(() => go({ name: 'home' })).catch(() => undefined)
  }

  return (
    <>
      <header className="topbar">
        <BackButton onClick={() => go({ name: 'home' })} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <div
            className="agent-badge"
            style={{ width: 28, height: 28, fontSize: 13, color: row.accent, border: `1px solid ${row.accent}44` }}
          >
            {row.mark}
          </div>
          <h1 style={{ fontSize: 15, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {session?.title || row.label}
          </h1>
          {session?.phase && <span className={`chip ${session.phase}`}>{session.phase}</span>}
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button className="btn ghost" style={{ padding: '8px 10px' }} onClick={interrupt} title="Interrupt (Ctrl-C)">
            ■
          </button>
          <button className="btn danger" style={{ padding: '8px 10px' }} onClick={kill} title="Kill terminal">
            ✕
          </button>
        </div>
      </header>

      <div style={{ flex: 1, minHeight: 0, padding: '6px 14px 0', display: 'flex', flexDirection: 'column' }}>
        {/* The REAL terminal — identical to what the PC shows; tap it to type */}
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <LiveTerminal ptyId={ptyId} />
        </div>
        <TerminalToolbar ptyId={ptyId} />
      </div>
    </>
  )
}
