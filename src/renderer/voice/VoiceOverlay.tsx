/**
 * Odla — the global voice overlay. A full-window aura that breathes with your voice, plus a single
 * command bar (bottom-center): talk to it (hold the push-to-talk key or click the mic) OR type the
 * exact same command when you'd rather not speak. A transient line above shows the live transcript
 * and the result. Mounted once in App.tsx (portaled to <body>). Logic lives in the controller; this
 * just reflects voiceStore and drives it.
 */
import { useEffect, useState, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '@/design-system/Icon'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { voiceController } from './controller'
import { useVoiceStore, type VoicePhase } from './voiceStore'
import './voice.css'

const SPINNING: VoicePhase[] = ['transcribing', 'executing']

/**
 * The transient line above the bar. We intentionally do NOT show the raw transcript of what you said
 * (the model's interpretation can be noisy/wrong and looks bad) — just clean states:
 * "Listening…" while you speak, "…" while it processes, then "Done" (or a short error).
 */
function statusContent(phase: VoicePhase, errorMsg: string, micDenied: boolean): JSX.Element | null {
  switch (phase) {
    case 'listening':
      return <span>Listening…</span>
    case 'transcribing':
    case 'executing':
      // No "Thinking" word (user disliked it) — the bar's orbiting-light animation alone signals work.
      return null
    case 'result':
      return <strong className="voice-done">Done</strong>
    case 'error':
      return <span>{errorMsg || (micDenied ? 'Microphone blocked' : 'Didn’t catch that')}</span>
    default:
      return null
  }
}

export function VoiceOverlay(): JSX.Element | null {
  const hydrated = useSettingsStore((s) => s.hydrated)
  const voice = useSettingsStore((s) => s.settings.voice)
  const { phase, errorMsg, micDenied } = useVoiceStore()
  const [value, setValue] = useState('')

  // Enable/disable the controller with the setting; keep the push-to-talk key in sync.
  // Gated on hydration: the store boots from DEFAULT_SETTINGS (voice ON), so enabling before
  // the real settings arrive would warm the ~600 MB speech model even when voice is disabled
  // (and disable() never unloads it). Wait for main's settings before touching the controller.
  useEffect(() => {
    if (!hydrated) {
      voiceController.disable()
      return undefined
    }
    if (voice.enabled) {
      voiceController.setPushToTalkKey(voice.pushToTalkKey)
      voiceController.enable()
      return () => voiceController.disable()
    }
    voiceController.disable()
    return undefined
  }, [hydrated, voice.enabled])

  useEffect(() => {
    voiceController.setPushToTalkKey(voice.pushToTalkKey)
  }, [voice.pushToTalkKey])

  // Never render the overlay from the pre-hydration defaults (would flash the voice bar on every launch).
  if (!hydrated || !voice.enabled) return null

  const listening = phase === 'listening'
  const spinning = SPINNING.includes(phase)
  const auraActive = phase !== 'idle'
  const auraClass = ['voice-aura', auraActive ? 'active' : '', phase === 'error' ? 'error' : '', SPINNING.includes(phase) ? 'thinking' : '']
    .filter(Boolean)
    .join(' ')
  const barClass = ['voice-bar', phase === 'idle' ? 'idle' : '', listening ? 'listening' : '', spinning ? 'thinking' : '', phase === 'result' ? 'result' : '', phase === 'error' ? 'error' : '']
    .filter(Boolean)
    .join(' ')
  const micIcon = phase === 'error' ? (micDenied ? 'MicOff' : 'TriangleAlert') : phase === 'result' ? 'Check' : 'Mic'
  const status = statusContent(phase, errorMsg, micDenied)

  const submit = (e: FormEvent): void => {
    e.preventDefault()
    const v = value.trim()
    if (!v) return
    setValue('')
    void voiceController.runTyped(v)
  }

  return createPortal(
    <>
      <div className={auraClass} aria-hidden>
        <div className="voice-aura__glow" />
      </div>
      {auraActive && status && <div className={`voice-status ${phase === 'error' ? 'error' : ''}`.trim()}>{status}</div>}
      <form className={barClass} onSubmit={submit}>
        <button
          type="button"
          className="voice-mic-btn"
          onClick={() => voiceController.toggle()}
          title="Speak to Odla — or hold the push-to-talk shortcut"
          aria-label="Speak to Odla"
        >
          <span className={`voice-mic${phase === 'result' ? ' done' : ''}`}>
            {listening ? (
              <span className="voice-eq" aria-hidden>
                {Array.from({ length: 5 }, (_, i) => (
                  <i key={i} />
                ))}
              </span>
            ) : spinning ? (
              <span className="voice-think-dot" aria-hidden />
            ) : (
              <Icon name={micIcon} size={15} />
            )}
          </span>
        </button>
        <input
          className="voice-input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={listening}
          spellCheck={false}
          placeholder={listening ? 'Listening…' : 'Speak or type a command…'}
          aria-label="Type a command for Odla"
          onKeyDown={(e) => {
            if (e.key === 'Escape') (e.target as HTMLInputElement).blur()
          }}
        />
        {value.trim() && <span className="voice-enter" aria-hidden>↵</span>}
      </form>
    </>,
    document.body,
  )
}
