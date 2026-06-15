import type { Panel, LabelProps } from '@shared/domain/panel'
import { usePanelStore } from '@/stores/usePanelStore'

export function TextLabelPanel({ panel }: { panel: Panel }) {
  const props = panel.props as LabelProps
  const updateProps = usePanelStore((s) => s.updateProps)

  return (
    <div className="flex h-full w-full items-center bg-transparent px-2">
      <textarea
        value={props.text}
        onChange={(e) => updateProps<'label'>(panel.id, { text: e.target.value })}
        placeholder="Text"
        spellCheck={false}
        className="h-full w-full resize-none border-none bg-transparent font-display text-[20px] font-semibold leading-tight tracking-tightui text-text-primary placeholder:text-text-quaternary focus:outline-none"
        style={{ userSelect: 'text' }}
      />
    </div>
  )
}
