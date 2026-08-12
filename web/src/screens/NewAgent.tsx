/** New agent — pick a workspace + an AI CLI, then launch it on the PC from your phone. */
import { useMemo, useState } from 'react'
import { apiStore, go, statusStore } from '../App'
import { AGENTS } from '../lib/agents'
import { BackButton } from '../components/BackButton'

export function NewAgentScreen({ workspaceId }: { workspaceId?: string }) {
  const status = statusStore.use()
  const workspaces = status?.workspaces ?? []
  const [wsId, setWsId] = useState(workspaceId ?? workspaces[0]?.id ?? '')
  const [agentId, setAgentId] = useState<string | null>(null)
  const [plain, setPlain] = useState(true)
  const [autoApprove, setAutoApprove] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const ws = useMemo(() => workspaces.find((w) => w.id === wsId), [workspaces, wsId])
  const agent = AGENTS.find((a) => a.id === agentId) ?? null

  const launch = (): void => {
    const api = apiStore.get()
    if (!api) return
    setBusy(true)
    setError(null)
    const boot = agent ? agent.autoApprove(agent.command) : undefined
    void api
      .createSession({
        folderPath: ws?.folderPath ?? null,
        name: name.trim() || (agent ? agent.label : 'Terminal'),
        bootCommand: boot,
        autoApprove,
        cols: 100,
        rows: 30,
      })
      .then((r) => {
        if (r.session?.ptyId) go({ name: 'terminal', ptyId: r.session.ptyId })
        else setError('Could not launch')
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false))
  }

  return (
    <>
      <header className="topbar">
        <BackButton onClick={() => go({ name: 'home' })} />
        <h1 style={{ fontSize: 16 }}>New agent</h1>
        <div style={{ width: 36 }} />
      </header>

      <div className="scroll">
        <div className="section-label">Workspace</div>
        {workspaces.map((w) => (
          <div
            key={w.id}
            className="ws-card"
            style={{ borderColor: w.id === wsId ? 'var(--text-muted)' : undefined, marginBottom: 6, padding: 11 }}
            onClick={() => setWsId(w.id)}
          >
            <div className="ws-name">{w.name}</div>
            <div className="ws-folder">{w.folderPath ?? 'No folder'}</div>
          </div>
        ))}
        {!ws && <div className="empty">No workspaces on the PC yet — open one there first.</div>}

        <div className="section-label">Agent</div>
        <div
          className="agent-row sheet-tap"
          style={{ borderColor: plain ? 'var(--text-muted)' : undefined }}
          onClick={() => {
            setPlain(true)
            setAgentId(null)
          }}
        >
          <div className="agent-badge" style={{ color: '#9a9387', border: '1px solid var(--border-strong)' }}>{'>'}</div>
          <div className="mid">
            <div className="name">Plain terminal</div>
            <div className="sub">Just a shell — no agent</div>
          </div>
          {plain && <span style={{ color: 'var(--text-muted)' }}>✓</span>}
        </div>
        {AGENTS.map((a) => (
          <div
            key={a.id}
            className="agent-row sheet-tap"
            style={{ borderColor: a.id === agentId ? a.accent : undefined }}
            onClick={() => {
              setPlain(false)
              setAgentId(a.id)
            }}
          >
            <div className="agent-badge" style={{ color: a.accent, border: `1px solid ${a.accent}44` }}>
              {a.mark}
            </div>
            <div className="mid">
              <div className="name">{a.label}</div>
              <div className="sub">{a.command}</div>
            </div>
            {a.id === agentId && <span style={{ color: a.accent }}>✓</span>}
          </div>
        ))}

        <div className="section-label">Options</div>
        <div className="sheet" style={{ marginBottom: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 600 }}>Auto-approve</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Let it act without asking</div>
            </div>
            <Toggle checked={autoApprove} onChange={setAutoApprove} />
          </div>
          <input
            className="input"
            placeholder="Name (optional)"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        {error && <div className="error-text">{error}</div>}

        <button className="btn primary block" disabled={busy || !ws} onClick={launch}>
          {busy ? <span className="spinner" /> : agent ? `Launch ${agent.label} on ${ws?.name ?? '…'}` : `Open terminal in ${ws?.name ?? '…'}`}
        </button>
        <div className="hint" style={{ marginTop: 10 }}>
          It opens as a terminal panel on your PC canvas — you can watch it here too.
        </div>
      </div>
    </>
  )
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      style={{
        width: 46,
        height: 26,
        borderRadius: 999,
        border: '1px solid var(--border-strong)',
        background: checked ? 'var(--accent)' : 'var(--raised-2)',
        position: 'relative',
        transition: 'background .15s',
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 2,
          left: checked ? 22 : 2,
          width: 20,
          height: 20,
          borderRadius: '50%',
          background: checked ? '#1a1a1a' : 'var(--text-muted)',
          transition: 'left .15s',
        }}
      />
    </button>
  )
}
