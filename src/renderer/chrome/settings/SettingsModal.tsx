/**
 * The Settings modal — a glass sheet (760×564, rounded-[28px]) with a close button + search
 * field above a tight section rail (214px) on the left and the active section on the right.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useSettingsStore, type SettingsSection } from '@/stores/useSettingsStore'
import { Icon } from '@/design-system/Icon'
import { cn } from '@/lib/cn'
import { SECTIONS, SECTION_COMPONENTS, SETTINGS_INDEX } from './sections'

export function SettingsModal() {
  const open = useSettingsStore((s) => s.open)
  const section = useSettingsStore((s) => s.section)
  const setSection = useSettingsStore((s) => s.setSection)
  const setOpen = useSettingsStore((s) => s.setOpen)

  const [query, setQuery] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) {
      setQuery('')
      return
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, setOpen])

  useEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0
  }, [section, query])

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return null
    return SETTINGS_INDEX.filter(
      (e) => e.title.toLowerCase().includes(q) || e.keywords.toLowerCase().includes(q),
    )
  }, [query])

  if (!open) return null

  const Active = SECTION_COMPONENTS[section]
  const sectionLabel = (id: string): string => SECTIONS.find((s) => s.id === id)?.label ?? id

  return (
    <div
      className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center p-6"
      style={{ background: 'var(--scrim)' }}
      onPointerDown={() => setOpen(false)}
    >
      <div
        data-surface-layer="modal"
        className="animate-palette-in surface-layer surface-layer--modal flex h-[564px] max-h-[88vh] w-[760px] max-w-[94vw] flex-col overflow-hidden rounded-[28px]"
        onPointerDown={(e) => e.stopPropagation()}
      >
        {/* top row: close + search */}
        <div
          className="flex h-14 shrink-0 items-center gap-2.5 px-4"
          style={{ borderBottom: '1px solid var(--border-glass)' }}
        >
          <button
            type="button"
            aria-label="Close settings"
            onClick={() => setOpen(false)}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[12px] text-text-secondary transition-colors hover:bg-glass-hover hover:text-text-primary focus-caliper"
            style={{ background: 'var(--glass)' }}
          >
            <Icon name="X" size={15} />
          </button>
          <div
            className="flex h-[34px] min-w-0 flex-1 items-center gap-2.5 rounded-[11px] border border-glass px-3.5 transition-colors focus-within:border-glass-hover"
            style={{ background: 'var(--inset-soft)', boxShadow: '0 1px 6px rgba(0,0,0,0.5)' }}
          >
            <Icon name="Search" size={14} className="shrink-0 text-text-3" />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search"
              spellCheck={false}
              className="h-full w-full bg-transparent text-[13px] text-text-1 placeholder:text-text-3 focus:outline-none"
            />
          </div>
        </div>

        {/* body: rail + content */}
        <div className="flex min-h-0 flex-1">
          <aside
            className="flex w-[214px] shrink-0 flex-col gap-1 overflow-y-auto p-2.5"
            style={{ borderRight: '1px solid var(--border-glass)' }}
          >
            {SECTIONS.map((s) => {
              const active = !query && s.id === section
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => {
                    setSection(s.id)
                    setQuery('')
                  }}
                  className={cn(
                    'flex h-9 w-full shrink-0 items-center gap-2.5 rounded-[11px] px-[11px] text-left text-[13px] transition-colors',
                    active
                      ? 'bg-glass-hover font-medium text-text-1'
                      : 'text-text-2 hover:bg-glass hover:text-text-1',
                  )}
                >
                  <Icon name={s.icon} size={15} className="shrink-0" />
                  <span className="truncate">{s.label}</span>
                </button>
              )
            })}
          </aside>

          {/* content */}
          <div ref={contentRef} className="min-h-0 flex-1 overflow-y-auto">
            <div className="px-6 py-6">
              {results ? (
                <SearchResults
                  results={results}
                  sectionLabel={sectionLabel}
                  onPick={(id) => {
                    setSection(id)
                    setQuery('')
                  }}
                />
              ) : (
                <Active />
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function SearchResults({
  results,
  sectionLabel,
  onPick,
}: {
  results: { section: string; title: string }[]
  sectionLabel: (id: string) => string
  onPick: (id: SettingsSection) => void
}) {
  if (results.length === 0) {
    return <div className="py-12 text-center text-[13px] text-text-tertiary">No matching settings</div>
  }
  return (
    <>
      <h2 className="mb-2.5 text-[17px] font-semibold tracking-tightui text-text-1">
        {results.length} result{results.length === 1 ? '' : 's'}
      </h2>
      <div className="space-y-1">
        {results.map((r, i) => (
          <button
            key={`${r.section}:${r.title}:${i}`}
            type="button"
            onClick={() => onPick(r.section as SettingsSection)}
            className="flex w-full items-center justify-between gap-3 rounded-[11px] border border-glass px-3 py-2.5 text-left transition-colors hover:border-glass-hover hover:bg-glass"
          >
            <span className="text-[13px] text-text-1">{r.title}</span>
            <span className="flex items-center gap-1.5 text-[11px] text-text-3">
              {sectionLabel(r.section)}
              <Icon name="ArrowRight" size={12} />
            </span>
          </button>
        ))}
      </div>
    </>
  )
}
