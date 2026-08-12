import type { MouseEvent } from 'react'
import type { TerminalTab } from '@shared/domain/panel'
import { AGENTS } from '@shared/domain/agent'
import { useTerminalStore } from '@/stores/useTerminalStore'
import { useAgentStore, selectVerdict } from '@/stores/useAgentStore'
import { useMeshMembership, useMeshPending, useMeshState } from '@/stores/useMeshLinks'
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
 * One segmented tab pill. Subscribes to its OWN terminal runtime so it can show the running
 * agent's logo + name (or the cwd basename) without the panel re-rendering when an unrelated
 * tab changes. The ACTIVE tab fills with the accent (like the design's Segmented Tabs).
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
  const mesh = useMeshMembership(ptyId ?? '')
  // v4 A3: queued messages (▾N) and the amber awaiting-input dot.
  const pending = useMeshPending(ptyId ?? '')
  const meshState = useMeshState(ptyId ?? '')

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
          ? 'border-transparent bg-accent text-text-onsolid'
          : 'border-transparent text-text-2 hover:bg-glass-hover hover:text-text-1',
      )}
    >
      {agentKind ? (
        <AgentLogo kind={agentKind} size={12} color={active ? 'currentColor' : accent} className="shrink-0" />
      ) : (
        <Icon name="Terminal" size={12} className={active ? 'shrink-0 opacity-80' : 'shrink-0 opacity-70'} />
      )}
      {mesh.member && ptyId && (
        <span
          title={`Mesh \u00b7 ${mesh.peers} ${mesh.peers === 1 ? 'peer' : 'peers'}`}
          aria-label={`Mesh \u00b7 ${mesh.peers} peers`}
          className="shrink-0 rounded-full"
          style={{ width: 4, height: 4, background: active ? 'currentColor' : accent, opacity: 0.9 }}
        />
      )}
      {meshState === 'awaiting-input' && (
        <span
          title="Awaiting input \u2014 blocked on a permission prompt"
          aria-label="Awaiting input"
          className="mesh-waiting-dot shrink-0 rounded-full"
          style={{ width: 5, height: 5, background: '#fbbf24' }}
        />
      )}
      {pending.count > 0 && (
        <span
          title={`${pending.count} queued message${pending.count === 1 ? '' : 's'} from ${pending.froms.join(', ')}`}
          className="shrink-0 rounded-pill px-1 text-[9px] leading-4 tabular-nums"
          style={{ background: 'rgba(251, 191, 36, 0.16)', color: '#fbbf24' }}
        >
          {`\u25be${pending.count}`}
        </span>
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
            'opacity-0 transition-opacity hover:bg-black/20',
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
 * Segmented tab strip inside a terminal panel: a rounded glass track with one pill per
 * terminal (tab) plus a "+" to spawn another in the SAME panel. Always visible so a new
 * terminal is one click away even when an agent is running in the active tab.
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
    <div className="mx-3 mb-2 mt-3 flex h-[30px] shrink-0 items-center gap-1 overflow-x-auto rounded-pill border border-glass px-1" style={{ background: 'var(--glass)' }}>
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
          'text-text-2 transition-[background,color,transform] duration-150 ease-settle',
          'hover:bg-glass-hover hover:text-text-1 active:scale-[0.96] focus-caliper',
        )}
      >
        <Icon name="Plus" size={14} />
      </button>
    </div>
  )
}
