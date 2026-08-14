import type { ComponentType } from 'react'
import type { Panel, PanelType } from '@shared/domain/panel'
import { TerminalPanel } from '../terminal/TerminalPanel'
import { EditorPanel } from '../editor/EditorPanel'
import { BrowserPanel } from '../browser/BrowserPanel'
import { MarkdownPanel } from '../markdown/MarkdownPanel'
import { PomodoroPanel } from '../pomodoro/PomodoroPanel'
import { TodoPanel } from '../todo/TodoPanel'
import { StickyNotePanel } from '../sticky/StickyNotePanel'
import { StubPanel } from './StubPanel'

type PanelComponent = ComponentType<{ panel: Panel }>

const REGISTRY: Record<PanelType, PanelComponent> = {
  terminal: TerminalPanel,
  editor: EditorPanel,
  browser: BrowserPanel,
  // 'files' is the legacy File Explorer type, now merged into the unified Files panel
  // (the editor component). Saved 'files' panels are migrated to 'editor' on load
  // (see usePanelStore.replaceAll); this mapping is just a safety net for stragglers.
  files: EditorPanel,
  markdown: MarkdownPanel,
  pomodoro: PomodoroPanel,
  todo: TodoPanel,
  sticky: StickyNotePanel,
  // Regions and text labels are ground annotations rendered by their own frames in PanelLayer
  // (RegionFrame / TextLabelFrame), not through PanelFrame — so these slots are never consulted;
  // keep them mapped to satisfy the exhaustive PanelType record.
  region: StubPanel,
  label: StubPanel,
  // Dock groups are rendered by DockGroupFrame in PanelLayer (like regions/labels), not via this
  // registry — their members' bodies are looked up here individually. This slot is never consulted.
  group: StubPanel,
}

export function getPanelComponent(type: PanelType): PanelComponent {
  return REGISTRY[type] ?? StubPanel
}
