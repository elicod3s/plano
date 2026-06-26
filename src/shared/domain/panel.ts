/**
 * The panel model — the heart of a workspace. A Panel is a typed, rectangular surface
 * placed in world space on the canvas. `props` is discriminated by `type`.
 */

import type { Rect, Size } from './geometry'
import type { DockNode } from './dock'
import type { TerminalThemeId } from './settings'
import type { AgentSessionRef } from './agent'

export type PanelType =
  | 'terminal'
  | 'editor'
  | 'browser'
  | 'agent'
  | 'files'
  | 'git'
  | 'markdown'
  | 'pomodoro'
  | 'todo'
  | 'sticky'
  | 'voice'
  | 'region'
  | 'label'
  | 'group'

/**
 * One terminal inside a terminal panel (a tab). A panel hosts one or more of these; each has its
 * OWN PTY/xterm, keyed by `id` (the runtime store key). Per-terminal config lives here so each tab
 * is fully independent (its own cwd, shell, font zoom, and resumable agent conversation).
 */
export interface TerminalTab {
  /** Stable id — the runtime key (one PTY/xterm per tab); survives workspace reopen. */
  id: string
  /** Optional custom tab label; otherwise derived from the cwd / running agent. */
  title?: string
  cwd?: string
  shell?: string
  /** Per-terminal font-size override in px (Ctrl +/−); falls back to the global setting. */
  fontSize?: number
  /** One-shot command run automatically once the shell is ready (e.g. `claude` to launch an agent
   *  from a voice command). Cleared after it runs so a reattach/reopen never re-launches it. */
  bootCommand?: string
  /** Resumable reference to the AI-agent conversation last detected in THIS terminal (captured
   *  live, persisted so a workspace reopen can re-enter it; gated by `restoreAgentSessions`). */
  agentSession?: AgentSessionRef
}

export interface TerminalProps {
  /** The terminals (tabs) in this panel + which one is active. Absent on legacy single-terminal
   *  panels (and brand-new ones) — synthesized into one tab from the legacy fields on first mount. */
  tabs?: TerminalTab[]
  activeTabId?: string
  /** Stable, human-facing identifier for this terminal panel ("Terminal 1", "2", …). Shown as a
   *  badge and used by the voice assistant ("focus terminal 2"). Smallest-free integer, assigned on
   *  first mount; persisted so it stays put across reloads. */
  terminalNumber?: number
  /** One-shot boot command for a brand-new panel before its first tab exists (migrated into tab[0]). */
  bootCommand?: string
  /** Per-panel color theme override (shared by all tabs); falls back to the global terminal theme. */
  theme?: TerminalThemeId
  /** Local dev-server URLs (localhost:PORT) this panel has already auto-opened. Persisted so a
   *  workspace reopen — or a resumed agent redrawing old output that mentions the URL — never
   *  re-opens the same one. Capped to the most-recent few. */
  openedDevUrls?: string[]
  // ── legacy single-terminal fields (pre-tabs). Read only as the migration source for the first
  //    tab; new code reads/writes the active TerminalTab instead. ──
  cwd?: string
  shell?: string
  fontSize?: number
  agentSession?: AgentSessionRef
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
export interface PomodoroProps {
  /** Focus session length, minutes. */
  workMinutes: number
  /** Short break length, minutes. */
  breakMinutes: number
  /** Long break length, minutes. */
  longBreakMinutes: number
  /** Focus sessions before a long break. */
  roundsBeforeLongBreak: number
  /** Play a chime on each phase transition. */
  soundEnabled: boolean
}
/** Task priority — drives the colored flag in the To-do panel (the one scoped color exception there). */
export type TodoPriority = 'none' | 'low' | 'medium' | 'high' | 'urgent'
export interface TodoItem {
  id: string
  text: string
  done: boolean
  priority: TodoPriority
  /** epoch ms, for stable sort tiebreaks */
  createdAt: number
}
export interface TodoProps {
  todos: TodoItem[]
  /** List view filter. */
  filter: 'all' | 'active' | 'completed'
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
/** A dock group: one window whose body is a split tree of member panels (see domain/dock.ts). */
export interface GroupProps {
  layout: DockNode
}

export interface PanelPropsMap {
  terminal: TerminalProps
  editor: EditorProps
  browser: BrowserProps
  agent: AgentProps
  files: FilesProps
  git: GitProps
  markdown: MarkdownProps
  pomodoro: PomodoroProps
  todo: TodoProps
  sticky: StickyProps
  voice: VoiceProps
  region: RegionProps
  label: LabelProps
  group: GroupProps
}

interface PanelBase<T extends PanelType> {
  id: string
  type: T
  rect: Rect
  /** stacking order on the canvas */
  z: number
  title: string
  /** When true the panel is pinned: it can't be dragged or resized, and a region won't carry it. */
  locked?: boolean
  /** Set when this panel is docked inside a 'group' panel (rendered in that group, not as a frame). */
  dockedIn?: string
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
  // Spawns roomy so a fresh terminal — and an agent CLI (Claude/Codex) that morphs into agent mode,
  // incl. when opened by voice — is legible from the start instead of a cramped little box.
  terminal: { type: 'terminal', label: 'New Terminal', icon: 'SquareTerminal', defaultSize: { width: 720, height: 480 } },
  // Unified Files panel: a file-tree explorer that grows into a code editor / image
  // viewer when a file is opened. Starts compact (tree-only) per `defaultSize`.
  editor: { type: 'editor', label: 'New Files', icon: 'FolderTree', defaultSize: { width: 300, height: 480 } },
  browser: { type: 'browser', label: 'New Browser', icon: 'Globe', defaultSize: { width: 720, height: 520 } },
  agent: { type: 'agent', label: 'New PLANO Agent', icon: 'Sparkles', defaultSize: { width: 480, height: 520 } },
  files: { type: 'files', label: 'New File Explorer', icon: 'FolderTree', defaultSize: { width: 300, height: 460 } },
  git: { type: 'git', label: 'New Git Panel', icon: 'GitBranch', defaultSize: { width: 420, height: 480 } },
  markdown: { type: 'markdown', label: 'New Document', icon: 'FileText', defaultSize: { width: 560, height: 460 } },
  pomodoro: { type: 'pomodoro', label: 'New Pomodoro', icon: 'Timer', defaultSize: { width: 320, height: 440 } },
  todo: { type: 'todo', label: 'New To-do List', icon: 'ListChecks', defaultSize: { width: 420, height: 580 } },
  sticky: { type: 'sticky', label: 'New Sticky Note', icon: 'StickyNote', defaultSize: { width: 240, height: 220 }, annotation: true },
  voice: { type: 'voice', label: 'New Voice', icon: 'Mic', defaultSize: { width: 320, height: 200 } },
  region: { type: 'region', label: 'New Region', icon: 'Frame', defaultSize: { width: 640, height: 480 }, annotation: true },
  // Background text: a chrome-less heading that lives behind the panels (like a region, it's
  // ground — see TextLabelFrame), so it spawns wider than a sticky note.
  label: { type: 'label', label: 'New Text', icon: 'Type', defaultSize: { width: 360, height: 60 }, annotation: true },
  // A dock group is created programmatically (by docking two panels), never from a menu — so it has
  // no create command. It still needs a META entry to satisfy the exhaustive record.
  group: { type: 'group', label: 'Group', icon: 'LayoutGrid', defaultSize: { width: 820, height: 520 } },
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
    case 'pomodoro':
      return {
        workMinutes: 25,
        breakMinutes: 5,
        longBreakMinutes: 15,
        roundsBeforeLongBreak: 4,
        soundEnabled: true,
      } as PanelPropsMap[T]
    case 'todo':
      return { todos: [] as TodoItem[], filter: 'all' } as PanelPropsMap[T]
    case 'sticky':
      return { text: '', tone: 'stone' } as PanelPropsMap[T]
    case 'voice':
      return {} as PanelPropsMap[T]
    case 'region':
      return { label: 'Region' } as PanelPropsMap[T]
    case 'label':
      return { text: 'Text' } as PanelPropsMap[T]
    case 'group':
      // Placeholder; a real group's layout is built explicitly by the dock actions, never here.
      return { layout: { kind: 'pane', panelId: '' } } as PanelPropsMap[T]
    default:
      return {} as PanelPropsMap[T]
  }
}
