/**
 * The panel model — the heart of a workspace. A Panel is a typed, rectangular surface
 * placed in world space on the canvas. `props` is discriminated by `type`.
 */

import type { Rect, Size } from './geometry'

export type PanelType =
  | 'terminal'
  | 'editor'
  | 'browser'
  | 'agent'
  | 'files'
  | 'git'
  | 'markdown'
  | 'sticky'
  | 'voice'
  | 'region'
  | 'label'

export interface TerminalProps {
  cwd?: string
  shell?: string
}
export interface EditorProps {
  /** Folder opened in this editor's file-tree sidebar (its own root, independent of the workspace). */
  folderPath?: string
  /** Active file shown in the editor pane. Undefined → the scratch buffer. */
  filePath?: string
  language?: string
  /** Scratch content when no file is bound. */
  content?: string
  /** File-tree sidebar visibility (defaults to open). */
  sidebarOpen?: boolean
}
export interface BrowserProps {
  url: string
}
export interface AgentProps {
  provider?: string
}
export interface FilesProps {
  rootPath?: string
}
export interface GitProps {
  repoPath?: string
}
export interface MarkdownProps {
  filePath?: string
  content?: string
}
export type StickyTone = 'slate' | 'stone' | 'chalk' | 'outline'
export interface StickyProps {
  text: string
  tone: StickyTone
}
export interface VoiceProps {
  /** reserved */
  language?: string
}
export interface RegionProps {
  label: string
}
export interface LabelProps {
  text: string
}

export interface PanelPropsMap {
  terminal: TerminalProps
  editor: EditorProps
  browser: BrowserProps
  agent: AgentProps
  files: FilesProps
  git: GitProps
  markdown: MarkdownProps
  sticky: StickyProps
  voice: VoiceProps
  region: RegionProps
  label: LabelProps
}

interface PanelBase<T extends PanelType> {
  id: string
  type: T
  rect: Rect
  /** stacking order on the canvas */
  z: number
  title: string
  props: PanelPropsMap[T]
}

export type Panel = { [T in PanelType]: PanelBase<T> }[PanelType]

/** Narrowing helper: `if (isPanel(p, 'terminal')) { p.props.cwd }`. */
export function isPanel<T extends PanelType>(
  panel: Panel,
  type: T,
): panel is Extract<Panel, { type: T }> {
  return panel.type === type
}

/** Per-type menu metadata + default spawn size. `icon` maps to lucide-react. */
export interface PanelMeta {
  type: PanelType
  label: string
  icon: string
  defaultSize: Size
  /** Panels that exist purely as canvas annotations (no live process). */
  annotation?: boolean
}

export const PANEL_META: Record<PanelType, PanelMeta> = {
  terminal: { type: 'terminal', label: 'New Terminal', icon: 'SquareTerminal', defaultSize: { width: 520, height: 340 } },
  // Unified Files panel: a file-tree explorer that grows into a code editor / image
  // viewer when a file is opened. Starts compact (tree-only) per `defaultSize`.
  editor: { type: 'editor', label: 'New Files', icon: 'FolderTree', defaultSize: { width: 300, height: 480 } },
  browser: { type: 'browser', label: 'New Browser', icon: 'Globe', defaultSize: { width: 720, height: 520 } },
  agent: { type: 'agent', label: 'New PLANO Agent', icon: 'Sparkles', defaultSize: { width: 480, height: 520 } },
  files: { type: 'files', label: 'New File Explorer', icon: 'FolderTree', defaultSize: { width: 300, height: 460 } },
  git: { type: 'git', label: 'New Git Panel', icon: 'GitBranch', defaultSize: { width: 420, height: 480 } },
  markdown: { type: 'markdown', label: 'New Document', icon: 'FileText', defaultSize: { width: 560, height: 460 } },
  sticky: { type: 'sticky', label: 'New Sticky Note', icon: 'StickyNote', defaultSize: { width: 240, height: 220 }, annotation: true },
  voice: { type: 'voice', label: 'New Voice', icon: 'Mic', defaultSize: { width: 320, height: 200 } },
  region: { type: 'region', label: 'New Region', icon: 'Frame', defaultSize: { width: 640, height: 480 }, annotation: true },
  label: { type: 'label', label: 'New Text', icon: 'Type', defaultSize: { width: 260, height: 56 }, annotation: true },
}

/** Default props for a freshly created panel of each type. */
export function defaultProps<T extends PanelType>(type: T): PanelPropsMap[T] {
  switch (type) {
    case 'terminal':
      return {} as PanelPropsMap[T]
    case 'editor':
      return { sidebarOpen: true } as PanelPropsMap[T]
    case 'browser':
      return { url: 'about:blank' } as PanelPropsMap[T]
    case 'agent':
      return {} as PanelPropsMap[T]
    case 'files':
      return {} as PanelPropsMap[T]
    case 'git':
      return {} as PanelPropsMap[T]
    case 'markdown':
      return { content: '' } as PanelPropsMap[T]
    case 'sticky':
      return { text: '', tone: 'stone' } as PanelPropsMap[T]
    case 'voice':
      return {} as PanelPropsMap[T]
    case 'region':
      return { label: 'Region' } as PanelPropsMap[T]
    case 'label':
      return { text: 'Text' } as PanelPropsMap[T]
    default:
      return {} as PanelPropsMap[T]
  }
}
