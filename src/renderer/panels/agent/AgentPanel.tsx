import { useState } from 'react'
import type { Panel } from '@shared/domain/panel'
import { Icon } from '@/design-system/Icon'
import { Toggle } from '@/design-system/Toggle'
import { Button } from '@/design-system/Button'
import { cn } from '@/lib/cn'

interface Launcher {
  id: string
  name: string
  icon: string
  command: string
  installed: boolean
}

const LAUNCHERS: Launcher[] = [
  { id: 'claude-code', name: 'Claude Code', icon: 'Sparkles', command: 'claude', installed: true },
  { id: 'codex', name: 'OpenAI Codex', icon: 'Braces', command: 'codex', installed: true },
  { id: 'opencode', name: 'opencode', icon: 'TerminalSquare', command: 'opencode', installed: false },
]

/**
 * Dedicated AI-agent panel. v1 is a faithful visual mock of the agent surface (launcher,
 * thread, always-visible Auto-approve). The live agent bridge is a later milestone — the
 * auto-detecting Terminal panel already delivers real agent UX today.
 */
export function AgentPanel({ panel: _panel }: { panel: Panel }) {
  const [selected, setSelected] = useState<string>('claude-code')
  const [autoApprove, setAutoApprove] = useState(false)
  const launcher = LAUNCHERS.find((l) => l.id === selected) ?? LAUNCHERS[0]

  return (
    <div className="flex h-full flex-col bg-surface-1">
      {/* launcher row */}
      <div className="flex items-center gap-1 border-b border-subtle bg-surface-2 px-2 py-1.5">
        {LAUNCHERS.map((l) => (
          <button
            key={l.id}
            type="button"
            onClick={() => setSelected(l.id)}
            className={cn(
              'app-no-drag flex items-center gap-1.5 rounded-sm px-2 py-1 text-[12px] transition-colors',
              selected === l.id ? 'bg-accent-soft-strong text-text-primary' : 'text-text-secondary hover:bg-accent-soft',
            )}
          >
            <Icon name={l.icon} size={13} />
            {l.name}
          </button>
        ))}
      </div>

      {/* thread */}
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3" style={{ userSelect: 'text' }}>
        <Message role="agent">
          {launcher.installed
            ? `${launcher.name} is ready. Ask it to build, fix, or explain — it works beside your files.`
            : `${launcher.name} isn't installed yet. Install it to launch here.`}
        </Message>
        <Message role="user">Refactor the canvas store to use selectors.</Message>
        <Message role="agent">
          Analyzed <span className="font-mono text-text-primary">usePanelStore.ts</span> — splitting actions from
          state and adding memoized selectors. Apply?
        </Message>
      </div>

      {/* footer: input + always-visible auto-approve */}
      <div className="border-t border-subtle bg-surface-2 p-2">
        <div className="mb-2 flex items-center justify-between">
          <span className="label-caps">Auto-approve</span>
          <Toggle checked={autoApprove} onChange={setAutoApprove} tone="arm" label="Auto-approve" />
        </div>
        <div className="flex items-end gap-2">
          <textarea
            rows={2}
            placeholder={launcher.installed ? `Instruct ${launcher.name}…` : `Install ${launcher.command}…`}
            disabled={!launcher.installed}
            spellCheck={false}
            className="app-no-drag min-h-[40px] flex-1 resize-none rounded-sm border border-default bg-surface-4 px-3 py-2 text-[13px] text-text-primary placeholder:text-text-tertiary focus-caliper disabled:opacity-50"
            style={{ userSelect: 'text' }}
          />
          {launcher.installed ? (
            <Button variant="primary" size="sm" aria-label="Send">
              <Icon name="ArrowUp" size={15} />
            </Button>
          ) : (
            <Button variant="secondary" size="sm">
              Install
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

function Message({ role, children }: { role: 'user' | 'agent'; children: React.ReactNode }) {
  return (
    <div className={cn('flex gap-2', role === 'user' && 'flex-row-reverse')}>
      <div
        className={cn(
          'flex h-6 w-6 shrink-0 items-center justify-center rounded-pill border border-subtle',
          role === 'agent' ? 'bg-surface-3' : 'bg-accent text-text-onsolid',
        )}
      >
        <Icon name={role === 'agent' ? 'Sparkles' : 'User'} size={13} />
      </div>
      <div
        className={cn(
          'max-w-[85%] rounded-md px-3 py-2 text-[13px] leading-relaxed',
          role === 'agent' ? 'bg-surface-3 text-text-secondary' : 'bg-accent-soft text-text-primary',
        )}
      >
        {children}
      </div>
    </div>
  )
}
