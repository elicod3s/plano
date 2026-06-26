/**
 * The ONLY bridge between renderer and main. Exposes a single frozen `window.plano`
 * namespace of thin, typed wrappers — no business logic, no raw ipcRenderer leak.
 */

import { contextBridge, ipcRenderer } from 'electron'
import { CH } from '@shared/ipc/channels'
import type {
  PlanoApi,
  TerminalCreateRequest,
  TerminalDataEvent,
  TerminalExitEvent,
  DevUrlDetectedEvent,
  AgentSignalEvent,
  WorkspaceOpenRequest,
  WorkspaceOpenFolderEvent,
  WorkspaceSaveRequest,
  FsReadTreeRequest,
  FsReadFileRequest,
  FsWriteFileRequest,
  FsReadBinaryFileRequest,
  FsWatchRequest,
  FsUnwatchRequest,
  FsChangedEvent,
  TimeAddActiveRequest,
  GitStatusRequest,
  WorkspaceStateSaveRequest,
  VoiceTranscribeRequest,
  VoiceInterpretRequest,
} from '@shared/ipc/contracts'

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
    onData: (cb) => subscribe<TerminalDataEvent>(CH.terminalData, cb),
    onExit: (cb) => subscribe<TerminalExitEvent>(CH.terminalExit, cb),
    onUrlDetected: (cb) => subscribe<DevUrlDetectedEvent>(CH.terminalUrlDetected, cb),
  },
  agent: {
    ping: (ptyId) => ipcRenderer.send(CH.agentPing, { ptyId }),
    onSignal: (cb) => subscribe<AgentSignalEvent>(CH.agentSignal, cb),
    resolveSession: (ptyId, cwd) => ipcRenderer.invoke(CH.agentResolveSession, { ptyId, cwd }),
    validateSession: (ref, cwd) => ipcRenderer.invoke(CH.agentValidateSession, { ref, cwd }),
    reportSession: (ptyId, ref) => ipcRenderer.send(CH.agentReportSession, { ptyId, ref }),
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
    readTree: (req: FsReadTreeRequest) => ipcRenderer.invoke(CH.fsReadTree, req),
    readFile: (req: FsReadFileRequest) => ipcRenderer.invoke(CH.fsReadFile, req),
    writeFile: (req: FsWriteFileRequest) => ipcRenderer.invoke(CH.fsWriteFile, req),
    pickFolder: () => ipcRenderer.invoke(CH.fsPickFolder),
    readBinaryFile: (req: FsReadBinaryFileRequest) => ipcRenderer.invoke(CH.fsReadBinaryFile, req),
    watch: (req: FsWatchRequest) => ipcRenderer.invoke(CH.fsWatch, req),
    unwatch: (req: FsUnwatchRequest) => ipcRenderer.invoke(CH.fsUnwatch, req),
    onChanged: (cb) => subscribe<FsChangedEvent>(CH.fsChanged, cb),
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
  app: {
    getInfo: () => ipcRenderer.invoke(CH.appGetInfo),
    getLaunchFolder: () => ipcRenderer.invoke(CH.appGetLaunchFolder),
  },
  settings: {
    get: () => ipcRenderer.invoke(CH.settingsGet),
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
