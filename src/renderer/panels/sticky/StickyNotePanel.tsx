import { useEffect, useRef, useState } from 'react'
import type { Panel, StickyProps, StickyTone } from '@shared/domain/panel'
import { usePanelStore } from '@/stores/usePanelStore'
import { Icon } from '@/design-system/Icon'
import { LinkedText } from '@/design-system/LinkedText'
import { cn } from '@/lib/cn'
import { STICKY_TONES, stickyToneBackground } from './stickyThemes'

/**
 * A sticky note. The color is deliberately HIDDEN — no visible swatch row: a small tone dot
 * in the top-right corner opens a tiny color popover on click, keeping the note clean and
 * minimal. A freshly created note gets a RANDOM tone (see defaultProps in shared/domain/panel).
 */
export function StickyNotePanel({ panel }: { panel: Panel }) {
  const props = panel.props as StickyProps
  const updateProps = usePanelStore((s) => s.updateProps)
  const [editing, setEditing] = useState(!props.text)
  const [pickerOpen, setPickerOpen] = useState(false)
  const pickerRef = useRef<HTMLDivElement>(null)
  const tone = props.tone ?? 'amber'
  const background = stickyToneBackground(tone as StickyTone)
  const current = STICKY_TONES.find((o) => o.id === tone) ?? STICKY_TONES[0]

  // Close the color popover on outside click / Escape.
  useEffect(() => {
    if (!pickerOpen) return
    const onDown = (e: PointerEvent): void => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) setPickerOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setPickerOpen(false)
    }
    window.addEventListener('pointerdown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [pickerOpen])

  return (
    <div className="relative flex h-full w-full flex-col transition-colors duration-200" style={{ background }}>
      {/* hidden controls — top-right: tone dot (opens the color popover) + edit */}
      <div className="flex h-8 shrink-0 items-center justify-end gap-1 pr-3 pt-2">
        <div ref={pickerRef} className="relative">
          <button
            type="button"
            onClick={() => setPickerOpen((v) => !v)}
            aria-label="Note color"
            title="Note color"
            className="app-no-drag flex h-5 w-5 items-center justify-center rounded-pill opacity-40 transition-opacity hover:opacity-100 focus-caliper"
          >
            <span
              className="h-3 w-3 rounded-pill"
              style={{ background: current.color, boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.18)' }}
            />
          </button>
          {pickerOpen && (
            <div
              data-surface-layer="popover"
              className="animate-menu-in surface-layer surface-layer--popover absolute right-0 top-full z-20 mt-1.5 flex items-center gap-1.5 rounded-pill p-1.5"
            >
              {STICKY_TONES.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={tone === option.id}
                  aria-label={option.label}
                  title={option.label}
                  onClick={() => {
                    updateProps<'sticky'>(panel.id, { tone: option.id as StickyTone })
                    setPickerOpen(false)
                  }}
                  className={cn(
                    'app-no-drag h-4 w-4 rounded-pill transition-transform hover:scale-110 focus-caliper',
                    tone === option.id ? 'scale-110 ring-2 ring-[var(--focus-ring)]' : '',
                  )}
                  style={{ background: option.color, boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.18)' }}
                />
              ))}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={() => setEditing((value) => !value)}
          className="app-no-drag flex h-5 w-5 items-center justify-center rounded-pill text-text-3 opacity-40 transition-opacity hover:opacity-100 hover:text-text-1 focus-caliper"
          aria-label={editing ? 'Finish editing note' : 'Edit note'}
          title={editing ? 'Done' : 'Edit note'}
        >
          <Icon name={editing ? 'Check' : 'Pencil'} size={12} />
        </button>
      </div>

      {editing ? (
        <textarea
          autoFocus
          value={props.text}
          onChange={(event) => updateProps<'sticky'>(panel.id, { text: event.target.value })}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setEditing(false)
          }}
          placeholder="Note…"
          spellCheck={false}
          className="app-no-drag min-h-0 flex-1 resize-none border-none bg-transparent px-3 pb-2 pt-0.5 text-[14px] leading-relaxed text-text-1 placeholder:text-text-4 focus:outline-none"
          style={{ userSelect: 'text' }}
        />
      ) : (
        <div
          className="app-no-drag min-h-0 flex-1 cursor-text overflow-y-auto whitespace-pre-wrap break-words px-3 pb-2 pt-0.5 text-[14px] leading-relaxed text-text-1"
          onClick={(event) => {
            if (!(event.target as HTMLElement).closest('a, button')) setEditing(true)
          }}
        >
          {props.text ? <LinkedText text={props.text} /> : <span className="text-text-4">Note…</span>}
        </div>
      )}
    </div>
  )
}
