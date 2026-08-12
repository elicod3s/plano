/** Home — live agent/terminal/workspace overview with a bottom tab bar. */
import { useEffect, useMemo, useState } from 'react'
import { apiStore, go, liveStore, statusStore, upStore } from '../App'
import type { Session, Workspace } from '../lib/types'
import { agentRow } from '../lib/agents'
import { BrandMark } from '../components/BrandMark'

type Tab = 'agents' | 'terminals' | 'workspaces'

export function HomeScreen({ onDisconnect, up }: { onDisconnect: () => void; up: boolean }) {
  const status = statusStore.use()
  const [tab, setTab] = useState<Tab>('agents')

  // Keep the status fresh: poll the API + apply live WS events.
  useEffect(() => {
    const api = apiStore.get()
    const live = liveStore.get()
    if (!api || !live) return

    const refresh = (): void => {
      void api
        .status()
        .then((s) => statusStore.set({ ...statusStore.get(), ...s }))
        .catch(() => undefined)
    }
    refresh()
    const t = setInterval(refresh, 5000)

    const unsub = live.on((e) => {
      const cur = statusStore.get()
      if (!cur) return
      // Only RARE structural events touch the store — data events are high-frequency (agent TUIs
      // stream in 16ms batches) and would otherwise re-render the whole home list per batch.
      if (e.event === 'sessions' && e.sessions) statusStore.set({ ...cur, sessions: e.sessions })
    })
    return () => {
      clearInterval(t)
      unsub()
    }
  }, [])

  const sessions: Session[] = status?.sessions ?? []
  const workspaces: Workspace[] = status?.workspaces ?? []
  const agents = useMemo(
    () => sessions.filter((s) => s.agentKind && !s.exited),
    [sessions],
  )
  const terminals = useMemo(() => sessions.filter((s) => !s.agentKind), [sessions])
  // EVERY terminal panel across the workspaces (idle ones included), with its live status.
  const allTerminals = useMemo(() => {
    const out: Array<{ terminalId: string; ptyId: string; panelId: string; title: string; cwd: string; spaceName: string; live: boolean }> = []
    for (const w of workspaces) {
      for (const t of w.terminals ?? []) {
        const liveSess = sessions.find((s) => s.terminalId === t.terminalId && !s.exited)
        out.push({
          terminalId: t.terminalId,
          ptyId: liveSess?.ptyId ?? '',
          panelId: t.panelId,
          title: t.title,
          cwd: t.cwd,
          spaceName: w.name,
          live: !!liveSess,
        })
      }
    }
    return out
  }, [workspaces, sessions])

  const wsName = (id: string): string => workspaces.find((w) => w.id === id)?.name ?? ''

  return (
    <>
      <header className="topbar">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div className="brand">
            <BrandMark size={22} />
          </div>
          <h1>PLANO</h1>
        </div>
        <button className="btn ghost" style={{ padding: '6px 10px', fontSize: 12 }} onClick={onDisconnect}>
          Disconnect
        </button>
      </header>

      {up ? (
        <div className="status-banner online">
          <span className="dot live" style={{ width: 8, height: 8 }} />
          Connected to your PC — agents are live
        </div>
      ) : (
        <div className="status-banner offline">
          <span className="dot" style={{ width: 8, height: 8 }} />
          Offline — reconnecting to your PC…
        </div>
      )}

      <div className="scroll">
        {tab === 'agents' && (
          <>
            {agents.length === 0 && (
              <div className="empty">
                No agents running right now.
                <br />
                Launch one from the + tab.
              </div>
            )}
            {agents.map((s) => {
              const row = agentRow(s.agentKind)
              return (
                <div key={s.ptyId} className="agent-row sheet-tap" onClick={() => go({ name: 'agent', ptyId: s.ptyId })}>
                  <div className="agent-badge" style={{ color: row.accent, border: `1px solid ${row.accent}44` }}>
                    {row.mark}
                  </div>
                  <div className="mid">
                    <div className="name">{s.title || row.label}</div>
                    <div className="sub">
                      {wsName(s.spaceId) || s.cwd.split(/[\\/]/).pop()}
                      {s.phase ? ` · ${s.phase}` : ''}
                    </div>
                  </div>
                  <span className={`chip ${s.phase ?? 'idle'}`}>{s.phase ?? 'ready'}</span>
                </div>
              )
            })}
          </>
        )}

        {tab === 'terminals' && (
          <>
            {allTerminals.length === 0 && (
              <div className="empty">No terminals in your workspaces.</div>
            )}
            {allTerminals.map((t) => (
              <div
                key={t.terminalId}
                className="agent-row sheet-tap"
                onClick={() => t.live && go({ name: 'terminal', ptyId: t.ptyId })}
                style={t.live ? undefined : { opacity: 0.55 }}
              >
                <div className="agent-badge" style={{ color: t.live ? '#9a9387' : '#5f5a4f' }}>{'>'}</div>
                <div className="mid">
                  <div className="name">{t.title || 'Terminal'}</div>
                  <div className="sub">{t.spaceName}{t.cwd ? ' · ' + t.cwd.split(/[\/]/).pop() : ''}</div>
                </div>
                <span className={`chip ${t.live ? 'shell' : 'exited'}`}>{t.live ? 'live' : 'closed'}</span>
                <DeleteButton
                  ptyId={t.ptyId}
                  label={t.title || 'Terminal'}
                  panelId={t.panelId}
                  terminalId={t.terminalId}
                  live={t.live}
                />
              </div>
            ))}
          </>
        )}

        {tab === 'workspaces' && (
          <>
            {workspaces.length === 0 && (
              <div className="empty">No workspaces found on the PC.</div>
            )}
            {workspaces.map((w) => {
              const wAgents = agents.filter((a) => a.spaceId === w.id).length
              // Show the workspace's REAL terminal count (its panels — idle ones included).
              const wTerms = w.terminalCount
              return (
                <div key={w.id} className="ws-card" onClick={() => go({ name: 'new', workspaceId: w.id })}>
                  <div className="ws-name">{w.name}</div>
                  <div className="ws-folder">{w.folderPath ?? 'No folder'}</div>
                  <div className="ws-stats">
                    <span className="chip working" style={{ background: 'rgba(216,169,92,.14)', color: '#e6bd7d' }}>
                      {wAgents} agent{wAgents === 1 ? '' : 's'}
                    </span>
                    <span className="chip shell">{wTerms} terminal{wTerms === 1 ? '' : 's'}</span>
                  </div>
                </div>
              )
            })}
            <div className="hint" style={{ marginTop: 12 }}>
              Tap a workspace to launch an agent inside it.
            </div>
          </>
        )}
      </div>

      <nav className="tabbar">
        <TabButton active={tab === 'agents'} label="Agents" icon={AgentIcon} onClick={() => setTab('agents')} />
        <TabButton active={tab === 'terminals'} label="Terminals" icon={TermIcon} onClick={() => setTab('terminals')} />
        <TabButton active={tab === 'workspaces'} label="Spaces" icon={SpaceIcon} onClick={() => setTab('workspaces')} />
        <TabButton label="New" icon={PlusIcon} onClick={() => go({ name: 'new' })} />
      </nav>
    </>
  )
}

function TabButton({
  active,
  label,
  icon: Icon,
  onClick,
}: {
  active?: boolean
  label: string
  icon: () => JSX.Element
  onClick: () => void
}) {
  return (
    <button className={`tab ${active ? 'active' : ''}`} onClick={onClick}>
      <Icon />
      {label}
    </button>
  )
}

const AgentIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
    <rect x="5" y="8" width="14" height="9" rx="2" />
    <path d="M9 8V6a3 3 0 0 1 6 0v2" />
    <circle cx="9.5" cy="12.5" r="1" fill="currentColor" stroke="none" />
    <circle cx="14.5" cy="12.5" r="1" fill="currentColor" stroke="none" />
  </svg>
)
const TermIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M7 9l3 3-3 3M13 15h4" />
  </svg>
)
const SpaceIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
    <rect x="3" y="3" width="8" height="8" rx="2" />
    <rect x="13" y="3" width="8" height="8" rx="2" />
    <rect x="3" y="13" width="8" height="8" rx="2" />
    <rect x="13" y="13" width="8" height="8" rx="2" />
  </svg>
)
const PlusIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
    <path d="M12 5v14M5 12h14" />
  </svg>
)

function DeleteButton({
  ptyId,
  label,
  panelId,
  terminalId,
  live,
}: {
  ptyId: string
  label: string
  panelId?: string
  terminalId?: string
  live?: boolean
}) {
  const [confirming, setConfirming] = useState(false)
  return (
    <button
      className="delete-btn"
      title="Close terminal"
      onClick={(e) => {
        e.stopPropagation()
        if (confirming) {
          if (live) {
            void apiStore.get()?.kill(ptyId).catch(() => undefined)
          } else if (panelId || terminalId) {
            // Closed terminal: no live pty — ask the PC to remove its canvas panel.
            void apiStore.get()?.removePanel(panelId ?? '', terminalId ?? '').catch(() => undefined)
          }
        } else {
          setConfirming(true)
          setTimeout(() => setConfirming(false), 2500)
        }
      }}
    >
      {confirming ? 'Sure?' : '✕'}
    </button>
  )
}
