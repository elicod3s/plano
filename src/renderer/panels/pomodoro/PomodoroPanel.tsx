import { useEffect, useRef, useState } from 'react'
import type { Panel, PomodoroProps } from '@shared/domain/panel'
import { usePanelStore } from '@/stores/usePanelStore'
import { IconButton } from '@/design-system/IconButton'
import { Icon } from '@/design-system/Icon'
import { cn } from '@/lib/cn'
import { playChime, playTick, primeAudio } from './chime'

type Phase = 'focus' | 'short' | 'long'

const PHASE_LABEL: Record<Phase, string> = {
  focus: 'Focus',
  short: 'Short Break',
  long: 'Long Break',
}

const RING_R = 44
const RING_C = 2 * Math.PI * RING_R

const clampMin = (n: number): number => Math.max(1, Math.min(180, Math.round(n || 0)))

const fmt = (total: number): string => {
  const t = Math.max(0, total)
  const m = Math.floor(t / 60)
  const s = t % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

/**
 * Pomodoro timer. Configuration (durations / sound) lives in panel props and persists;
 * the live countdown is runtime-only state (resets on reload, like a terminal respawns).
 * Phases auto-advance focus → short/long break and chime on every transition.
 */
export function PomodoroPanel({ panel }: { panel: Panel }) {
  const props = panel.props as PomodoroProps
  const updateProps = usePanelStore((s) => s.updateProps)

  const durations: Record<Phase, number> = {
    focus: clampMin(props.workMinutes) * 60,
    short: clampMin(props.breakMinutes) * 60,
    long: clampMin(props.longBreakMinutes) * 60,
  }
  const rounds = Math.max(1, Math.min(12, Math.round(props.roundsBeforeLongBreak || 4)))

  const [phase, setPhase] = useState<Phase>('focus')
  const [remaining, setRemaining] = useState(durations.focus)
  const [running, setRunning] = useState(false)
  const [completed, setCompleted] = useState(0) // focus sessions finished this cycle
  const [showSettings, setShowSettings] = useState(false)

  // Refs feed the transition handler the latest values without re-creating the interval.
  const phaseRef = useRef(phase)
  const completedRef = useRef(completed)
  const durationsRef = useRef(durations)
  const roundsRef = useRef(rounds)
  const soundRef = useRef(props.soundEnabled)
  phaseRef.current = phase
  completedRef.current = completed
  durationsRef.current = durations
  roundsRef.current = rounds
  soundRef.current = props.soundEnabled

  // Tick once per second while running.
  useEffect(() => {
    if (!running) return
    const id = window.setInterval(() => setRemaining((r) => r - 1), 1000)
    return () => window.clearInterval(id)
  }, [running])

  // Auto-advance the phase when the clock reaches zero.
  useEffect(() => {
    if (remaining > 0) return
    const d = durationsRef.current
    if (phaseRef.current === 'focus') {
      if (soundRef.current) playChime('work')
      const done = completedRef.current + 1
      if (done >= roundsRef.current) {
        setCompleted(0)
        setPhase('long')
        setRemaining(d.long)
      } else {
        setCompleted(done)
        setPhase('short')
        setRemaining(d.short)
      }
    } else {
      if (soundRef.current) playChime('break')
      setPhase('focus')
      setRemaining(d.focus)
    }
  }, [remaining])

  // Reflect duration edits onto the clock while idle; never disturb a running/paused run.
  useEffect(() => {
    if (!running) setRemaining(durationsRef.current[phaseRef.current])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [durations.focus, durations.short, durations.long])

  const toggleRun = (): void => {
    primeAudio() // resume the audio context from this user gesture so later chimes are allowed
    if (props.soundEnabled) playTick()
    setRunning((r) => !r)
  }
  const reset = (): void => {
    setRunning(false)
    setRemaining(durations[phase])
  }
  const skip = (): void => {
    if (phase === 'focus') {
      const done = completed + 1
      if (done >= rounds) {
        setCompleted(0)
        setPhase('long')
        setRemaining(durations.long)
      } else {
        setCompleted(done)
        setPhase('short')
        setRemaining(durations.short)
      }
    } else {
      setPhase('focus')
      setRemaining(durations.focus)
    }
  }

  const total = durations[phase]
  const progress = Math.max(0, Math.min(1, remaining / total))
  const ringColor = phase === 'focus' ? 'var(--text-primary)' : 'var(--text-secondary)'

  return (
    <div className="flex h-full w-full flex-col bg-surface-1">
      {/* top row: phase + sound/settings */}
      <div className="flex shrink-0 items-center gap-2 px-3 pt-3">
        <span className="label-caps text-text-secondary">{PHASE_LABEL[phase]}</span>
        {running && <span className="h-1.5 w-1.5 animate-status-pulse rounded-pill bg-text-primary" />}
        <div className="ml-auto flex items-center gap-0.5">
          <IconButton
            icon={props.soundEnabled ? 'Volume2' : 'VolumeX'}
            label={props.soundEnabled ? 'Mute chime' : 'Unmute chime'}
            size={26}
            active={props.soundEnabled}
            onClick={() => updateProps<'pomodoro'>(panel.id, { soundEnabled: !props.soundEnabled })}
          />
          <IconButton
            icon="Settings2"
            label="Timer settings"
            size={26}
            active={showSettings}
            onClick={() => setShowSettings((v) => !v)}
          />
        </div>
      </div>

      {/* ring + time */}
      <div className="flex min-h-0 flex-1 items-center justify-center px-4 py-2">
        <div className="relative aspect-square w-full max-w-[220px]">
          <svg viewBox="0 0 100 100" className="h-full w-full -rotate-90">
            <circle cx="50" cy="50" r={RING_R} fill="none" stroke="var(--border-default)" strokeWidth="5" />
            <circle
              cx="50"
              cy="50"
              r={RING_R}
              fill="none"
              stroke={ringColor}
              strokeWidth="5"
              strokeLinecap="round"
              strokeDasharray={RING_C}
              strokeDashoffset={RING_C * (1 - progress)}
              style={{ transition: 'stroke-dashoffset 0.4s linear, stroke 0.3s ease' }}
            />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span className="font-mono text-[34px] font-semibold tabular-nums tracking-tight text-text-primary">
              {fmt(remaining)}
            </span>
            <span className="mt-0.5 text-[11px] text-text-tertiary">
              {phase === 'focus' ? `Session ${completed + 1} of ${rounds}` : 'Break'}
            </span>
          </div>
        </div>
      </div>

      {/* session dots */}
      <div className="flex shrink-0 items-center justify-center gap-1.5 pb-1">
        {Array.from({ length: rounds }).map((_, i) => (
          <span
            key={i}
            className={cn(
              'h-1.5 w-1.5 rounded-pill transition-colors',
              i < completed
                ? 'bg-text-primary'
                : i === completed && phase === 'focus'
                  ? 'bg-text-secondary'
                  : 'bg-[var(--border-strong)]',
            )}
          />
        ))}
      </div>

      {/* controls */}
      <div className="flex shrink-0 items-center justify-center gap-2 px-4 pb-3 pt-1">
        <IconButton icon="RotateCcw" label="Reset" size={36} onClick={reset} />
        <button
          type="button"
          onClick={toggleRun}
          className={cn(
            'app-no-drag flex h-12 w-12 items-center justify-center rounded-pill border transition-colors',
            'bg-accent text-text-onsolid hover:bg-accent-hover active:scale-[0.97]',
          )}
          aria-label={running ? 'Pause' : 'Start'}
          title={running ? 'Pause' : 'Start'}
        >
          <Icon name={running ? 'Pause' : 'Play'} size={22} className={running ? '' : 'translate-x-[1px]'} />
        </button>
        <IconButton icon="SkipForward" label="Skip phase" size={36} onClick={skip} />
      </div>

      {/* settings */}
      {showSettings && (
        <div className="shrink-0 space-y-1 border-t border-subtle bg-surface-2 px-3 py-2">
          <Stepper
            label="Focus"
            unit="min"
            value={clampMin(props.workMinutes)}
            onChange={(v) => updateProps<'pomodoro'>(panel.id, { workMinutes: clampMin(v) })}
          />
          <Stepper
            label="Short break"
            unit="min"
            value={clampMin(props.breakMinutes)}
            onChange={(v) => updateProps<'pomodoro'>(panel.id, { breakMinutes: clampMin(v) })}
          />
          <Stepper
            label="Long break"
            unit="min"
            value={clampMin(props.longBreakMinutes)}
            onChange={(v) => updateProps<'pomodoro'>(panel.id, { longBreakMinutes: clampMin(v) })}
          />
          <Stepper
            label="Rounds"
            value={rounds}
            min={1}
            max={12}
            onChange={(v) => updateProps<'pomodoro'>(panel.id, { roundsBeforeLongBreak: Math.max(1, Math.min(12, v)) })}
          />
        </div>
      )}
    </div>
  )
}

function Stepper({
  label,
  value,
  onChange,
  unit,
  min = 1,
  max = 180,
}: {
  label: string
  value: number
  onChange: (v: number) => void
  unit?: string
  min?: number
  max?: number
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[12px] text-text-secondary">{label}</span>
      <div className="flex items-center gap-1">
        <IconButton icon="Minus" label={`Decrease ${label}`} size={24} disabled={value <= min} onClick={() => onChange(value - 1)} />
        <span className="w-10 text-center font-mono text-[13px] tabular-nums text-text-primary">
          {value}
          {unit && <span className="ml-0.5 text-[10px] text-text-tertiary">{unit}</span>}
        </span>
        <IconButton icon="Plus" label={`Increase ${label}`} size={24} disabled={value >= max} onClick={() => onChange(value + 1)} />
      </div>
    </div>
  )
}
