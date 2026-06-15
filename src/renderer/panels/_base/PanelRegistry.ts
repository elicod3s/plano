import type { ComponentType } from 'react'
import type { Panel, PanelType } from '@shared/domain/panel'
import { TerminalPanel } from '../terminal/TerminalPanel'
import { EditorPanel } from '../editor/EditorPanel'
import { BrowserPanel } from '../browser/BrowserPanel'
import { AgentPanel } from '../agent/AgentPanel'
import { MarkdownPanel } from '../markdown/MarkdownPanel'
import { StickyNotePanel } from '../sticky/StickyNotePanel'
import { TextLabelPanel } from '../label/TextLabelPanel'
import { StubPanel } from './StubPanel'

type PanelComponent = ComponentType<{ panel: Panel }>

const REGISTRY: Record<PanelType, PanelComponent> = {
  terminal: TerminalPanel,
  editor: EditorPanel,
  browser: BrowserPanel,
  agent: AgentPanel,
  // 'files' is the legacy File Explorer type, now merged into the unified Files panel
  // (the editor component). Saved 'files' panels are migrated to 'editor' on load
  // (see usePanelStore.replaceAll); this mapping is just a safety net for stragglers.
  files: EditorPanel,
  git: StubPanel,
  markdown: MarkdownPanel,
  sticky: StickyNotePanel,
  voice: StubPanel,
  // Regions render via RegionFrame in PanelLayer (not through PanelFrame), so this slot
  // is never consulted; keep it mapped to satisfy the exhaustive PanelType record.
  region: StubPanel,
  label: TextLabelPanel,
}

export function getPanelComponent(type: PanelType): PanelComponent {
  return REGISTRY[type] ?? StubPanel
}
