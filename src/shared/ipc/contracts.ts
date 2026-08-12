/**
 * Typed request/response payloads per channel, and the `PlanoApi` shape that the
 * preload exposes on `window.plano`. The renderer programs against this interface only.
 */

import type { AgentVerdict, AgentSessionRef } from '../domain/agent'
import type { UsageSnapshot, StatusbarAux } from '../domain/usage'
import type {
  AgentMeshSnapshot,
  AgentPromptEvent,
  AgentRuntimeMetaPatch,
  ContextTimelineEvent,
  MeshDispatchRequest,
  MeshDispatchResult,
  MeshUiEvent,
  WorktreeInfo,
} from '../domain/agentMesh'
import type { WorkspaceDoc, RecentWorkspace, WorkspaceStateDoc, Space } from '../domain/workspace'
import type { PlanoSettings } from '../domain/settings'

/** Unsubscribe handle returned by every `on*` subscription. */
export type Unsubscribe = () => void

// ── terminal ──
export interface TerminalCreateRequest {
  panelId: string
  /** Stable terminal (tab) id inside the panel — survives respawns, keys runtime metadata. */
  terminalId: string
  /** The workspace (space) that owns this terminal at spawn time. */
  spaceId: string
  cwd?: string
  shell?: string
  cols: number
  rows: number
  /** Enable the shell's inline predictive-history engine (Warp-style). Defaults to on. */
  predictiveHistory?: boolean
  /**
   * One-shot command launched the instant the shell becomes interactive (e.g. `claude` for a voice
   * "open Claude Code"). Injected into the shell's startup so it runs immediately — no prompt-ready
   * round-trip — and the heavy predictive-history init is skipped for it so the agent appears fast.
   * Trusted: only ever set by PLANO's own launchers (a fixed agent-command table), never user text.
   */
  bootCommand?: string
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
/** A session rediscovered on the detached Agent Host at launch — the terminal reattaches to it. */
export interface RestoredTerminalSession {
  ptyId: string
  /** Stable owner (panel/tab/space) recorded at spawn. */
  panelId: string
  terminalId: string
  spaceId: string
  /** Shell PID as seen by the host (re-roots agent detection). */
  pid: number
  shellName: string
  /** Directory the shell actually started in. */
  cwd: string
  /** True when the shell already exited while the app was closed (scrollback still replays). */
  exited: boolean
}
export interface TerminalRestoreResult {
  sessions: RestoredTerminalSession[]
}
/** A terminal/agent created from the MOBILE web app, handed to the renderer to materialize. */
export interface ExternalTerminalEvent {
  ptyId: string
  panelId: string
  terminalId: string
  spaceId: string
  cwd: string
  shellName: string
  pid: number
  folderPath?: string | null
  name?: string
  bootCommand?: string
  autoApprove?: boolean
  cols?: number
  rows?: number
  /** Mesh spawn: panel of the agent that requested this one (placement anchor + size source). */
  originPanelId?: string
  /** Index/size of the spawn batch, so `count: 2` lays out as a tidy row next to the origin. */
  groupIndex?: number
  groupCount?: number
}
export interface PendingPanelsResult {
  panels: ExternalTerminalEvent[]
}
/** A terminal was closed (e.g. from the phone) — the renderer drops its canvas panel. */
export interface SessionRemovedEvent {
  ptyId: string
  panelId: string
  terminalId: string
}
/** A local dev-server URL (localhost:PORT, …) printed in this terminal's output. */
export interface DevUrlDetectedEvent {
  ptyId: string
  /**
   * Stable owner of the PTY. Including it avoids a renderer-startup race where output can arrive
   * before the renderer has populated its transient ptyId → terminal-tab map.
   */
  panelId: string
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
export interface FsDirEntry {
  name: string
  path: string
  type: 'file' | 'directory'
}
export interface FsReadDirectoryRequest {
  dir: string
}
export interface FsReadDirectoryResult {
  /** False when the dir is inaccessible or gone — the caller keeps its cached rows. */
  ok: boolean
  entries: FsDirEntry[]
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
export interface FsDropPathRequest {
  /** Absolute path of a file/folder the user dropped onto the canvas. */
  path: string
}
export interface FsDropPathResult {
  /** What the path is on disk, or null when it doesn't exist / can't be read. */
  kind: 'file' | 'directory' | null
}
export interface FsWatchRequest {
  /** Directory to watch (recursively). Must be an allowed workspace root. */
  dir: string
}
export interface FsWatchResult {
  /** False when the dir isn't allowed or a watcher couldn't be created. */
  ok: boolean
}
export interface FsUnwatchRequest {
  dir: string
}
export interface FsUnwatchResult {
  ok: boolean
}
/** Emitted (debounced) when a watched folder's contents change on disk. */
/** Whether a filesystem change only touched file CONTENT or changed the tree STRUCTURE.
 *  Content edits must never rebuild the file tree; structural ones (add/delete/rename/dir)
 *  may. 'unknown' (the OS didn't name the path) is treated conservatively as structural. */
export type FsChangeKind = 'content' | 'structural' | 'unknown'
export interface FsPathChange {
  path: string
  kind: FsChangeKind
}
export interface FsChangedEvent {
  /** The watched root directory (matches a Files panel's folderPath). */
  dir: string
  /** Typed changes since the last flush (may be empty if the OS didn't name anything). */
  changes: FsPathChange[]
}
export interface FsCreateEntryRequest {
  /** Parent directory (must lie inside an allowed root). */
  dir: string
  /** New entry name — a single path segment; main validates and rejects separators/reserved chars. */
  name: string
  type: 'file' | 'directory'
}
export interface FsCreateEntryResult {
  ok: boolean
  /** Absolute path of the created entry. */
  path: string
}
export interface FsRenameEntryRequest {
  path: string
  /** New name (single path segment) — the entry stays in its parent directory. */
  newName: string
}
export interface FsRenameEntryResult {
  ok: boolean
  /** Absolute path after the rename. */
  path: string
}
export interface FsDeleteEntryRequest {
  path: string
}
export interface FsDeleteEntryResult {
  ok: boolean
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
  /** Active seconds attributed to each detected agent today (e.g. [{ kind: 'pi', seconds: 42 }]). */
  agentsToday: AgentTimeStat[]
  /** Active seconds attributed to each detected agent across the current local week. */
  agentsWeek: AgentTimeStat[]
}

/** One agent's tracked time (kind = AgentKind id, e.g. 'pi' | 'claude-code' | 'codex'). */
export interface AgentTimeStat {
  kind: string
  seconds: number
}

export interface TimeAddActiveRequest {
  /** Active seconds to add to the current local day. */
  seconds: number
  /** Optional per-agent attribution for the same span — each entry adds `seconds` to that
   *  agent's today bucket (e.g. the tracker attributes a tick to the front-most active agent). */
  agents?: AgentTimeStat[]
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
/** Connection info for the PLANO mobile web app (LAN). */
export interface RemoteInfoResult {
  /** All plausible LAN IPv4 addresses of this machine (the user's phone must be on one of these). */
  lanIps: string[]
  /** Web server port on the Agent Host (0 = not up yet). */
  webPort: number
  /** Auth token (matches <userData>/agent-host.json). */
  token: string
  /** Short, human-friendly pairing code (first 6 chars of the token). */
  pairingCode: string
  /** Base URL of the mobile web app on this LAN, e.g. http://192.168.1.5:34821/. */
  url: string
  /** True when at least one phone is connected to the mobile web app right now. */
  phoneConnected: boolean
}

// ── auto-update (GitHub releases) ──
/** Lifecycle of the auto-updater as seen by the renderer. */
export type UpdatePhase =
  /** Not checked yet (startup delay not elapsed). */
  | 'idle'
  | 'checking'
  /** A newer version exists and its installer is being downloaded (auto). */
  | 'downloading'
  /** The new installer is on disk — restart to install. */
  | 'downloaded'
  /** Running the latest published version. */
  | 'up-to-date'
  /** The last check failed (offline, repo unreachable, …). Logged; auto-retried next cycle. */
  | 'error'

/** Snapshot of the updater state, pushed main → renderer and readable on demand. */
export interface UpdateState {
  phase: UpdatePhase
  /** Version of the update being downloaded / ready to install (when known). */
  version?: string
  /** Download progress 0–100 (phase 'downloading'). */
  percent?: number
  bytesPerSecond?: number
  transferred?: number
  total?: number
  /** Human-readable failure reason (phase 'error'). */
  message?: string
  /** False in dev runs — the app can't auto-update when not packaged. */
  canCheck: boolean
  /** Unix ms of the last completed check, or undefined before the first one. */
  checkedAt?: number
}
export interface UpdateCheckResult {
  ok: boolean
  state: UpdateState
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

// ── voice assistant (local Parakeet ASR) ──
/** Lifecycle of the local speech-to-text engine, surfaced to the Voice settings + HUD. */
export type VoiceEngineState =
  | 'missing' // the native engine OR the bundled model isn't present (degraded — never crashes)
  | 'idle' //    available but not loaded yet
  | 'loading' // model is being read into memory
  | 'ready' //   loaded and warm; transcription is instant-ish
  | 'error' //   load/transcribe failed (see `message`)
export interface VoiceStatus {
  state: VoiceEngineState
  /** True when the engine binary loaded (sherpa-onnx). */
  engineAvailable: boolean
  /** True when the bundled Parakeet model files were found on disk. */
  modelAvailable: boolean
  /** Human-readable detail for the missing/error states. */
  message?: string
  /** Model identifier, e.g. "parakeet-tdt-0.6b-v3-int8". */
  model?: string
}
export interface VoiceTranscribeRequest {
  /** Raw mono PCM as 32-bit floats in [-1, 1] (the utterance captured while the key was held). */
  pcm: ArrayBuffer
  /** Sample rate of `pcm`; sherpa-onnx resamples internally to the model's 16 kHz. */
  sampleRate: number
  /** Renderer-side capture device metadata, persisted only in local voice-debug diagnostics. */
  inputDeviceId?: string
  inputDeviceLabel?: string
  inputDeviceAuto?: boolean
  inputDeviceCandidates?: string[]
  /** True for the authoritative end-of-utterance decode (not a live partial). When set, main dumps
   *  the audio + transcript to userData/voice-debug for inspection. */
  final?: boolean
}
export interface VoiceTranscribeResult {
  ok: boolean
  /** Recognized text (trimmed); empty when nothing intelligible was heard. */
  text: string
  /** Set when ok is false (engine/model missing, or a decode error). */
  error?: string
}
/** Ask the cloud model (Gemini) to turn a transcript into a structured canvas action. */
export interface VoiceInterpretRequest {
  transcript: string
  /** Compact snapshot of the live canvas so the model can resolve references ("the 2nd terminal"). */
  context: string
  /** Gemini API key + model (kept in settings; the call is made from main to avoid CORS). */
  apiKey: string
  model: string
}
export interface VoiceInterpretResult {
  ok: boolean
  /** The action object the model returned; the renderer maps it to an Intent. Null on any failure. */
  action: Record<string, unknown> | null
  error?: string
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
    /**
     * Re-discover the detached Agent Host's live sessions (terminals that survived the app closing).
     * `keptTerminalIds` = every terminal-tab id across all persisted workspaces; host sessions whose
     * terminalId isn't in it are orphaned and get killed. Seed the terminal store from the result
     * BEFORE workspace panels mount, so they reattach (replaying buffered output) instead of respawning.
     */
    restore(keptTerminalIds?: string[]): Promise<TerminalRestoreResult>
    /** Phone-created terminals recorded while the app was CLOSED (materialize before restore). */
    pendingPanels(): Promise<PendingPanelsResult>
    clearPendingPanels(): Promise<void>
    /** A terminal/agent was created from the mobile web app while running → materialize live. */
    onExternalCreated(cb: (e: ExternalTerminalEvent) => void): Unsubscribe
    /** A terminal was closed (e.g. from the phone) → drop its canvas panel. */
    onSessionRemoved(cb: (e: SessionRemovedEvent) => void): Unsubscribe
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
    /** Blocking, non-enumerating final reconciliation used immediately before the window closes. */
    resolveSessionSync(ptyId: string, cwd: string): AgentSessionRef | null
    /** Whether the conversation behind `ref` still exists on disk for a resume run from `cwd`.
     *  `null` = unverifiable store (caller should proceed). */
    validateSession(ref: AgentSessionRef, cwd: string): Promise<boolean | null>
    /** Re-seed the sidecar so a just-resumed conversation keeps its id across the next restart. */
    reportSession(ptyId: string, ref: AgentSessionRef): void
  }
  /** Agent Mesh — canonical cross-workspace agent context + control (main-owned). */
  agentMesh: {
    /** Full mesh snapshot (every agent across every workspace) with workspace names. */
    getSnapshot(): Promise<AgentMeshSnapshot>
    /** Bounded, redacted clean tail for one PTY. */
    getTranscript(ptyId: string): Promise<{ text: string; truncated: boolean; redactions: number }>
    /** Recent timeline events (newest first). */
    getTimeline(limit?: number): Promise<{ events: ContextTimelineEvent[] }>
    /** In-memory context search (case-insensitive, redacted snippets). */
    search(q: string, opts?: {
      workspace?: string
      agent?: string
      terminal?: string
      limit?: number
    }): Promise<{
      ptyId: string
      terminalId: string
      panelId: string
      spaceId: string
      title: string
      cwd: string
      kind: string | null
      snippet: string
      matches: number
    }[]>
    /** Send a message to N agents (main writes each PTY; per-target results). */
    dispatch(req: MeshDispatchRequest): Promise<MeshDispatchResult>
    /** Send Ctrl-C (\x03) to one agent terminal. */
    interrupt(ptyId: string): Promise<{ ok: boolean }>
    /** Drop one PTY's clean context (tail + prompts). */
    clearContext(ptyId: string): Promise<{ ok: boolean }>
    /** Read the workspace scratchpad (redacted). */
    readScratchpad(): Promise<{ text: string; path: string; bytes: number }>
    /** Append (with timestamp + actor) to the workspace scratchpad. */
    writeScratchpad(entry: string): Promise<{ ok: boolean; bytes: number }>
    /** A mesh runtime/verdict/prompt changed in main → refresh the UI. */
    onChanged(cb: () => void): Unsubscribe
    /** A prompt was captured (keyboard/mesh/voice) in a terminal. */
    reportPrompt(e: AgentPromptEvent): void
    /** Live runtime metadata patch (OSC-7 cwd, title, number, workspace name). */
    reportRuntimeMeta(patch: AgentRuntimeMetaPatch): void
    /** Plan F7: mesh timeline events (agent-up/down, msg-*, spawn) → link layer + audit. */
    onMeshEvent(cb: (event: MeshUiEvent) => void): Unsubscribe
    /** Plan F8: a workspace asks the user once whether agents may write to each other. */
    onConsentRequest(cb: (e: { spaceId: string }) => void): Unsubscribe
    /** Plan F8: the user answered the consent toast. */
    respondConsent(ok: boolean): Promise<{ ok: boolean }>
    /** v4 B3: a chained task hit onFailure 'ask-user' — Fire / Cancel toast. */
    onChainAskRequest(cb: (e: { chainId: string; from: string; to: string }) => void): Unsubscribe
    /** v4 B3: the user answered the chain Fire / Cancel toast. */
    respondChainAsk(ok: boolean): Promise<{ ok: boolean }>
    /** v4 A5: cancel a chained task from the Mesh view (arming agent's behalf). */
    cancelChain(chainId: string): Promise<{ ok: boolean; error?: string | null }>
    /** v4 A5: list every chain for the Mesh view. */
    getChains(): Promise<{ ok: boolean; chains: unknown[]; error?: string }>
  }
  /** Mesh worktree fan-out — isolate parallel writing agents with git worktrees. */
  worktree: {
    /** Is the given folder a git repo? */
    isRepo(folder: string): Promise<{ ok: boolean }>
    /** Create N worktrees (own branch each) for a mission; returns paths+branches. */
    create(repo: string, mission: string, count: number): Promise<{ ok: boolean; worktrees?: WorktreeInfo[]; error?: string }>
    /** Dirty/ahead/behind for one worktree. */
    status(path: string): Promise<{ ok: boolean; info?: WorktreeInfo; error?: string }>
    /** Remove a worktree (refuses dirty unless force). */
    remove(path: string, force?: boolean): Promise<{ ok: boolean; error?: string }>
    /** Worktrees created this session. */
    list(): Promise<{ worktrees: WorktreeInfo[] }>
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
    /** One shallow directory listing (immediate children only) — the Files panel reads one
     *  directory at a time and expands lazily. Never a recursive walk. */
    readDirectory(req: FsReadDirectoryRequest): Promise<FsReadDirectoryResult>
    readFile(req: FsReadFileRequest): Promise<FsReadFileResult>
    writeFile(req: FsWriteFileRequest): Promise<FsWriteFileResult>
    /** Open a native folder picker; the chosen folder is granted read access. */
    pickFolder(): Promise<FsPickFolderResult>
    /** Read a file as base64 bytes (used to preview images inline). */
    readBinaryFile(req: FsReadBinaryFileRequest): Promise<FsReadBinaryFileResult>
    /** Absolute OS path of a DOM File from a drag-and-drop (resolved synchronously in the
     *  preload via webUtils; '' for non-OS drags like an image dragged off a web page). */
    pathForFile(file: unknown): string
    /** Stat a path dropped onto the canvas; existing paths are granted read access
     *  (the drop is the user gesture, same trust as the native folder picker). */
    dropPath(req: FsDropPathRequest): Promise<FsDropPathResult>
    /** Start watching a folder (recursively) so the Files panel refreshes on disk changes. */
    watch(req: FsWatchRequest): Promise<FsWatchResult>
    /** Stop watching a folder (ref-counted — the OS watcher closes when the last panel leaves). */
    unwatch(req: FsUnwatchRequest): Promise<FsUnwatchResult>
    /** A watched folder changed on disk (added/removed/modified files). */
    onChanged(cb: (e: FsChangedEvent) => void): Unsubscribe
    /** Create an empty file / folder (Files panel "New File / New Folder"). Fails if the name exists. */
    createEntry(req: FsCreateEntryRequest): Promise<FsCreateEntryResult>
    /** Rename a file/folder in place (same parent directory). Fails if the target name exists. */
    renameEntry(req: FsRenameEntryRequest): Promise<FsRenameEntryResult>
    /** Move a file/folder to the OS trash (recoverable — never a hard delete). */
    deleteEntry(req: FsDeleteEntryRequest): Promise<FsDeleteEntryResult>
  }
  time: {
    /** Read the persisted today / week / weekly-breakdown snapshot. */
    getStats(): Promise<TimeStats>
    /** Add active seconds to today's bucket; returns the updated snapshot. */
    addActive(req: TimeAddActiveRequest): Promise<TimeStats>
  }
  /** Live subscription usage (status bar provider chips) — collected by the Agent Host. */
  usage: {
    /** Current snapshot (cached by the host; populated instantly from <userData>/usage.json). */
    get(): Promise<UsageSnapshot>
    /** Force an immediate host refresh (file/network providers re-read now). */
    refresh(): Promise<{ ok: boolean }>
    /** The host pushed a fresh snapshot (hook POSTs, poll ticks, refreshes). */
    onChanged(cb: (snapshot: UsageSnapshot) => void): Unsubscribe
  }
  /** Status bar non-provider chips: listening ports + process RSS (Agent Host computed). */
  statusbar: {
    /** Ports owned by this workspace's terminals + agent/app RSS snapshot. */
    getAux(): Promise<StatusbarAux>
    /** The host re-scanned ports/resources. */
    onAuxChanged(cb: (aux: StatusbarAux) => void): Unsubscribe
    /** Kill a process by pid (user-confirmed; the popover's destructive action). */
    killPortPid(pid: number): Promise<{ ok: boolean }>
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
    /** LAN connection info for the PLANO mobile web app. */
    getRemoteInfo(): Promise<RemoteInfoResult>
  }
  update: {
    /** Current updater state (phase, progress, last error). */
    getState(): Promise<UpdateState>
    /** Force an immediate update check (button / app menu). */
    check(): Promise<UpdateCheckResult>
    /** Quit and install the downloaded update. No-op unless phase === 'downloaded'. */
    install(): Promise<{ ok: boolean }>
    /** Every updater state change (checking → downloading → downloaded → …). */
    onStatus(cb: (state: UpdateState) => void): () => void
  }
  settings: {
    /** Read the full settings document (always complete — defaults fill any gaps). */
    get(): Promise<PlanoSettings>
    /** Synchronous read for the first paint (preload → main via sendSync) — the saved theme
     *  is applied before the renderer shows anything, so launch never flashes a wrong theme. */
    getSync(): PlanoSettings
    /** Persist the full settings document; returns the merged/normalized result. */
    save(settings: PlanoSettings): Promise<{ ok: true; settings: PlanoSettings }>
  }
  voice: {
    /** Current engine + model availability (for the Voice settings panel + HUD readiness). */
    status(): Promise<VoiceStatus>
    /** Warm the recognizer (load the bundled model into memory). Idempotent; returns final status. */
    prepare(): Promise<VoiceStatus>
    /** Transcribe one captured utterance entirely on the local model (no network). */
    transcribe(req: VoiceTranscribeRequest): Promise<VoiceTranscribeResult>
    /** Interpret a transcript into a structured action via Gemini (cloud). Null action → use fuzzy. */
    interpret(req: VoiceInterpretRequest): Promise<VoiceInterpretResult>
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
