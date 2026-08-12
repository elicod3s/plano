/**
 * MobileChip — the always-visible TopBar indicator for the PLANO mobile web app.
 * A clean pill: phone icon with a small status dot on its corner (green = a phone is connected
 * right now, dim = not). Click opens Settings → Mobile & Remote (QR + URL + token).
 */
import { useEffect, useState } from 'react'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { Icon } from '@/design-system/Icon'
import { cn } from '@/lib/cn'

interface RemoteState {
  webPort: number
  phoneConnected: boolean
}

export function MobileChip() {
  const [state, setState] = useState<RemoteState>({ webPort: 0, phoneConnected: false })
  const [known, setKnown] = useState(false)

  useEffect(() => {
    let alive = true
    const poll = (): void => {
      void window.plano.app
        .getRemoteInfo()
        .then((r) => {
          if (!alive) return
          setKnown(true)
          setState({ webPort: r.webPort, phoneConnected: r.phoneConnected })
        })
        .catch(() => undefined)
    }
    poll()
    const t = setInterval(poll, 3000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [])

  // No daemon/web info yet → keep the TopBar clean (nothing to show).
  if (!known || state.webPort <= 0) return null

  return (
    <button
      type="button"
      aria-label="Mobile & Remote"
      title={
        state.phoneConnected
          ? 'Phone connected — tap to open Mobile & Remote'
          : 'Mobile & Remote — scan the QR to connect your phone'
      }
      onClick={() => useSettingsStore.getState().openTo('mobile')}
      className={cn(
        'app-no-drag relative flex h-7 shrink-0 cursor-pointer items-center gap-2 rounded-pill border border-glass px-2.5 text-[12.5px] transition-colors',
        state.phoneConnected
          ? 'border-[rgba(52,211,153,0.35)] text-[#6ee7b7]'
          : 'text-text-2 hover:border-glass-hover hover:bg-glass hover:text-text-1',
      )}
      style={{ background: state.phoneConnected ? 'rgba(52,211,153,0.08)' : 'var(--glass)' }}
    >
      {/* Icon with the live-status dot on its corner — always centered via flex. */}
      <span className="relative flex h-4 w-4 items-center justify-center">
        <Icon name="Smartphone" size={13} strokeWidth={1.7} />
        <span
          className={cn(
            'absolute -right-1 -top-1 h-[6px] w-[6px] rounded-full border transition-colors',
            state.phoneConnected ? 'border-[rgba(52,211,153,0.2)] bg-[#34d399]' : 'border-glass-strong bg-text-muted',
          )}
          style={{ boxShadow: state.phoneConnected ? '0 0 6px rgba(52, 211, 153, 0.7)' : 'none' }}
        />
      </span>
      <span className="leading-none">{state.phoneConnected ? 'Phone' : 'Mobile'}</span>
    </button>
  )
}
