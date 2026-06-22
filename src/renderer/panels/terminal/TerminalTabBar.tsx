import type { MouseEvent } from 'react'
import type { TerminalTab } from '@shared/domain/panel'
import { AGENTS } from '@shared/domain/agent'
import { useTerminalStore } from '@/stores/useTerminalStore'
import { useAgentStore, selectVerdict } from '@/stores/useAgentStore'
import { Icon } from '@/design-system/Icon'
import { cn } from '@/lib/cn'
import { AgentLogo } from './AgentLogo'

/** Last path segment of a cwd, for a terminal's default tab label. */
const basename = (p?: string): string => {
  if (!p) return ''
  const parts = p.replace(/[/\\]+$/, '').split(/[/\\]/)
  return parts[parts.length - 1] || p
}

/**
 * One tab pill. Subscribes to its OWN terminal runtime so it can show the running agent's logo +
 * name (or the cwd basename) without the panel re-rendering when an unrelated tab changes.
 */
function TabButton({
  tab,
  active,
  showClose,
  onSelect,
  onClose,
}: {
  tab: TerminalTab
  active: boolean
  showClose: boolean
  onSelect: () => void
  onClose: () => void
}) {
  const ptyId = useTerminalStore((s) => s.byPanel[tab.id]?.ptyId ?? null)
  const cwd = useTerminalStore((s) => s.byPanel[tab.id]?.cwd)
  const verdict = useAgentStore(selectVerdict(ptyId))
  const agentKind = verdict.active ? verdict.kind : null
  const accent = agentKind ? AGENTS[agentKind].accent : undefined

  const label =
    tab.title?.trim() ||
    (agentKind ? AGENTS[agentKind].displayName : '') ||
    basename(cwd ?? tab.cwd) ||
    'Terminal'

  const onCloseClick = (e: MouseEvent): void => {
    e.stopPropagation()
    onClose()
  }

  return (
    <button
      type="button"
      title={label}
      onClick={onSelect}
      // Middle-click closes, like a browser tab.
      onAuxClick={(e) => {
        if (e.button === 1) onCloseClick(e)
      }}
      className={cn(
        'app-no-drag group flex h-6 max-w-[180px] shrink-0 items-center gap-1.5 rounded-pill border px-2.5',
        'text-xs transition-[background,color,border-color] duration-150 ease-settle focus-caliper',
        active
          ? 'border-default bg-surface-3 text-text-primary'
          : 'border-transparent text-text-secondary hover:bg-accent-soft hover:text-text-primary',
      )}
    >
      {agentKind ? (
        <AgentLogo kind={agentKind} size={12} color={accent} className="shrink-0" />
      ) : (
        <Icon name="Terminal" size={12} className="shrink-0 opacity-70" />
      )}
      <span className="truncate">{label}</span>
      {showClose && (
        <span
          role="button"
          tabIndex={-1}
          aria-label="Close terminal"
          title="Close terminal"
          onClick={onCloseClick}
          className={cn(
            '-mr-1 ml-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full',
            'text-text-tertiary opacity-0 transition-opacity hover:bg-destructive-soft hover:text-destructive-hover',
            'group-hover:opacity-100',
            active && 'opacity-70',
          )}
        >
          <Icon name="X" size={10} />
        </span>
      )}
    </button>
  )
}

/**
 * Slim tab strip pinned to the top of a terminal panel: one pill per terminal (tab) plus a "+"
 * to spawn another in the SAME panel. Always visible so a new terminal is one click away even
 * when an agent is running in the active tab. Selecting/closing/adding are pure props mutations
 * (the parent kills the PTY before removing a tab).
 */
export function TerminalTabBar({
  tabs,
  activeTabId,
  onSelect,
  onClose,
  onAdd,
}: {
  tabs: TerminalTab[]
  activeTabId: string | undefined
  onSelect: (tabId: string) => void
  onClose: (tabId: string) => void
  onAdd: () => void
}) {
  const showClose = tabs.length > 1
  return (
    <div
      // app-drag: the strip's empty space still drags the panel; the pills/+ opt out via app-no-drag.
      className="flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b border-default px-2"
      style={{ background: 'var(--surface-2)' }}
    >
      {tabs.map((t) => (
        <TabButton
          key={t.id}
          tab={t}
          active={t.id === activeTabId}
          showClose={showClose}
          onSelect={() => onSelect(t.id)}
          onClose={() => onClose(t.id)}
        />
      ))}
      <button
        type="button"
        aria-label="New terminal"
        title="New terminal"
        onClick={onAdd}
        className={cn(
          'app-no-drag inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-pill',
          'text-text-secondary transition-[background,color,transform] duration-150 ease-settle',
          'hover:bg-accent-soft hover:text-text-primary active:scale-[0.96] focus-caliper',
        )}
      >
        <Icon name="Plus" size={14} />
      </button>
    </div>
  )
}
