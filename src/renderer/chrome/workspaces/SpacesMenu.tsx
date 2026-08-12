import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useSpacesStore } from '@/stores/useSpacesStore'
import { usePanelStore } from '@/stores/usePanelStore'
import { useWorkspaceAgentSummaries, type WorkspaceAgentSummary } from '@/app/agentRoster'
import { AgentLogo } from '@/panels/terminal/AgentLogo'
import { AGENTS } from '@shared/domain/agent'
import { SPACE_COLORS, spaceColorFor, type SpaceColor } from '@shared/domain/workspace'
import { setSpaceColor } from '@/app/workspaceActions'
import { switchSpace, createNewSpace, renameSpace, deleteSpace } from '@/app/workspaceActions'
import { SpacePreview } from './SpacePreview'
import { Icon } from '@/design-system/Icon'
import { cn } from '@/lib/cn'
import { MOD } from '@/lib/hotkeys'
import type { Space } from '@shared/domain/workspace'
import type { Panel } from '@shared/domain/panel'

/** Wide enough that a workspace's folder AND its panel count both fit unabbreviated. */
const DROPDOWN_W = 420

/** Faint blueprint dot-grid behind a preview, echoing the canvas substrate. */
const GRID_BG: React.CSSProperties = {
  backgroundColor: 'var(--surface-inset)',
  backgroundImage: 'radial-gradient(circle, rgba(255,255,255,0.10) 0.5px, transparent 0.6px)',
  backgroundSize: '7px 7px',
}


/**
 * Workspace switcher: a compact top-bar trigger that opens a floating launcher of all
 * workspaces. Each row is an instrument-like card — a blueprint mini-preview, a mono
 * index that maps to its Ctrl+N shortcut, the name, and a panel/agent readout. Doubles
 * as a command surface (type to filter, ↑↓ to move, ↵ to switch). Portaled to <body> so
 * it floats free of the header. Selection uses soft fill + a datum rail, never a hard ring.
 */
export function SpacesMenu() {
  const spaces = useSpacesStore((s) => s.spaces)
  const activeId = useSpacesStore((s) => s.activeId)
  const livePanels = usePanelStore((s) => s.panels)
  // v4 awareness: derived per-workspace agent counts (never the panel list).
  const summaries = useWorkspaceAgentSummaries()

  const triggerRef = useRef<HTMLButtonElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const [query, setQuery] = useState('')
  const [sel, setSel] = useState(0)
  const [editingId, setEditingId] = useState<string | null>(null)

  const active = spaces.find((s) => s.id === activeId) ?? spaces[0]
  // The chip mirrors the active workspace: its live panels for the schematic, and whether
  // anything inside it is working or blocked.
  const activePanels = useMemo(() => Object.values(livePanels), [livePanels])
  const chipSummary = active ? summaries.get(active.id) : undefined
  const chipBusy: 'waiting' | 'working' | null =
    chipSummary && chipSummary.awaiting > 0 ? 'waiting' : chipSummary && chipSummary.working > 0 ? 'working' : null

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? spaces.filter((s) => s.name.toLowerCase().includes(q)) : spaces
  }, [spaces, query])

  const close = (): void => {
    setOpen(false)
    setEditingId(null)
  }

  useLayoutEffect(() => {
    if (!open) return
    const r = triggerRef.current?.getBoundingClientRect()
    if (r) setPos({ left: Math.min(r.left, window.innerWidth - DROPDOWN_W - 12), top: r.bottom + 12 })
    setQuery('')
    const idx = spaces.findIndex((s) => s.id === activeId)
    setSel(idx < 0 ? 0 : idx)
    requestAnimationFrame(() => inputRef.current?.focus())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    if (!open) return
    const onResize = (): void => close()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [open])

  useEffect(() => {
    if (sel > filtered.length - 1) setSel(Math.max(0, filtered.length - 1))
  }, [filtered.length, sel])

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (editingId) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSel((n) => Math.min(filtered.length - 1, n + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSel((n) => Math.max(0, n - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const t = filtered[sel]
      if (t) {
        switchSpace(t.id)
        close()
      }
    } else if (e.key === 'Escape') {
      e.preventDefault()
      close()
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Switch workspace"
        className={cn(
          'app-no-drag flex h-7 shrink-0 items-center gap-2 rounded-pill border border-glass px-2.5 transition-colors',
          open ? 'border-glass-hover bg-glass-hover' : 'hover:border-glass-hover hover:bg-glass',
        )}
      >
        {/* The chip wears the workspace's OWN schematic, tinted with its colour — the same object
            the menu shows, shrunk. It replaces the status dot entirely: identity and activity in
            one mark, instead of a pill with a coloured circle bolted on. */}
        {active && (
          <span
            className={cn(
              'relative -ml-0.5 shrink-0 overflow-hidden rounded-[4px] border border-subtle',
              chipBusy === 'waiting' && 'ws-blocked',
            )}
            style={{ width: 20, height: 13 }}
            title={chipBusy === 'waiting' ? 'Waiting for you' : chipBusy === 'working' ? 'Working' : undefined}
          >
            <SpacePreview
              panels={activePanels}
              width={20}
              height={13}
              radius={1.5}
              color={chipBusy === 'waiting' ? '#fbbf24' : spaceColorFor(active)}
              active={chipBusy !== null}
            />
          </span>
        )}
        <span className="max-w-[140px] truncate text-[13px] text-text-1">
          {active?.name ?? 'Workspaces'}
        </span>
        <Icon
          name="ChevronDown"
          size={13}
          className={cn('text-text-3 transition-transform duration-200', open && 'rotate-180')}
        />
      </button>

      {open &&
        pos &&
        createPortal(
          <div className="fixed inset-0 z-[var(--z-popover)]" onPointerDown={close}>
            <div
              data-surface-layer="popover"
              className="animate-palette-in surface-layer surface-layer--popover absolute flex flex-col overflow-hidden rounded-[18px] py-1"
              style={{ left: pos.left, top: pos.top, width: DROPDOWN_W }}
              onPointerDown={(e) => e.stopPropagation()}
            >
              {/* search / command field */}
              <div className="flex items-center gap-2.5 px-3.5 pb-2 pt-3">
                <Icon name="Search" size={14} className="text-text-tertiary" />
                <input
                  ref={inputRef}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={onKeyDown}
                  placeholder="Switch or search workspace…"
                  spellCheck={false}
                  className="h-5 flex-1 bg-transparent text-[13px] text-text-primary placeholder:text-text-tertiary focus:outline-none"
                />
                <span className="font-mono text-[10px] text-text-quaternary">esc</span>
              </div>

              <div className="flex items-center justify-between px-4 pb-1 pt-0.5">
                <span className="label-caps">Workspaces</span>
                <span className="font-mono text-[10px] text-text-quaternary">
                  {String(spaces.length).padStart(2, '0')}
                </span>
              </div>

              <div className="max-h-[48vh] overflow-y-auto px-1.5 pb-1.5">
                {filtered.length === 0 && (
                  <div className="px-3 py-6 text-center text-[12px] text-text-tertiary">No workspaces match</div>
                )}
                {filtered.map((space, i) => (
                  <SpaceRow
                    key={space.id}
                    space={space}
                    // Badge shows the canonical slot (matches Ctrl+1–9 + the name), not the filtered row.
                    index={spaces.indexOf(space)}
                    isActive={space.id === activeId}
                    selected={i === sel}
                    livePanels={livePanels}
                    // v4 awareness: derived real counts (never the raw panel list).
                    summary={summaries.get(space.id)}
                    // Always deletable: removing the final workspace closes the whole project.
                    canDelete={true}
                    editing={editingId === space.id}
                    onHover={() => setSel(i)}
                    onSwitch={() => {
                      switchSpace(space.id)
                      close()
                    }}
                    onStartRename={() => setEditingId(space.id)}
                    onEndRename={() => setEditingId(null)}
                  />
                ))}
              </div>

              {/* footer action */}
              <button
                type="button"
                onClick={() => {
                  createNewSpace()
                  close()
                }}
                className="flex items-center gap-2.5 border-t border-subtle px-3.5 py-3 text-[12.5px] text-text-secondary transition-colors hover:bg-accent-soft hover:text-text-primary"
              >
                <span className="flex h-6 w-6 items-center justify-center rounded-md border border-dashed border-default">
                  <Icon name="Plus" size={13} />
                </span>
                New workspace
                <span className="ml-auto font-mono text-[10px] text-text-quaternary">{MOD} N</span>
              </button>

              <div className="flex items-center gap-3.5 border-t border-subtle bg-surface-2 px-4 py-2 font-mono text-[10px] text-text-quaternary">
                <span>↑↓ Move</span>
                <span>↵ Switch</span>
                <span>{MOD} 1–9 Jump</span>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}

function SpaceRow({
  space,
  index,
  isActive,
  selected,
  livePanels,
  canDelete,
  editing,
  summary,
  onHover,
  onSwitch,
  onStartRename,
  onEndRename,
}: {
  space: Space
  index: number
  isActive: boolean
  selected: boolean
  livePanels: Record<string, Panel>
  canDelete: boolean
  editing: boolean
  /** Which harnesses live in this workspace + how many are busy/blocked (mesh snapshot). */
  summary?: WorkspaceAgentSummary
  onHover: () => void
  onSwitch: () => void
  onStartRename: () => void
  onEndRename: () => void
}) {
  const [draft, setDraft] = useState(space.name)
  const [hovered, setHovered] = useState(false)

  const panels: Panel[] = isActive ? Object.values(livePanels) : space.panels
  // Each workspace owns its OWN folder (or none) — surface it so they read as independent projects.
  const folder = space.folderPath ? space.folderPath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || space.folderPath : 'No folder'
  const rail = spaceColorFor(space)
  const busy: 'waiting' | 'working' | null =
    summary && summary.awaiting > 0 ? 'waiting' : summary && summary.working > 0 ? 'working' : null

  const commit = (): void => {
    if (draft.trim()) renameSpace(space.id, draft)
    onEndRename()
  }

  return (
    <div
      role="option"
      aria-selected={selected}
      onMouseMove={onHover}
      onClick={() => {
        if (!editing) onSwitch()
      }}
      className={cn(
        'group relative flex cursor-pointer items-center gap-2.5 rounded-xl border px-2 py-1.5',
        'motion-safe:transition-[background,border-color] motion-safe:duration-200 motion-safe:ease-out',
        selected || isActive ? 'border-glass' : 'border-transparent',
      )}
      style={{
        // Apple's material tint: the colour arrives as a soft wash from the leading edge and
        // fades out well before the right side — a shade the row wears, never a filled block.
        // Hover reveals it; selection holds it. Idle rows stay clean.
        backgroundImage: `linear-gradient(90deg, color-mix(in srgb, ${rail} ${
          selected ? 18 : isActive ? 14 : hovered ? 11 : 7
        }%, transparent) 0%, color-mix(in srgb, ${rail} ${selected ? 7 : 4}%, transparent) 44%, transparent 80%)`,
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Identity rail — the user's OWN label colour (Finder-tag semantics), or a neutral
          hairline when untagged. This is what tells two workspaces apart at a glance; it is
          chosen, never derived from an id, so it always means whatever the user decided. */}
      {/* The Ctrl+N affordance, quiet: a number is wayfinding, not decoration. */}
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-glass font-mono text-[10px] text-text-tertiary">
        {index + 1}
      </span>

      {/* The schematic IS the workspace's identity — its layout signature, in its own hue. That
          is what tells two rows apart; no badge, no coloured line beside the row. While work is
          in flight it glows a little brighter, so activity is the same object simply more awake. */}
      <span
        className={cn(
          'relative shrink-0 overflow-hidden rounded-lg border border-subtle',
          busy === 'waiting' && 'ws-blocked',
        )}
        style={{ width: 66, height: 42, ...GRID_BG }}
        title={busy === 'waiting' ? 'Waiting for you' : busy === 'working' ? 'Working' : undefined}
      >
        <SpacePreview panels={panels} width={66} height={42} radius={2} color={rail} active={busy !== null} />
      </span>

      <span className="min-w-0 flex-1">
        {editing ? (
          <input
            autoFocus
            value={draft}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') commit()
              else if (e.key === 'Escape') onEndRename()
            }}
            className="w-full rounded-sm border border-strong bg-transparent px-1.5 py-0.5 text-[12.5px] text-text-primary focus:outline-none"
          />
        ) : (
          <>
            <span className="flex items-center gap-1.5">
              <span className="truncate text-[12.5px] font-medium text-text-primary">{space.name}</span>
              {isActive && <Icon name="Check" size={12} className="shrink-0 text-text-tertiary" />}
            </span>
            {/* WHO is in there, as brand marks — a row of names never told the user that a
                workspace has a Claude and a Codex in it. Colour lives here (each mark is its own)
                and in the state pill; nowhere else. */}
            <span className="mt-1 flex items-center gap-1.5">
              {/* Stacked marks + a tabular count: Apple's avatar-group idiom. The overlap says
                  "these belong together" and the numeral says how many, without a badge. */}
              {/* ONE mark per agent, overlapped, with a +N chip when they overflow — Apple's
                  avatar group. A bare numeral beside the folder read as "3 Plano"; counting
                  marks cannot be misread, and repeated logos also say WHICH harness repeats. */}
              {summary && summary.total > 0 && (
                <span className="mr-1 flex shrink-0 items-center -space-x-1">
                  {summary.each.slice(0, 4).map((k, i) => (
                    <span
                      key={`${k}-${i}`}
                      className="flex h-[15px] w-[15px] items-center justify-center rounded-full border border-[var(--surface-2)] bg-surface-3"
                      title={AGENTS[k].displayName}
                    >
                      <AgentLogo kind={k} size={9} color={AGENTS[k].accent} />
                    </span>
                  ))}
                  {summary.each.length > 4 && (
                    <span
                      className="flex h-[15px] items-center justify-center rounded-full border border-[var(--surface-2)] bg-surface-3 px-1 font-mono text-[8.5px] tabular-nums text-text-tertiary"
                      title={`${summary.total} agents`}
                    >
                      +{summary.each.length - 4}
                    </span>
                  )}
                </span>
              )}
              {/* Only the FOLDER shrinks. The panel count is the fact the row exists to state, so
                  it is shrink-0 and can never end up as "2 pan…". */}
              <span className="min-w-0 truncate font-mono text-[9.5px] text-text-quaternary">{folder}</span>
              <span className="shrink-0 font-mono text-[9.5px] text-text-quaternary">
                · {panels.length} panel{panels.length === 1 ? '' : 's'}
              </span>

            </span>
          </>
        )}
      </span>

      {/* Trailing accessory: progress at rest, controls on hover — the same slot, never both. */}
      {!editing && busy && (
        <span className="shrink-0 pr-0.5 transition-opacity group-hover:opacity-0">
          <WorkIndicator state={busy} />
        </span>
      )}

      {!editing && (
        <div
          className={cn(
            'flex shrink-0 items-center gap-0.5 pr-0.5 opacity-0 transition-opacity group-hover:opacity-100',
            busy && 'absolute right-2',
          )}
        >
          <ColorPicker space={space} />
          <button
            type="button"
            aria-label="Rename workspace"
            onClick={(e) => {
              e.stopPropagation()
              setDraft(space.name)
              onStartRename()
            }}
            className="flex h-6 w-6 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-accent-soft hover:text-text-primary"
          >
            <Icon name="Pencil" size={12} />
          </button>
          {canDelete && (
            <button
              type="button"
              aria-label="Delete workspace"
              onClick={(e) => {
                e.stopPropagation()
                void deleteSpace(space.id)
              }}
              className="flex h-6 w-6 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-destructive hover:text-white"
            >
              <Icon name="Trash2" size={12} />
            </button>
          )}
        </div>
      )}
    </div>
  )
}


/**
 * The workspace label picker: seven curated tags plus "none". Deliberately tiny and only on
 * hover — tagging is an occasional act, and a palette permanently on screen would put more
 * colour in the menu than the workspaces themselves.
 */
function ColorPicker({ space }: { space: Space }) {
  const [open, setOpen] = useState(false)
  return (
    <span className="relative flex">
      <button
        type="button"
        aria-label="Workspace colour"
        onClick={(e) => {
          e.stopPropagation()
          setOpen((v) => !v)
        }}
        className="flex h-6 w-6 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-accent-soft hover:text-text-primary"
      >
        <span
          className="h-2.5 w-2.5 rounded-full border border-glass"
          style={{ background: space.color ? SPACE_COLORS[space.color] : 'transparent' }}
        />
      </button>
      {open && (
        <span
          data-surface-layer="popover"
          className="surface-layer surface-layer--popover animate-menu-in absolute right-0 top-7 z-10 flex items-center gap-1 rounded-[12px] p-1.5"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            aria-label="No colour"
            onClick={() => {
              setSpaceColor(space.id, undefined)
              setOpen(false)
            }}
            className="h-4 w-4 rounded-full border border-strong"
          />
          {(Object.keys(SPACE_COLORS) as SpaceColor[]).map((key) => (
            <button
              key={key}
              type="button"
              aria-label={key}
              title={key}
              onClick={() => {
                setSpaceColor(space.id, key)
                setOpen(false)
              }}
              className="h-4 w-4 rounded-full transition-transform hover:scale-110"
              style={{ background: SPACE_COLORS[key] }}
            />
          ))}
        </span>
      )}
    </span>
  )
}




/**
 * Work indicator — a thin turning arc plus the word, the indeterminate progress idiom Apple uses
 * when something is running and nobody knows for how long. When an agent is BLOCKED the arc stops
 * and closes into a full amber ring: motion means running, stillness means it needs you, so both
 * states share one shape instead of two unrelated badges.
 */
function WorkIndicator({ state }: { state: 'working' | 'waiting' }) {
  const waiting = state === 'waiting'
  const color = waiting ? '#fbbf24' : 'var(--text-secondary)'
  return (
    <span className="flex items-center gap-1.5" title={waiting ? 'Waiting for you' : 'Working'}>
      <svg width="12" height="12" viewBox="0 0 12 12" className={cn(!waiting && 'ws-spin')} aria-hidden>
        <circle cx="6" cy="6" r="4.6" fill="none" stroke={color} strokeWidth="1.4" opacity={waiting ? 1 : 0.22} />
        {!waiting && (
          <circle
            cx="6"
            cy="6"
            r="4.6"
            fill="none"
            stroke={color}
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeDasharray="8 21"
          />
        )}
      </svg>
      <span className="font-mono text-[9.5px]" style={{ color }}>
        {waiting ? 'waiting' : 'working'}
      </span>
    </span>
  )
}
