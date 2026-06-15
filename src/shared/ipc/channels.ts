/**
 * Single source of truth for every IPC channel name. Importing these constants
 * (instead of string literals) keeps main / preload / renderer in lockstep.
 */
export const CH = {
  // ── terminal (PTY) ──
  terminalCreate: 'terminal:create',
  terminalWrite: 'terminal:write',
  terminalResize: 'terminal:resize',
  terminalKill: 'terminal:kill',
  terminalData: 'terminal:data', // main → renderer (event)
  terminalExit: 'terminal:exit', // main → renderer (event)

  // ── agent detection (the signature feature) ──
  agentPing: 'agent:ping',
  agentSignal: 'agent:signal', // main → renderer (event)

  // ── workspace persistence ──
  workspaceOpen: 'workspace:open',
  workspaceSave: 'workspace:save',
  workspaceListRecent: 'workspace:listRecent',
  workspacePickFolder: 'workspace:pickFolder',

  // ── filesystem (scoped to the open workspace) ──
  fsReadTree: 'fs:readTree',
  fsReadFile: 'fs:readFile',
  fsWriteFile: 'fs:writeFile',
  fsPickFolder: 'fs:pickFolder',
  fsReadBinaryFile: 'fs:readBinaryFile',

  // ── OS integration (clipboard + native file manager) ──
  clipboardWriteText: 'clipboard:writeText',
  shellRevealPath: 'shell:revealPath',

  // ── time tracking (top-bar usage chip) ──
  timeGetStats: 'time:getStats',
  timeAddActive: 'time:addActive',

  // ── app ──
  appGetInfo: 'app:getInfo',

  // ── window controls (frameless chrome) ──
  windowMinimize: 'window:minimize',
  windowToggleMaximize: 'window:toggleMaximize',
  windowClose: 'window:close',
  windowIsMaximized: 'window:isMaximized',
} as const

export type ChannelName = (typeof CH)[keyof typeof CH]
