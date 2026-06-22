/**
 * The Settings modal — a compact, focused panel: a close button + search sit above a tight
 * section rail on the left, the active section on the right. Deliberately minimal (no heavy
 * title bar, solid active item, sentence-case headers) so it reads clean and unmistakably
 * PLANO rather than a heavier preferences dialog.
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

  // Reset scroll to top whenever the section (or search state) changes.
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
      className="fixed inset-0 z-[60] flex items-center justify-center p-6"
      style={{ background: 'var(--scrim)', backdropFilter: 'blur(14px)' }}
      onPointerDown={() => setOpen(false)}
    >
      <div
        className="animate-palette-in flex h-[580px] max-h-[88vh] w-[760px] max-w-[94vw] overflow-hidden rounded-xl border border-strong shadow-overlay"
        style={{ background: 'var(--bg-base)' }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        {/* ── rail ── */}
        <aside className="flex w-[208px] shrink-0 flex-col border-r border-subtle bg-surface-1">
          <div className="flex items-center gap-2 p-2.5">
            <button
              type="button"
              aria-label="Close settings"
              onClick={() => setOpen(false)}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-surface-3 text-text-secondary transition-colors hover:bg-surface-4 hover:text-text-primary focus-caliper"
            >
              <Icon name="X" size={15} />
            </button>
            <div className="flex h-8 flex-1 items-center gap-1.5 rounded-md border border-default bg-surface-inset px-2.5">
              <Icon name="Search" size={13} className="shrink-0 text-text-tertiary" />
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search"
                spellCheck={false}
                className="h-full w-full bg-transparent text-[12px] text-text-primary placeholder:text-text-tertiary focus:outline-none"
              />
            </div>
          </div>
          <nav className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">
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
                    'flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-[13px] transition-colors',
                    active
                      ? 'bg-surface-3 font-medium text-text-primary'
                      : 'text-text-secondary hover:bg-surface-2 hover:text-text-primary',
                  )}
                >
                  <Icon name={s.icon} size={16} className="shrink-0" />
                  <span className="truncate">{s.label}</span>
                </button>
              )
            })}
          </nav>
        </aside>

        {/* ── content ── */}
        <div ref={contentRef} className="min-h-0 flex-1 overflow-y-auto">
          <div className="px-6 py-5">
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
      <h2 className="mb-2.5 text-[15px] font-semibold tracking-tightui text-text-primary">
        {results.length} result{results.length === 1 ? '' : 's'}
      </h2>
      <div className="space-y-1">
        {results.map((r, i) => (
          <button
            key={`${r.section}:${r.title}:${i}`}
            type="button"
            onClick={() => onPick(r.section as SettingsSection)}
            className="flex w-full items-center justify-between gap-3 rounded-md border border-subtle px-3 py-2.5 text-left transition-colors hover:border-strong hover:bg-surface-2"
          >
            <span className="text-[13px] text-text-primary">{r.title}</span>
            <span className="flex items-center gap-1.5 text-[11px] text-text-tertiary">
              {sectionLabel(r.section)}
              <Icon name="ArrowRight" size={12} />
            </span>
          </button>
        ))}
      </div>
    </>
  )
}
