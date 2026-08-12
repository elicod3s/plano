/**
 * The ONLY bridge between renderer and main. Exposes a single frozen `window.plano`
 * namespace of thin, typed wrappers — no business logic, no raw ipcRenderer leak.
 */

import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { CH } from '@shared/ipc/channels'
import type { PlanoSettings } from '@shared/domain/settings'
import type {
  PlanoApi,
  TerminalCreateRequest,
  TerminalDataEvent,
  TerminalExitEvent,
  DevUrlDetectedEvent,
  AgentSignalEvent,
  ExternalTerminalEvent,
  SessionRemovedEvent,
  WorkspaceOpenRequest,
  WorkspaceOpenFolderEvent,
  WorkspaceSaveRequest,
  FsReadDirectoryRequest,
  FsReadFileRequest,
  FsWriteFileRequest,
  FsReadBinaryFileRequest,
  FsDropPathRequest,
  FsWatchRequest,
  FsUnwatchRequest,
  FsChangedEvent,
  FsCreateEntryRequest,
  FsRenameEntryRequest,
  FsDeleteEntryRequest,
  TimeAddActiveRequest,
  GitStatusRequest,
  WorkspaceStateSaveRequest,
  UpdateState,
  VoiceTranscribeRequest,
  VoiceInterpretRequest,
} from '@shared/ipc/contracts'
import type {
  AgentPromptEvent,
  AgentRuntimeMetaPatch,
  MeshDispatchRequest,
  MeshUiEvent,
} from '@shared/domain/agentMesh'

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: unknown, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: PlanoApi = {
  terminal: {
    create: (req: TerminalCreateRequest) => ipcRenderer.invoke(CH.terminalCreate, req),
    write: (ptyId, data) => ipcRenderer.send(CH.terminalWrite, { ptyId, data }),
    resize: (ptyId, cols, rows) => ipcRenderer.send(CH.terminalResize, { ptyId, cols, rows }),
    kill: (ptyId) => ipcRenderer.invoke(CH.terminalKill, { ptyId }),
    attach: (ptyId) => ipcRenderer.invoke(CH.terminalAttach, { ptyId }),
    detach: (ptyId) => ipcRenderer.send(CH.terminalDetach, { ptyId }),
    listProcesses: (ptyId) => ipcRenderer.invoke(CH.terminalListProcesses, { ptyId }),
    restore: (keptTerminalIds) => ipcRenderer.invoke(CH.terminalRestore, { keptTerminalIds }),
    pendingPanels: () => ipcRenderer.invoke(CH.terminalPendingPanels),
    clearPendingPanels: () => ipcRenderer.invoke(CH.terminalPendingPanels, { clear: true }),
    onExternalCreated: (cb) => subscribe<ExternalTerminalEvent>(CH.terminalExternalCreated, cb),
    onSessionRemoved: (cb) => subscribe<SessionRemovedEvent>(CH.terminalSessionRemoved, cb),
    onData: (cb) => subscribe<TerminalDataEvent>(CH.terminalData, cb),
    onExit: (cb) => subscribe<TerminalExitEvent>(CH.terminalExit, cb),
    onUrlDetected: (cb) => subscribe<DevUrlDetectedEvent>(CH.terminalUrlDetected, cb),
  },
  agent: {
    ping: (ptyId) => ipcRenderer.send(CH.agentPing, { ptyId }),
    onSignal: (cb) => subscribe<AgentSignalEvent>(CH.agentSignal, cb),
    resolveSession: (ptyId, cwd) => ipcRenderer.invoke(CH.agentResolveSession, { ptyId, cwd }),
    resolveSessionSync: (ptyId, cwd) =>
      ipcRenderer.sendSync(CH.agentResolveSessionSync, { ptyId, cwd }),
    validateSession: (ref, cwd) => ipcRenderer.invoke(CH.agentValidateSession, { ref, cwd }),
    reportSession: (ptyId, ref) => ipcRenderer.send(CH.agentReportSession, { ptyId, ref }),
  },
  agentMesh: {
    getSnapshot: () => ipcRenderer.invoke(CH.agentMeshGetSnapshot),
    getTranscript: (ptyId) => ipcRenderer.invoke(CH.agentMeshGetTranscript, { ptyId }),
    getTimeline: (limit) => ipcRenderer.invoke(CH.agentMeshGetTimeline, { limit }),
    search: (q, opts) => ipcRenderer.invoke(CH.agentMeshSearch, { q, opts }),
    dispatch: (req: MeshDispatchRequest) => ipcRenderer.invoke(CH.agentMeshDispatch, req),
    interrupt: (ptyId) => ipcRenderer.invoke(CH.agentMeshInterrupt, { ptyId }),
    clearContext: (ptyId) => ipcRenderer.invoke(CH.agentMeshClearContext, { ptyId }),
    readScratchpad: () => ipcRenderer.invoke(CH.agentMeshReadScratchpad),
    writeScratchpad: (entry) => ipcRenderer.invoke(CH.agentMeshWriteScratchpad, { entry }),
    onChanged: (cb) => subscribe(CH.agentMeshChanged, cb),
    reportPrompt: (e: AgentPromptEvent) => ipcRenderer.send(CH.agentPrompt, e),
    reportRuntimeMeta: (patch: AgentRuntimeMetaPatch) => ipcRenderer.send(CH.agentRuntimeMeta, patch),
    /** Plan F7: mesh timeline events (agent-up/down, msg-*) → link layer + audit trail. */
    onMeshEvent: (cb: (event: MeshUiEvent) => void) => subscribe(CH.meshEvent, cb),
    /** Plan F8: one-click consent toast (mesh writes per workspace). */
    onConsentRequest: (cb: (e: { spaceId: string }) => void) => subscribe(CH.meshConsentRequest, cb),
    respondConsent: (ok: boolean) => ipcRenderer.invoke(CH.meshConsentResponse, ok),
    /** v4 B3: chain onFailure 'ask-user' — Fire / Cancel toast. */
    onChainAskRequest: (cb: (e: { chainId: string; from: string; to: string }) => void) => subscribe(CH.chainAskRequest, cb),
    respondChainAsk: (ok: boolean) => ipcRenderer.invoke(CH.chainAskResponse, ok),
    /** v4 A5: cancel a chained task from the Mesh view. */
    cancelChain: (chainId: string) => ipcRenderer.invoke(CH.meshChainCancel, { chainId }),
    /** v4 A5: list every chain for the Mesh view. */
    getChains: () => ipcRenderer.invoke(CH.meshChainsGet),
  },
  worktree: {
    isRepo: (folder) => ipcRenderer.invoke(CH.worktreeIsRepo, { folder }),
    create: (repo, mission, count) => ipcRenderer.invoke(CH.worktreeCreate, { repo, mission, count }),
    status: (path) => ipcRenderer.invoke(CH.worktreeStatus, { path }),
    remove: (path, force) => ipcRenderer.invoke(CH.worktreeRemove, { path, force: force === true }),
    list: () => ipcRenderer.invoke(CH.worktreeList),
  },
  git: {
    status: (req: GitStatusRequest) => ipcRenderer.invoke(CH.gitStatus, req),
  },
  workspace: {
    open: (req: WorkspaceOpenRequest) => ipcRenderer.invoke(CH.workspaceOpen, req),
    save: (req: WorkspaceSaveRequest) => ipcRenderer.invoke(CH.workspaceSave, req),
    listRecent: () => ipcRenderer.invoke(CH.workspaceListRecent),
    pickFolder: () => ipcRenderer.invoke(CH.workspacePickFolder),
    onOpenFolder: (cb) => subscribe<WorkspaceOpenFolderEvent>(CH.workspaceOpenFolder, cb),
  },
  workspaces: {
    get: () => ipcRenderer.invoke(CH.workspacesGet),
    save: (req: WorkspaceStateSaveRequest) => ipcRenderer.invoke(CH.workspacesSave, req),
    saveSync: (req: WorkspaceStateSaveRequest) => ipcRenderer.sendSync(CH.workspacesSaveSync, req),
  },
  fs: {
    readDirectory: (req: FsReadDirectoryRequest) => ipcRenderer.invoke(CH.fsReadDirectory, req),
    readFile: (req: FsReadFileRequest) => ipcRenderer.invoke(CH.fsReadFile, req),
    writeFile: (req: FsWriteFileRequest) => ipcRenderer.invoke(CH.fsWriteFile, req),
    pickFolder: () => ipcRenderer.invoke(CH.fsPickFolder),
    readBinaryFile: (req: FsReadBinaryFileRequest) => ipcRenderer.invoke(CH.fsReadBinaryFile, req),
    // Electron ≥ 32 removed File.path — webUtils (preload-only) is the sanctioned replacement.
    pathForFile: (file: unknown) => {
      try {
        return webUtils.getPathForFile(file as File)
      } catch {
        return ''
      }
    },
    dropPath: (req: FsDropPathRequest) => ipcRenderer.invoke(CH.fsDropPath, req),
    watch: (req: FsWatchRequest) => ipcRenderer.invoke(CH.fsWatch, req),
    unwatch: (req: FsUnwatchRequest) => ipcRenderer.invoke(CH.fsUnwatch, req),
    onChanged: (cb) => subscribe<FsChangedEvent>(CH.fsChanged, cb),
    createEntry: (req: FsCreateEntryRequest) => ipcRenderer.invoke(CH.fsCreateEntry, req),
    renameEntry: (req: FsRenameEntryRequest) => ipcRenderer.invoke(CH.fsRenameEntry, req),
    deleteEntry: (req: FsDeleteEntryRequest) => ipcRenderer.invoke(CH.fsDeleteEntry, req),
  },
  clipboard: {
    writeText: (text: string) => ipcRenderer.invoke(CH.clipboardWriteText, text),
    readText: () => ipcRenderer.invoke(CH.clipboardReadText),
  },
  shell: {
    revealPath: (path: string) => ipcRenderer.invoke(CH.shellRevealPath, path),
    openExternal: (url: string) => ipcRenderer.invoke(CH.shellOpenExternal, url),
  },
  time: {
    getStats: () => ipcRenderer.invoke(CH.timeGetStats),
    addActive: (req: TimeAddActiveRequest) => ipcRenderer.invoke(CH.timeAddActive, req),
  },
  usage: {
    get: () => ipcRenderer.invoke(CH.usageGet),
    refresh: () => ipcRenderer.invoke(CH.usageRefresh),
    onChanged: (cb) => subscribe(CH.usageChanged, cb),
  },
  statusbar: {
    getAux: () => ipcRenderer.invoke(CH.statusbarAuxGet),
    onAuxChanged: (cb) => subscribe(CH.statusbarAuxChanged, cb),
    killPortPid: (pid: number) => ipcRenderer.invoke(CH.statusbarKillPid, { pid }),
  },
  app: {
    getInfo: () => ipcRenderer.invoke(CH.appGetInfo),
    getLaunchFolder: () => ipcRenderer.invoke(CH.appGetLaunchFolder),
    getRemoteInfo: () => ipcRenderer.invoke(CH.appGetRemoteInfo),
  },
  update: {
    getState: () => ipcRenderer.invoke(CH.updateGetState),
    check: () => ipcRenderer.invoke(CH.updateCheck),
    install: () => ipcRenderer.invoke(CH.updateInstall),
    onStatus: (cb) => subscribe<UpdateState>(CH.updateStatus, cb),
  },
  settings: {
    /** Read the full settings document (always complete — defaults fill any gaps). */
    get: () => ipcRenderer.invoke(CH.settingsGet),
    /** Synchronous read for the first paint (preload → main via sendSync) so the saved
     *  theme applies before the renderer shows anything (no wrong-theme launch flash). */
    getSync: () => ipcRenderer.sendSync(CH.settingsGet) as PlanoSettings,
    save: (settings) => ipcRenderer.invoke(CH.settingsSave, settings),
  },
  voice: {
    status: () => ipcRenderer.invoke(CH.voiceStatus),
    prepare: () => ipcRenderer.invoke(CH.voicePrepare),
    transcribe: (req: VoiceTranscribeRequest) => ipcRenderer.invoke(CH.voiceTranscribe, req),
    interpret: (req: VoiceInterpretRequest) => ipcRenderer.invoke(CH.voiceInterpret, req),
  },
  session: {
    get: () => ipcRenderer.invoke(CH.sessionGet),
    set: (folderPath: string | null) => ipcRenderer.invoke(CH.sessionSet, { folderPath }),
  },
  window: {
    minimize: () => ipcRenderer.send(CH.windowMinimize),
    toggleMaximize: () => ipcRenderer.send(CH.windowToggleMaximize),
    close: () => ipcRenderer.send(CH.windowClose),
    isMaximized: () => ipcRenderer.invoke(CH.windowIsMaximized),
  },
}

contextBridge.exposeInMainWorld('plano', Object.freeze(api))
