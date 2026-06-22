import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useSpacesStore } from '@/stores/useSpacesStore'
import { usePanelStore } from '@/stores/usePanelStore'
import { switchSpace, createNewSpace, renameSpace, deleteSpace } from '@/app/workspaceActions'
import { SpacePreview } from './SpacePreview'
import { Icon } from '@/design-system/Icon'
import { cn } from '@/lib/cn'
import { MOD } from '@/lib/hotkeys'
import type { Space } from '@shared/domain/workspace'
import type { Panel } from '@shared/domain/panel'

const DROPDOWN_W = 360

/** Faint blueprint dot-grid behind a preview, echoing the canvas substrate. */
const GRID_BG: React.CSSProperties = {
  backgroundColor: 'var(--surface-inset)',
  backgroundImage: 'radial-gradient(circle, rgba(255,255,255,0.10) 0.5px, transparent 0.6px)',
  backgroundSize: '7px 7px',
}

/**
 * Per-workspace accent — a curated, muted palette so the switcher carries a little colour
 * while staying classy on the dark warm-neutral ground. Stable per workspace (hashed from
 * its id), and kept clear of pure red so it never reads as a destructive/armed state.
 */
const SPACE_HUES = ['#E3A65C', '#E58C7A', '#B7A2EC', '#6FC4B5', '#7FB2E6', '#B4CC82', '#E48FC6', '#D9C56A']
function spaceColor(id: string): string {
  let h = 0
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return SPACE_HUES[h % SPACE_HUES.length]
}
/** `color` mixed with transparency — for tints + outlines. */
function tint(color: string, pct: number): string {
  return `color-mix(in srgb, ${color} ${pct}%, transparent)`
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

  const triggerRef = useRef<HTMLButtonElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const [query, setQuery] = useState('')
  const [sel, setSel] = useState(0)
  const [editingId, setEditingId] = useState<string | null>(null)

  const active = spaces.find((s) => s.id === activeId) ?? spaces[0]

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
    if (r) setPos({ left: Math.min(r.left, window.innerWidth - DROPDOWN_W - 8), top: r.bottom + 8 })
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
          'app-no-drag flex shrink-0 items-center gap-2 rounded-md border px-2 py-1 transition-colors',
          open ? 'border-strong bg-accent-soft' : 'border-subtle hover:border-default hover:bg-accent-soft',
        )}
      >
        <Icon name="LayoutGrid" size={14} className="text-text-secondary" />
        <span
          className="max-w-[150px] truncate text-[12px] font-medium"
          style={{ color: active ? spaceColor(active.id) : 'var(--text-primary)' }}
        >
          {active?.name ?? 'Workspaces'}
        </span>
        <span
          className="rounded-pill px-1.5 font-mono text-[10px] text-text-tertiary"
          style={{ background: 'var(--surface-3)' }}
        >
          {spaces.length}
        </span>
        <Icon
          name="ChevronDown"
          size={13}
          className={cn('text-text-tertiary transition-transform duration-200', open && 'rotate-180')}
        />
      </button>

      {open &&
        pos &&
        createPortal(
          <div className="fixed inset-0 z-[55]" onPointerDown={close}>
            <div
              className="animate-palette-in absolute flex flex-col overflow-hidden rounded-2xl border border-strong shadow-overlay"
              style={{
                left: pos.left,
                top: pos.top,
                width: DROPDOWN_W,
                background: 'color-mix(in srgb, var(--bg-base) 94%, transparent)',
                backdropFilter: 'blur(20px)',
              }}
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
  onHover: () => void
  onSwitch: () => void
  onStartRename: () => void
  onEndRename: () => void
}) {
  const [draft, setDraft] = useState(space.name)

  const panels: Panel[] = isActive ? Object.values(livePanels) : space.panels
  const agents = panels.filter((p) => p.type === 'terminal' || p.type === 'agent').length
  // Each workspace owns its OWN folder (or none) — surface it so they read as independent projects.
  const folder = space.folderPath ? space.folderPath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || space.folderPath : 'No folder'
  const counts = `${panels.length} panel${panels.length === 1 ? '' : 's'}${agents > 0 ? ` · ${agents} agent${agents === 1 ? '' : 's'}` : ''}`
  const meta = `${folder} · ${counts}`
  const color = spaceColor(space.id)

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
      className="group relative flex cursor-pointer items-center gap-2.5 rounded-xl border px-2 py-1.5 transition-colors"
      style={{
        borderColor: selected ? color : isActive ? tint(color, 50) : 'transparent',
        background: selected ? tint(color, 12) : isActive ? tint(color, 6) : 'transparent',
      }}
    >
      <span
        className="ml-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md font-mono text-[10px]"
        style={{ color, background: tint(color, 14) }}
      >
        {index + 1}
      </span>

      <span
        className="relative shrink-0 overflow-hidden rounded-lg border border-subtle"
        style={{ width: 66, height: 42, ...GRID_BG }}
      >
        <SpacePreview panels={panels} width={66} height={42} radius={2} />
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
              <span className="truncate text-[12.5px] font-medium" style={{ color }}>
                {space.name}
              </span>
              {isActive && <Icon name="Check" size={12} className="shrink-0" style={{ color }} />}
            </span>
            <span className="mt-0.5 block font-mono text-[9.5px] uppercase tracking-wider text-text-quaternary">
              {meta}
            </span>
          </>
        )}
      </span>

      {!editing && (
        <div className="flex shrink-0 items-center gap-0.5 pr-0.5 opacity-0 transition-opacity group-hover:opacity-100">
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
