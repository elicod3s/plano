import { useEffect, useMemo, useRef, useState } from 'react'
import { PANEL_META, type PanelType } from '@shared/domain/panel'
import { useUiStore } from '@/stores/useUiStore'
import { usePanelStore } from '@/stores/usePanelStore'
import { useViewportStore } from '@/stores/useViewportStore'
import { useSpacesStore } from '@/stores/useSpacesStore'
import { Icon } from '@/design-system/Icon'
import { addPanelAtCenter, zoomToFitAll } from '@/app/actions'
import { openFolder, saveCurrent, switchSpace, createNewSpace } from '@/app/workspaceActions'
import { cn } from '@/lib/cn'

interface Cmd {
  id: string
  label: string
  section: 'Open panels' | 'Workspaces' | 'Commands' | 'New panel'
  icon: string
  shortcut?: string
  hint?: string
  run: () => void
}

const CREATE_ORDER: PanelType[] = [
  'terminal', 'editor', 'browser', 'agent', 'git', 'markdown', 'sticky', 'voice', 'region', 'label',
]

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

    const commands: Cmd[] = [
      { id: 'cmd:open', label: 'Open Folder…', section: 'Commands', icon: 'FolderOpen', shortcut: 'Ctrl+O', run: () => void openFolder() },
      { id: 'cmd:save', label: 'Save Workspace', section: 'Commands', icon: 'Save', shortcut: 'Ctrl+S', run: () => void saveCurrent() },
      { id: 'cmd:fit', label: 'Zoom to Fit', section: 'Commands', icon: 'Maximize2', shortcut: 'Ctrl+Shift+F', run: () => zoomToFitAll() },
      { id: 'cmd:reset', label: 'Reset Zoom', section: 'Commands', icon: 'Search', shortcut: 'Ctrl+0', run: () => useViewportStore.getState().zoomTo(1, { width: window.innerWidth, height: window.innerHeight }) },
    ]

    const workspaces: Cmd[] = spaces.map((s, i) => ({
      id: `ws:${s.id}`,
      label: s.id === activeId ? `${s.name} (current)` : `Switch to ${s.name}`,
      section: 'Workspaces',
      icon: 'LayoutGrid',
      hint: `${s.panels.length} panels`,
      shortcut: i < 9 ? `Ctrl+${i + 1}` : undefined,
      run: () => switchSpace(s.id),
    }))
    workspaces.push({
      id: 'ws:new',
      label: 'New Workspace',
      section: 'Workspaces',
      icon: 'Plus',
      run: () => createNewSpace(),
    })

    const create: Cmd[] = CREATE_ORDER.map((type) => ({
      id: `new:${type}`,
      label: PANEL_META[type].label,
      section: 'New panel',
      icon: PANEL_META[type].icon,
      run: () => addPanelAtCenter(type),
    }))

    return [...openPanels, ...workspaces, ...commands, ...create]
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
    <div className="fixed inset-0 z-[60] flex items-start justify-center pt-[14vh]" style={{ background: 'var(--scrim)', backdropFilter: 'blur(16px)' }} onPointerDown={() => setOpen(false)}>
      <div
        className="animate-palette-in w-[640px] max-w-[92vw] overflow-hidden rounded-xl border border-strong shadow-overlay"
        style={{ background: 'color-mix(in srgb, var(--bg-base) 96%, transparent)' }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="flex h-[52px] items-center gap-3 border-b border-subtle px-4">
          <Icon name="Search" size={18} className="text-text-tertiary" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search files, terminals, commands…"
            spellCheck={false}
            className="h-full flex-1 bg-transparent text-[16px] text-text-primary placeholder:text-text-tertiary focus:outline-none"
          />
          <span className="font-mono text-[11px] text-text-tertiary">esc</span>
        </div>

        <div className="max-h-[52vh] overflow-y-auto p-1.5">
          {filtered.length === 0 && (
            <div className="px-3 py-8 text-center text-[13px] text-text-tertiary">No matches</div>
          )}
          {filtered.map((item, i) => {
            const showSection = item.section !== lastSection
            lastSection = item.section
            return (
              <div key={item.id}>
                {showSection && <div className="label-caps px-2 pb-1 pt-2">{item.section}</div>}
                <button
                  type="button"
                  onMouseMove={() => setIndex(i)}
                  onClick={() => choose(i)}
                  className={cn(
                    'flex h-10 w-full items-center gap-3 rounded-sm px-2.5 text-left',
                    i === index ? 'bg-accent-soft' : 'hover:bg-accent-soft/60',
                  )}
                >
                  {i === index && <span className="absolute left-0 h-6 w-[2px] rounded-pill bg-accent" />}
                  <Icon name={item.icon} size={16} className="text-text-secondary" />
                  <span className="flex-1 text-[14px] text-text-primary">{item.label}</span>
                  {item.hint && <span className="font-mono text-[11px] text-text-tertiary">{item.hint}</span>}
                  {item.shortcut && <span className="font-mono text-[11px] text-text-tertiary">{item.shortcut}</span>}
                </button>
              </div>
            )
          })}
        </div>

        <div className="flex h-9 items-center gap-4 border-t border-subtle bg-surface-2 px-4 font-mono text-[11px] text-text-tertiary">
          <span>↑↓ Navigate</span>
          <span>↵ Select</span>
          <span>esc Close</span>
        </div>
      </div>
    </div>
  )
}
