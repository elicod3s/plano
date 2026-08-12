import type { Panel, AgentProps } from '@shared/domain/panel'
import { Icon } from '@/design-system/Icon'
import { Button } from '@/design-system/Button'
import { cn } from '@/lib/cn'
import { usePanelStore } from '@/stores/usePanelStore'

interface Launcher {
  id: 'claude-code' | 'codex'
  name: string
  description: string
  icon: string
  command: string
  accent: string
}

const LAUNCHERS: Launcher[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    description: 'Anthropic’s coding agent, running in a full terminal.',
    icon: 'Sparkles',
    command: 'claude',
    accent: '#d97757',
  },
  {
    id: 'codex',
    name: 'OpenAI Codex',
    description: 'Codex CLI with the complete PLANO terminal experience.',
    icon: 'Braces',
    command: 'codex',
    accent: '#4f8cf7',
  },
]

/** A real agent launcher: every visible action creates a live terminal-backed CLI session. */
export function AgentPanel({ panel }: { panel: Panel }) {
  const props = panel.props as AgentProps
  const addPanel = usePanelStore((state) => state.addPanel)
  const updateProps = usePanelStore((state) => state.updateProps)
  const selected = LAUNCHERS.find((launcher) => launcher.id === props.provider) ?? LAUNCHERS[0]

  const launch = (): void => {
    // The body is memoized during drags (PanelBody), so the `panel` prop here can be stale
    // after a gesture — always anchor the new terminal at the panel's CURRENT rect.
    const cur = usePanelStore.getState().panels[panel.id] ?? panel
    // Seed launch settings in the same store commit as the panel. This prevents the terminal
    // mounting between addPanel/updateProps and spawning the agent without its approval flags.
    addPanel(
      'terminal',
      {
        x: cur.rect.x + cur.rect.width + 390,
        y: cur.rect.y + cur.rect.height / 2,
      },
      { bootCommand: selected.command },
    )
  }

  return (
    <div className="flex h-full flex-col bg-transparent">
      <div className="border-b border-subtle bg-surface-2 px-4 pb-4 pt-3">
        <p className="label-caps text-text-tertiary">Choose an agent</p>
        <p className="mt-1 max-w-[44ch] text-[13px] leading-relaxed text-text-secondary">
          Launch a real CLI session beside this panel. It keeps terminal tabs, session restore, files, and process status.
        </p>
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        {LAUNCHERS.map((launcher) => {
          const active = selected.id === launcher.id
          return (
            <button
              key={launcher.id}
              type="button"
              onClick={() => updateProps<'agent'>(panel.id, { provider: launcher.id })}
              className={cn(
                'app-no-drag flex w-full items-center gap-3 rounded-md border p-3 text-left transition-all duration-200 focus-caliper',
                active
                  ? 'border-strong bg-accent-soft-strong'
                  : 'border-subtle bg-surface-2 hover:border-default hover:bg-surface-3',
              )}
            >
              <span
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-default bg-surface-3"
                style={{ color: launcher.accent }}
              >
                <Icon name={launcher.icon} size={17} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-semibold text-text-primary">{launcher.name}</span>
                <span className="mt-0.5 block text-[12px] leading-relaxed text-text-tertiary">
                  {launcher.description}
                </span>
              </span>
              <Icon name={active ? 'CircleCheck' : 'Circle'} size={16} className={active ? 'text-text-primary' : 'text-text-quaternary'} />
            </button>
          )
        })}
      </div>

      <div className="border-t border-subtle bg-surface-2 p-3">
        <Button variant="primary" className="w-full" onClick={launch}>
          <Icon name="SquareTerminal" size={15} />
          Open {selected.name} in terminal
        </Button>
      </div>
    </div>
  )
}
