import { useEffect, useRef, useState, type CSSProperties } from 'react'
import type { IconType } from 'react-icons'
import { SiClaude, SiOpenai, SiGooglegemini } from 'react-icons/si'
import { Icon } from '@/design-system/Icon'
import { cn } from '@/lib/cn'
import { KiroLogo } from './KiroLogo'

interface LauncherEntry {
  id: string
  name: string
  /** command typed + run in the terminal */
  command: string
  accent: string
  /** official brand mark (simple-icons via react-icons) */
  Logo?: IconType
  /** lucide fallback when there is no official brand icon */
  icon?: string
}

const LAUNCHERS: LauncherEntry[] = [
  { id: 'claude', name: 'Claude Code', command: 'claude', accent: '#d97757', Logo: SiClaude },
  { id: 'codex', name: 'Codex', command: 'codex', accent: '#4f8cf7', Logo: SiOpenai },
  { id: 'gemini', name: 'Gemini', command: 'gemini', accent: '#a855f7', Logo: SiGooglegemini },
  { id: 'kiro', name: 'Kiro CLI', command: 'kiro-cli chat', accent: '#8b5cf6', Logo: KiroLogo },
  { id: 'opencode', name: 'opencode', command: 'opencode', accent: '#14b8a6', icon: 'SquareTerminal' },
  { id: 'aider', name: 'Aider', command: 'aider', accent: '#22c55e', icon: 'Bot' },
]

// Below this terminal width, chips drop their labels and show icon-only (tooltip keeps
// the name) so the row always fits a narrow terminal instead of overflowing/clipping.
const LABEL_WIDTH_THRESHOLD = 470

/**
 * A compact, responsive, collapsible quick-launcher centered at the bottom of a
 * terminal (the Clear / scroll controls sit on the bottom-right). Each chip runs the CLI
 * in THIS terminal (writes `command` + Enter to the PTY). Hidden once an agent is
 * detected — AgentBar takes over.
 */
export function AgentLauncher({ ptyId }: { ptyId: string }) {
  const [open, setOpen] = useState(false)
  const [showLabels, setShowLabels] = useState(true)
  const rootRef = useRef<HTMLDivElement>(null)

  // Track the host terminal's width to switch between label and icon-only chips.
  useEffect(() => {
    const host = rootRef.current?.parentElement
    if (!host) return
    const ro = new ResizeObserver(([entry]) => {
      setShowLabels(entry.contentRect.width >= LABEL_WIDTH_THRESHOLD)
    })
    ro.observe(host)
    return () => ro.disconnect()
  }, [])

  const launch = (command: string): void => {
    window.plano.terminal.write(ptyId, `${command}\r`)
    setOpen(false)
  }

  return (
    <div ref={rootRef} className="app-no-drag pointer-events-auto absolute bottom-2.5 left-1/2 z-20 -translate-x-1/2">
      {open ? (
        <div
          className="animate-menu-in flex max-w-full items-center gap-px rounded-xl border border-default p-1 shadow-popover backdrop-blur-md"
          style={{ background: 'color-mix(in srgb, var(--surface-3) 90%, transparent)' }}
        >
          {LAUNCHERS.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => launch(a.command)}
              title={`Run "${a.command}" in this terminal`}
              className={cn(
                'agent-launch-btn flex shrink-0 items-center gap-1.5 rounded-lg text-[12px] font-medium text-text-secondary transition-colors',
                showLabels ? 'px-2 py-1.5' : 'h-8 w-8 justify-center',
              )}
              style={{ ['--a']: a.accent } as CSSProperties}
            >
              <span style={{ color: a.accent }} className="flex shrink-0">
                {a.Logo ? <a.Logo size={15} /> : <Icon name={a.icon ?? 'Bot'} size={14} />}
              </span>
              {showLabels && <span className="whitespace-nowrap">{a.name}</span>}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close launcher"
            className="ml-px flex h-8 w-6 shrink-0 items-center justify-center rounded-lg text-text-tertiary transition-colors hover:bg-accent-soft hover:text-text-primary"
          >
            <Icon name="X" size={13} />
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          title="Launch an AI agent in this terminal"
          className="flex items-center gap-2 rounded-pill border border-default py-1.5 pl-2.5 pr-3 text-[12px] font-medium text-text-secondary shadow-popover backdrop-blur-md transition-colors hover:border-strong hover:text-text-primary"
          style={{ background: 'color-mix(in srgb, var(--surface-3) 82%, transparent)' }}
        >
          <span className="flex -space-x-1">
            <SiClaude size={12} style={{ color: '#d97757' }} />
            <SiOpenai size={12} style={{ color: '#4f8cf7' }} />
            <SiGooglegemini size={12} style={{ color: '#a855f7' }} />
          </span>
          {showLabels && 'Agents'}
        </button>
      )}
    </div>
  )
}
