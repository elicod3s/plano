/** Connect screen — auto-detects the PC (plano.local), probes the address, connects with the token. */
import { useEffect, useState } from 'react'
import { BrandMark } from '../components/BrandMark'
import { Api } from '../lib/api'
import type { Conn } from '../lib/types'

const FIXED = 'plano.local:56780'

export function ConnectScreen({
  onConnect,
  error,
}: {
  onConnect: (c: Conn) => Promise<boolean>
  error: string | null
}) {
  const [host, setHost] = useState(() => {
    const saved = localStorage.getItem('plano.lastbase') ?? ''
    const clean = saved.replace(/^https?:\/\//, '').replace(/\/$/, '')
    return clean || FIXED
  })
  const [token, setToken] = useState(() => {
    const saved = localStorage.getItem('plano.conn.v1')
    if (!saved) return ''
    try {
      return (JSON.parse(saved) as { token?: string }).token ?? ''
    } catch {
      return ''
    }
  })
  const [busy, setBusy] = useState(false)
  const [probe, setProbe] = useState<'checking' | 'found' | 'none' | null>(null)
  const [err, setErr] = useState<string | null>(error)

  // Debounced liveness probe of the typed address (no token needed) → green "PLANO found".
  useEffect(() => {
    const h = host.trim()
    if (!h) {
      setProbe(null)
      return
    }
    const base = h.includes('://') ? h.replace(/\/$/, '') : `http://${h.replace(/\/$/, '')}`
    setProbe('checking')
    const t = setTimeout(() => {
      void Api.ping(base).then((r) => setProbe(r.ok && r.name === 'plano' ? 'found' : 'none'))
    }, 450)
    return () => clearTimeout(t)
  }, [host])

  const submit = async (): Promise<void> => {
    const h = host.trim()
    if (!h) {
      setErr('Enter the PC address (or scan the QR).')
      return
    }
    const base = h.includes('://') ? h.replace(/\/$/, '') : `http://${h.replace(/\/$/, '')}`
    setBusy(true)
    setErr(null)
    // On the same Wi-Fi the token is optional (the daemon trusts the local network).
    const ok = await onConnect({ base, token: token.trim() })
    setBusy(false)
    if (!ok) setErr('Could not connect — check the address and that the PC is on the same network.')
  }

  return (
    <div className="connect">
      <div className="hero">
        <div className="logo" style={{ color: 'var(--text)' }}>
          <BrandMark size={40} />
        </div>
        <h1>PLANO</h1>
        <p>Your workspace, in your pocket.</p>
      </div>

      <div className="connect-card">
        <label className="field-label">PC address</label>
        <div className="field-wrap">
          <input
            className="input"
            placeholder={FIXED}
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={host}
            onChange={(e) => setHost(e.target.value)}
          />
          {probe === 'found' && <span className="probe-dot found" title="PLANO found on this address" />}
          {probe === 'checking' && <span className="probe-dot checking" />}
          {probe === 'none' && <span className="probe-dot none" title="Nothing there" />}
        </div>
        <div className="field-hint">
          {probe === 'found' ? '✓ PLANO found on this PC' : 'plano.local works automatically on the same Wi-Fi'}
        </div>

        <label className="field-label" style={{ marginTop: 14 }}>
          Token <span style={{ opacity: 0.55, textTransform: 'none', letterSpacing: 0 }}>(optional on your Wi-Fi)</span>
        </label>
        <input
          className="input"
          placeholder="Only needed from another network"
          inputMode="text"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />

        {err && <div className="error-text" style={{ marginTop: 10 }}>{err}</div>}

        <button
          className="btn primary block"
          style={{ marginTop: 16 }}
          disabled={busy || !host.trim()}
          onClick={() => void submit()}
        >
          {busy ? <span className="spinner" /> : 'Connect'}
        </button>

        <div className="divider">or</div>
        <button
          className="btn block"
          onClick={() => {
            const saved = localStorage.getItem('plano.lastbase')
            if (saved) {
              const base = saved.replace(/\/$/, '')
              const tok = (() => {
                try {
                  return (JSON.parse(localStorage.getItem('plano.conn.v1') ?? '{}') as { token?: string }).token ?? ''
                } catch {
                  return ''
                }
              })()
              if (tok) void onConnect({ base, token: tok })
            }
          }}
        >
          Reconnect to last PC
        </button>
      </div>

      <div className="hint">
        In PLANO on your PC: <b>Settings → Mobile & Remote</b> → scan the QR code with your camera —
        it fills everything in automatically.
      </div>
    </div>
  )
}
