import type { Panel, StickyProps, StickyTone } from '@shared/domain/panel'
import { usePanelStore } from '@/stores/usePanelStore'

const TONES: Record<StickyTone, string> = {
  slate: 'var(--surface-2)',
  stone: 'var(--surface-4)',
  chalk: 'rgba(255,255,255,0.08)',
  outline: 'transparent',
}

export function StickyNotePanel({ panel }: { panel: Panel }) {
  const props = panel.props as StickyProps
  const updateProps = usePanelStore((s) => s.updateProps)

  return (
    <div className="h-full w-full p-1" style={{ background: TONES[props.tone] }}>
      <textarea
        value={props.text}
        onChange={(e) => updateProps<'sticky'>(panel.id, { text: e.target.value })}
        placeholder="Note…"
        spellCheck={false}
        className="h-full w-full resize-none border-none bg-transparent p-2 text-[14px] leading-relaxed text-text-primary placeholder:text-text-quaternary focus:outline-none"
        style={{ userSelect: 'text' }}
      />
    </div>
  )
}
