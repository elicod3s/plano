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
  AgentSignalEvent,
  WorkspaceOpenRequest,
  WorkspaceSaveRequest,
  FsReadTreeRequest,
  FsReadFileRequest,
  FsWriteFileRequest,
  FsReadBinaryFileRequest,
  TimeAddActiveRequest,
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
    onData: (cb) => subscribe<TerminalDataEvent>(CH.terminalData, cb),
    onExit: (cb) => subscribe<TerminalExitEvent>(CH.terminalExit, cb),
  },
  agent: {
    ping: (ptyId) => ipcRenderer.send(CH.agentPing, { ptyId }),
    onSignal: (cb) => subscribe<AgentSignalEvent>(CH.agentSignal, cb),
  },
  workspace: {
    open: (req: WorkspaceOpenRequest) => ipcRenderer.invoke(CH.workspaceOpen, req),
    save: (req: WorkspaceSaveRequest) => ipcRenderer.invoke(CH.workspaceSave, req),
    listRecent: () => ipcRenderer.invoke(CH.workspaceListRecent),
    pickFolder: () => ipcRenderer.invoke(CH.workspacePickFolder),
  },
  fs: {
    readTree: (req: FsReadTreeRequest) => ipcRenderer.invoke(CH.fsReadTree, req),
    readFile: (req: FsReadFileRequest) => ipcRenderer.invoke(CH.fsReadFile, req),
    writeFile: (req: FsWriteFileRequest) => ipcRenderer.invoke(CH.fsWriteFile, req),
    pickFolder: () => ipcRenderer.invoke(CH.fsPickFolder),
    readBinaryFile: (req: FsReadBinaryFileRequest) => ipcRenderer.invoke(CH.fsReadBinaryFile, req),
  },
  clipboard: {
    writeText: (text: string) => ipcRenderer.invoke(CH.clipboardWriteText, text),
    readText: () => ipcRenderer.invoke(CH.clipboardReadText),
  },
  shell: {
    revealPath: (path: string) => ipcRenderer.invoke(CH.shellRevealPath, path),
  },
  time: {
    getStats: () => ipcRenderer.invoke(CH.timeGetStats),
    addActive: (req: TimeAddActiveRequest) => ipcRenderer.invoke(CH.timeAddActive, req),
  },
  app: {
    getInfo: () => ipcRenderer.invoke(CH.appGetInfo),
  },
  window: {
    minimize: () => ipcRenderer.send(CH.windowMinimize),
    toggleMaximize: () => ipcRenderer.send(CH.windowToggleMaximize),
    close: () => ipcRenderer.send(CH.windowClose),
    isMaximized: () => ipcRenderer.invoke(CH.windowIsMaximized),
  },
}

contextBridge.exposeInMainWorld('plano', Object.freeze(api))
