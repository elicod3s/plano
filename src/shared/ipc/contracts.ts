/**
 * Typed request/response payloads per channel, and the `PlanoApi` shape that the
 * preload exposes on `window.plano`. The renderer programs against this interface only.
 */

import type { AgentVerdict, AgentSessionRef } from '../domain/agent'
import type { WorkspaceDoc, RecentWorkspace, WorkspaceStateDoc, Space } from '../domain/workspace'
import type { PlanoSettings } from '../domain/settings'

/** Unsubscribe handle returned by every `on*` subscription. */
export type Unsubscribe = () => void

// ── terminal ──
export interface TerminalCreateRequest {
  panelId: string
  cwd?: string
  shell?: string
  cols: number
  rows: number
  /** Enable the shell's inline predictive-history engine (Warp-style). Defaults to on. */
  predictiveHistory?: boolean
  /**
   * When true (a plain terminal opened on the workspace folder), main may refine `cwd` to the real
   * project root inside a container folder — so npm/git/etc. work without a manual `cd`. Left false
   * for a terminal explicitly rooted at a folder the user picked (e.g. Files panel "open here").
   */
  autoDetectRoot?: boolean
}
export interface TerminalCreateResult {
  ptyId: string
  pid: number
  shellName: string
  /** Directory the shell ACTUALLY started in (after project-root resolution) — seeds the git badge. */
  cwd: string
}
/** Result of re-binding a remounted panel to a PTY that kept running across a space switch. */
export interface TerminalAttachResult {
  /** False when no live PTY exists for this id (killed/never existed) → caller should respawn. */
  ok: boolean
  /** True if the underlying process already exited while detached (renderer shows it ended). */
  exited: boolean
  /** Buffered output to replay into the fresh xterm so the session looks exactly as it was. */
  buffer: string
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
/** A local dev-server URL (localhost:PORT, …) printed in this terminal's output. */
export interface DevUrlDetectedEvent {
  ptyId: string
  /** Normalized http(s) URL, e.g. "http://localhost:5173". */
  url: string
}
/** A detected AI-agent process running under a terminal's shell (not raw OS noise). */
export interface TerminalProcessInfo {
  pid: number
  /** image/base name, e.g. "node.exe", "claude.exe" */
  name: string
  /** full command line when available */
  cmd: string
}
export interface TerminalListProcessesResult {
  processes: TerminalProcessInfo[]
}

// ── git (read-only status for a folder) ──
export interface GitStatusRequest {
  cwd: string
}
export interface GitStatusResult {
  isRepo: boolean
  /** Current branch (or "HEAD" when detached); null when not a repo. */
  branch: string | null
  /** True when HEAD is detached (no current branch). */
  detached: boolean
  /** Working tree has uncommitted changes (tracked edits or untracked files). */
  dirty: boolean
  /** Commits ahead / behind the upstream tracking branch (0 when there is no upstream). */
  ahead: number
  behind: number
  /** Whether the branch has an upstream set, so ahead/behind are meaningful. */
  hasUpstream: boolean
  /** Inserted / deleted lines across the working tree vs HEAD. */
  added: number
  removed: number
  /** Number of changed files (tracked changes vs HEAD). */
  filesChanged: number
  /** Identity derived from the `origin` remote (GitHub or other host); null when there is none. */
  remote: GitRemoteInfo | null
}
/** A parsed git remote — enough to label a repo and open it on the web. */
export interface GitRemoteInfo {
  /** Host, e.g. "github.com". */
  host: string
  owner: string
  repo: string
  /** Browser URL for the repo (https), e.g. https://github.com/owner/repo. */
  webUrl: string
  /** True when the remote is hosted on github.com. */
  isGitHub: boolean
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
  /**
   * True when no saved layout existed yet (the folder is brand-new to PLANO). Lets the renderer
   * safely seed/migrate a pre-folder session instead of treating it as an existing project.
   */
  isNew?: boolean
  /**
   * Set when the workspace file EXISTS but could not be read or parsed (transient lock,
   * permissions, corruption). `workspace` is then a throwaway placeholder the renderer MUST
   * ignore: it keeps its current in-memory state rather than overwrite it with a fabricated
   * blank doc (which the autosave would then persist over the real workspace on disk).
   */
  error?: { code: string; message: string }
}
export interface WorkspaceSaveRequest {
  folderPath: string
  workspace: WorkspaceDoc
}
export interface WorkspaceSaveResult {
  ok: boolean
  savedAt: string
}
/** Emitted when the OS asks an already-running PLANO to open a folder ("Open in PLANO"). */
export interface WorkspaceOpenFolderEvent {
  folderPath: string
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
export interface FsWatchRequest {
  /** Directory to watch (recursively). Must be an allowed workspace root. */
  dir: string
}
export interface FsWatchResult {
  /** False when the dir isn't allowed or recursive watching is unsupported here. */
  ok: boolean
}
export interface FsUnwatchRequest {
  dir: string
}
export interface FsUnwatchResult {
  ok: boolean
}
/** Emitted (debounced) when a watched folder's contents change on disk. */
export interface FsChangedEvent {
  /** The watched root directory (matches a Files panel's folderPath). */
  dir: string
  /** Absolute paths changed since the last flush (may be empty if the OS didn't name them). */
  paths: string[]
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
/** The folder this instance was launched with (e.g. Explorer's "Open in PLANO"), or null. */
export interface AppLaunchFolderResult {
  folderPath: string | null
}

// ── session (live "open project" pointer, separate from the recents history) ──
export interface SessionState {
  /** The project folder open at last quit, or null when none was open / it was closed. */
  folderPath: string | null
  /**
   * False on a fresh install (no session file recorded yet). The renderer uses this to fall back
   * to the most-recent folder exactly once, so upgrading users who never explicitly closed a
   * project still get their last workspace reopened.
   */
  initialized: boolean
}
export interface SessionSetRequest {
  /** Folder to remember as open, or null to record "no project open". */
  folderPath: string | null
}

/** App-global open-workspaces state (the single source of truth the renderer hydrates on launch). */
export interface WorkspaceStateResult {
  /** null when there's no usable file yet (fresh install) → the renderer migrates / starts blank. */
  state: WorkspaceStateDoc | null
}
export interface WorkspaceStateSaveRequest {
  activeId: string
  workspaces: Space[]
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
    /** Re-bind a remounted panel to its persistent PTY; main replays the buffered output. */
    attach(ptyId: string): Promise<TerminalAttachResult>
    /** Panel unmounted (space switch) — keep the PTY running, buffering output until reattach. */
    detach(ptyId: string): void
    /** Real descendant processes running under this terminal's shell. */
    listProcesses(ptyId: string): Promise<TerminalListProcessesResult>
    onData(cb: (e: TerminalDataEvent) => void): Unsubscribe
    onExit(cb: (e: TerminalExitEvent) => void): Unsubscribe
    /** A local dev-server URL appeared in this terminal's output (for auto-open in PLANO). */
    onUrlDetected(cb: (e: DevUrlDetectedEvent) => void): Unsubscribe
  }
  agent: {
    ping(ptyId: string): void
    onSignal(cb: (e: AgentSignalEvent) => void): Unsubscribe
    /** Resolve the resumable conversation ref for the agent currently running under this
     *  terminal (null when none / not resumable). `cwd` is the terminal's live cwd. */
    resolveSession(ptyId: string, cwd: string): Promise<AgentSessionRef | null>
    /** Whether the conversation behind `ref` still exists on disk for a resume run from `cwd`.
     *  `null` = unverifiable store (caller should proceed). */
    validateSession(ref: AgentSessionRef, cwd: string): Promise<boolean | null>
    /** Re-seed the sidecar so a just-resumed conversation keeps its id across the next restart. */
    reportSession(ptyId: string, ref: AgentSessionRef): void
  }
  git: {
    /** Read-only branch + diff summary for a folder (e.g. a terminal's cwd). */
    status(req: GitStatusRequest): Promise<GitStatusResult>
  }
  workspace: {
    open(req: WorkspaceOpenRequest): Promise<WorkspaceOpenResult>
    save(req: WorkspaceSaveRequest): Promise<WorkspaceSaveResult>
    listRecent(): Promise<{ recents: RecentWorkspace[] }>
    pickFolder(): Promise<{ folderPath: string | null }>
    /** The OS asked an already-running PLANO to open a folder ("Open in PLANO"). */
    onOpenFolder(cb: (e: WorkspaceOpenFolderEvent) => void): Unsubscribe
  }
  /** App-global open-workspaces state (every open workspace + the active one). */
  workspaces: {
    get(): Promise<WorkspaceStateResult>
    save(req: WorkspaceStateSaveRequest): Promise<WorkspaceSaveResult>
    /**
     * Blocking final flush for window close / app quit. A `beforeunload` handler can't await the
     * async `save` before the renderer is torn down, so this writes the app-global state to disk
     * synchronously (sendSync round-trip) — guaranteeing the last note/todo edit is never lost.
     */
    saveSync(req: WorkspaceStateSaveRequest): WorkspaceSaveResult
  }
  fs: {
    readTree(req: FsReadTreeRequest): Promise<FsReadTreeResult>
    readFile(req: FsReadFileRequest): Promise<FsReadFileResult>
    writeFile(req: FsWriteFileRequest): Promise<FsWriteFileResult>
    /** Open a native folder picker; the chosen folder is granted read access. */
    pickFolder(): Promise<FsPickFolderResult>
    /** Read a file as base64 bytes (used to preview images inline). */
    readBinaryFile(req: FsReadBinaryFileRequest): Promise<FsReadBinaryFileResult>
    /** Start watching a folder (recursively) so the Files panel refreshes on disk changes. */
    watch(req: FsWatchRequest): Promise<FsWatchResult>
    /** Stop watching a folder (ref-counted — the OS watcher closes when the last panel leaves). */
    unwatch(req: FsUnwatchRequest): Promise<FsUnwatchResult>
    /** A watched folder changed on disk (added/removed/modified files). */
    onChanged(cb: (e: FsChangedEvent) => void): Unsubscribe
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
    /** Open an http(s) URL in the user's system browser. */
    openExternal(url: string): Promise<void>
  }
  app: {
    getInfo(): Promise<AppInfo>
    /** The folder this instance was launched with (Explorer "Open in PLANO"); cleared after read. */
    getLaunchFolder(): Promise<AppLaunchFolderResult>
  }
  settings: {
    /** Read the full settings document (always complete — defaults fill any gaps). */
    get(): Promise<PlanoSettings>
    /** Persist the full settings document; returns the merged/normalized result. */
    save(settings: PlanoSettings): Promise<{ ok: true; settings: PlanoSettings }>
  }
  session: {
    /** The project open at last quit (for launch restore), plus whether a session was ever recorded. */
    get(): Promise<SessionState>
    /** Record the currently-open project, or null to mark "no project open". */
    set(folderPath: string | null): Promise<{ ok: true }>
  }
  window: {
    minimize(): void
    toggleMaximize(): void
    close(): void
    isMaximized(): Promise<boolean>
  }
}
