/**
 * Typed request/response payloads per channel, and the `PlanoApi` shape that the
 * preload exposes on `window.plano`. The renderer programs against this interface only.
 */

import type { AgentVerdict } from '../domain/agent'
import type { WorkspaceDoc, RecentWorkspace } from '../domain/workspace'

/** Unsubscribe handle returned by every `on*` subscription. */
export type Unsubscribe = () => void

// ── terminal ──
export interface TerminalCreateRequest {
  panelId: string
  cwd?: string
  shell?: string
  cols: number
  rows: number
}
export interface TerminalCreateResult {
  ptyId: string
  pid: number
  shellName: string
}
export interface TerminalDataEvent {
  ptyId: string
  data: string
}
export interface TerminalExitEvent {
  ptyId: string
  exitCode: number
  signal?: number
}

// ── agent detection ──
export interface AgentSignalEvent {
  ptyId: string
  verdict: AgentVerdict
}

// ── workspace ──
export interface WorkspaceOpenRequest {
  folderPath: string
}
export interface WorkspaceOpenResult {
  folderPath: string
  workspace: WorkspaceDoc
  migratedFrom?: number
}
export interface WorkspaceSaveRequest {
  folderPath: string
  workspace: WorkspaceDoc
}
export interface WorkspaceSaveResult {
  ok: boolean
  savedAt: string
}

// ── filesystem ──
export interface FsNode {
  name: string
  path: string
  type: 'file' | 'directory'
  children?: FsNode[]
}
export interface FsReadTreeRequest {
  dir: string
  depth?: number
}
export interface FsReadTreeResult {
  root: FsNode
}
export interface FsReadFileRequest {
  path: string
}
export interface FsReadFileResult {
  content: string
  encoding: 'utf8'
}
export interface FsWriteFileRequest {
  path: string
  content: string
}
export interface FsWriteFileResult {
  ok: boolean
}
export interface FsPickFolderResult {
  /** Absolute path the user chose, or null if the dialog was cancelled. */
  folderPath: string | null
}
export interface FsReadBinaryFileRequest {
  path: string
}
export interface FsReadBinaryFileResult {
  /** Base64-encoded bytes (for building a data: URL in the renderer). */
  base64: string
  /** Guessed MIME type from the file extension, e.g. "image/png". */
  mime: string
}

// ── time tracking ──
/** Seconds tracked on one local calendar day (key "YYYY-MM-DD"). */
export interface TimeDayStat {
  key: string
  seconds: number
}
/** Aggregated usage snapshot computed (in main) from the persisted per-day buckets. */
export interface TimeStats {
  /** Seconds tracked today (local). */
  today: number
  /** Seconds tracked across the current local week (Mon → Sun). */
  week: number
  /** The current week's seven days, Monday → Sunday, for the breakdown chart. */
  weekDays: TimeDayStat[]
}
export interface TimeAddActiveRequest {
  /** Active seconds to add to the current local day. */
  seconds: number
}

// ── app ──
export interface AppInfo {
  versions: { app: string; electron: string; chrome: string; node: string }
  platform: NodeJS.Platform
  isPackaged: boolean
  homeDir: string
}

/**
 * The full surface exposed to the renderer. Grouped by domain. Methods are async
 * (invoke) or fire-and-forget (void); `on*` register events and return an unsubscribe.
 */
export interface PlanoApi {
  terminal: {
    create(req: TerminalCreateRequest): Promise<TerminalCreateResult>
    write(ptyId: string, data: string): void
    resize(ptyId: string, cols: number, rows: number): void
    kill(ptyId: string): Promise<{ ok: boolean }>
    onData(cb: (e: TerminalDataEvent) => void): Unsubscribe
    onExit(cb: (e: TerminalExitEvent) => void): Unsubscribe
  }
  agent: {
    ping(ptyId: string): void
    onSignal(cb: (e: AgentSignalEvent) => void): Unsubscribe
  }
  workspace: {
    open(req: WorkspaceOpenRequest): Promise<WorkspaceOpenResult>
    save(req: WorkspaceSaveRequest): Promise<WorkspaceSaveResult>
    listRecent(): Promise<{ recents: RecentWorkspace[] }>
    pickFolder(): Promise<{ folderPath: string | null }>
  }
  fs: {
    readTree(req: FsReadTreeRequest): Promise<FsReadTreeResult>
    readFile(req: FsReadFileRequest): Promise<FsReadFileResult>
    writeFile(req: FsWriteFileRequest): Promise<FsWriteFileResult>
    /** Open a native folder picker; the chosen folder is granted read access. */
    pickFolder(): Promise<FsPickFolderResult>
    /** Read a file as base64 bytes (used to preview images inline). */
    readBinaryFile(req: FsReadBinaryFileRequest): Promise<FsReadBinaryFileResult>
  }
  time: {
    /** Read the persisted today / week / weekly-breakdown snapshot. */
    getStats(): Promise<TimeStats>
    /** Add active seconds to today's bucket; returns the updated snapshot. */
    addActive(req: TimeAddActiveRequest): Promise<TimeStats>
  }
  clipboard: {
    /** Copy plain text to the system clipboard. */
    writeText(text: string): Promise<void>
    /** Read plain text from the system clipboard. */
    readText(): Promise<string>
  }
  shell: {
    /** Show a file/folder in the OS file manager (Explorer/Finder), selecting it. */
    revealPath(path: string): Promise<void>
  }
  app: {
    getInfo(): Promise<AppInfo>
  }
  window: {
    minimize(): void
    toggleMaximize(): void
    close(): void
    isMaximized(): Promise<boolean>
  }
}
