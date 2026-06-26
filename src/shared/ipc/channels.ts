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
  terminalAttach: 'terminal:attach', // re-bind a remounted panel to its still-running PTY (replays buffer)
  terminalDetach: 'terminal:detach', // panel left (space switch) — keep the PTY alive, buffer its output
  terminalListProcesses: 'terminal:listProcesses',
  terminalData: 'terminal:data', // main → renderer (event)
  terminalExit: 'terminal:exit', // main → renderer (event)
  terminalUrlDetected: 'terminal:urlDetected', // main → renderer (event) — local dev URL seen in output

  // ── agent detection (the signature feature) ──
  agentPing: 'agent:ping',
  agentSignal: 'agent:signal', // main → renderer (event)
  agentResolveSession: 'agent:resolveSession', // renderer → main (invoke): resolve the running agent's conversation ref
  agentValidateSession: 'agent:validateSession', // renderer → main (invoke): does the on-disk conversation still exist
  agentReportSession: 'agent:reportSession', // renderer → main (send): re-seed the sidecar for a resumed session

  // ── git (read-only status for a folder, e.g. a terminal's cwd) ──
  gitStatus: 'git:status',

  // ── workspace persistence ──
  workspaceOpen: 'workspace:open',
  workspaceSave: 'workspace:save',
  workspaceListRecent: 'workspace:listRecent',
  workspacePickFolder: 'workspace:pickFolder',
  workspaceOpenFolder: 'workspace:openFolder', // main → renderer (event) — "Open in PLANO" while running

  // ── app-global open-workspaces state (every open workspace + the active one) ──
  workspacesGet: 'workspaces:get',
  workspacesSave: 'workspaces:save',
  workspacesSaveSync: 'workspaces:saveSync', // blocking final flush on window close / app quit

  // ── filesystem (scoped to the open workspace) ──
  fsReadTree: 'fs:readTree',
  fsReadFile: 'fs:readFile',
  fsWriteFile: 'fs:writeFile',
  fsPickFolder: 'fs:pickFolder',
  fsReadBinaryFile: 'fs:readBinaryFile',
  fsWatch: 'fs:watch', // start watching a workspace folder for live changes
  fsUnwatch: 'fs:unwatch', // stop watching it
  fsChanged: 'fs:changed', // main → renderer (event) — a watched folder changed on disk

  // ── OS integration (clipboard + native file manager) ──
  clipboardWriteText: 'clipboard:writeText',
  clipboardReadText: 'clipboard:readText',
  shellRevealPath: 'shell:revealPath',
  shellOpenExternal: 'shell:openExternal',

  // ── time tracking (top-bar usage chip) ──
  timeGetStats: 'time:getStats',
  timeAddActive: 'time:addActive',

  // ── app ──
  appGetInfo: 'app:getInfo',
  appGetLaunchFolder: 'app:getLaunchFolder', // folder this instance was launched with (context menu)

  // ── settings (app-global preferences) ──
  settingsGet: 'settings:get',
  settingsSave: 'settings:save',

  // ── voice assistant "Odla" (local Parakeet ASR; the orchestrator's ears) ──
  voiceStatus: 'voice:status', // is the engine/model available + loaded?
  voicePrepare: 'voice:prepare', // warm the recognizer (load the model into memory)
  voiceTranscribe: 'voice:transcribe', // PCM utterance → text (offline, on the local model)
  voiceInterpret: 'voice:interpret', // transcript → structured action via Gemini (cloud), fuzzy is the fallback

  // ── session (the live "which project is open" pointer, for launch restore) ──
  sessionGet: 'session:get',
  sessionSet: 'session:set',

  // ── window controls (frameless chrome) ──
  windowMinimize: 'window:minimize',
  windowToggleMaximize: 'window:toggleMaximize',
  windowClose: 'window:close',
  windowIsMaximized: 'window:isMaximized',
} as const

export type ChannelName = (typeof CH)[keyof typeof CH]
