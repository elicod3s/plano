import { useEffect, useMemo, useRef, useState } from 'react'
import { PANEL_META } from '@shared/domain/panel'
import { useUiStore } from '@/stores/useUiStore'
import { usePanelStore } from '@/stores/usePanelStore'
import { useViewportStore } from '@/stores/useViewportStore'
import { useSpacesStore } from '@/stores/useSpacesStore'
import { Icon } from '@/design-system/Icon'
import { switchSpace } from '@/app/workspaceActions'
import { COMMANDS, primaryShortcut, type CommandGroup } from '@/app/commands'
import { cn } from '@/lib/cn'
import { fmtKeys } from '@/lib/hotkeys'

type Section = 'Open panels' | 'Workspaces' | 'Commands' | 'New panel'

interface Cmd {
  id: string
  label: string
  section: Section
  icon: string
  shortcut?: string
  hint?: string
  run: () => void
}

/** Map a registry command's group to the palette section it shows under. */
const sectionForGroup = (g: CommandGroup): Section =>
  g === 'Create' ? 'New panel' : g === 'Workspace' ? 'Workspaces' : 'Commands'

export function CommandPalette() {
  const open = useUiStore((s) => s.commandPaletteOpen)
  const setOpen = useUiStore((s) => s.setCommandPalette)
  const panels = usePanelStore((s) => s.panels)
  const bringToFront = usePanelStore((s) => s.bringToFront)
  const spaces = useSpacesStore((s) => s.spaces)
  const activeId = useSpacesStore((s) => s.activeId)

  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const focusPanel = (id: string): void => {
    const panel = usePanelStore.getState().panels[id]
    if (!panel) return
    bringToFront(id)
    const { zoom } = useViewportStore.getState()
    const cx = panel.rect.x + panel.rect.width / 2
    const cy = panel.rect.y + panel.rect.height / 2
    useViewportStore.getState().setTransform({
      x: window.innerWidth / 2 - cx * zoom,
      y: window.innerHeight / 2 - cy * zoom,
    })
  }

  const items = useMemo<Cmd[]>(() => {
    const openPanels: Cmd[] = Object.values(panels)
      .sort((a, b) => b.z - a.z)
      .map((p) => ({
        id: `panel:${p.id}`,
        label: p.title,
        section: 'Open panels',
        icon: PANEL_META[p.type].icon,
        hint: p.type,
        run: () => focusPanel(p.id),
      }))

    const spaceSwitch: Cmd[] = spaces.map((s, i) => ({
      id: `ws:${s.id}`,
      label: s.id === activeId ? `${s.name} (current)` : `Switch to ${s.name}`,
      section: 'Workspaces',
      icon: 'LayoutGrid',
      hint: `${s.panels.length} panels`,
      shortcut: i < 9 ? `Ctrl+${i + 1}` : undefined,
      run: () => switchSpace(s.id),
    }))

    const fromRegistry = (group: CommandGroup): Cmd[] =>
      COMMANDS.filter((c) => c.group === group && c.id !== 'app:palette').map((c) => ({
        id: c.id,
        label: c.label,
        section: sectionForGroup(c.group),
        icon: c.icon,
        shortcut: primaryShortcut(c),
        run: c.run,
      }))

    return [
      ...openPanels,
      ...spaceSwitch,
      ...fromRegistry('Workspace'),
      ...fromRegistry('View'),
      ...fromRegistry('App'),
      ...fromRegistry('Create'),
    ]
  }, [panels, spaces, activeId]) // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return items
    return items.filter((i) => i.label.toLowerCase().includes(q) || i.hint?.toLowerCase().includes(q))
  }, [items, query])

  useEffect(() => setIndex(0), [query, open])
  useEffect(() => {
    if (open) requestAnimationFrame(() => inputRef.current?.focus())
    else setQuery('')
  }, [open])

  if (!open) return null

  const choose = (i: number): void => {
    const item = filtered[i]
    if (!item) return
    setOpen(false)
    item.run()
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setIndex((n) => Math.min(filtered.length - 1, n + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setIndex((n) => Math.max(0, n - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      choose(index)
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  let lastSection = ''

  return (
    <div className="fixed inset-0 z-[var(--z-modal)] flex items-start justify-center pt-[14vh]" style={{ background: 'var(--scrim)' }} onPointerDown={() => setOpen(false)}>
      <div
        data-surface-layer="popover"
        className="animate-palette-in surface-layer surface-layer--popover w-[620px] max-w-[92vw] overflow-hidden rounded-[24px]"
        onPointerDown={(e) => e.stopPropagation()}
      >
        {/* search row */}
        <div className="flex h-14 items-center gap-3 px-[18px]">
          <Icon name="Search" size={17} className="shrink-0 text-text-3" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search files, terminals, commands…"
            spellCheck={false}
            className="h-full flex-1 bg-transparent text-[15.5px] text-text-1 placeholder:text-text-3 focus:outline-none"
          />
          <span
            className="flex h-[22px] shrink-0 items-center rounded-[7px] border border-glass px-2 font-mono text-[10.5px] text-text-3"
            style={{ background: 'rgba(0,0,0,0.2)' }}
          >
            esc
          </span>
        </div>

        <div className="h-px w-full bg-[rgba(255,255,255,0.08)]" />

        {/* list */}
        <div className="max-h-[52vh] overflow-y-auto p-1.5">
          {filtered.length === 0 && (
            <div className="px-3 py-8 text-center text-[13px] text-text-tertiary">No matches</div>
          )}
          {filtered.map((item, i) => {
            const showSection = item.section !== lastSection
            lastSection = item.section
            return (
              <div key={item.id}>
                {showSection && (
                  <div className="flex h-6 items-center px-3 font-mono text-[10.5px] font-medium uppercase tracking-[0.08em] text-text-4">
                    {item.section}
                  </div>
                )}
                <button
                  type="button"
                  onMouseMove={() => setIndex(i)}
                  onClick={() => choose(i)}
                  className={cn(
                    'relative flex h-10 w-full items-center gap-3 rounded-[11px] px-3 text-left',
                    i === index ? 'bg-glass-hover' : 'hover:bg-glass',
                  )}
                >
                  {i === index && (
                    <span className="absolute left-0 top-1/2 h-[18px] w-[2px] -translate-y-1/2 rounded-pill bg-accent" />
                  )}
                  <Icon name={item.icon} size={16} className="shrink-0 text-text-2" />
                  <span className="flex-1 truncate text-[13.5px] text-text-1">{item.label}</span>
                  {item.hint && <span className="font-mono text-[10.5px] text-text-4">{item.hint}</span>}
                  {item.shortcut && <span className="font-mono text-[10.5px] text-text-3">{fmtKeys(item.shortcut)}</span>}
                </button>
              </div>
            )
          })}
        </div>

        {/* footer */}
        <div
          className="flex h-[42px] items-center gap-4 px-[18px] font-mono text-[11px] text-text-4"
          style={{ borderTop: '1px solid var(--border-glass)' }}
        >
          <span>↑↓ Navigate</span>
          <span>↵ Select</span>
          <span>esc Close</span>
        </div>
      </div>
    </div>
  )
}
