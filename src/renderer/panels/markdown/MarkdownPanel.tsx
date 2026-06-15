import { useRef } from 'react'
import type { Panel, MarkdownProps } from '@shared/domain/panel'
import { usePanelStore } from '@/stores/usePanelStore'
import { useCodeMirror } from '@/panels/editor/useCodeMirror'

export function MarkdownPanel({ panel }: { panel: Panel }) {
  const props = panel.props as MarkdownProps
  const updateProps = usePanelStore((s) => s.updateProps)
  const ref = useRef<HTMLDivElement>(null)

  useCodeMirror(ref, {
    doc: props.content ?? '',
    language: 'md',
    onChange: (value) => updateProps<'markdown'>(panel.id, { content: value }),
  })

  return <div ref={ref} className="h-full w-full overflow-hidden bg-surface-1" />
}
