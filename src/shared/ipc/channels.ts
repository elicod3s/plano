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
  /** Re-discover the detached Agent Host's live sessions on launch (herdr-style restore: terminals
   *  that survived the app closing reattach instead of respawning). */
  terminalRestore: 'terminal:restore', // renderer → main (invoke)
  terminalData: 'terminal:data', // main → renderer (event)
  terminalExit: 'terminal:exit', // main → renderer (event)
  terminalUrlDetected: 'terminal:urlDetected', // main → renderer (event) — local dev URL seen in output
  /** A terminal/agent was created from the MOBILE web app while PLANO is running → materialize its panel. */
  terminalExternalCreated: 'terminal:externalCreated', // main → renderer (event)
  /** A terminal was closed (e.g. from the phone) → the renderer drops its canvas panel. */
  terminalSessionRemoved: 'terminal:sessionRemoved', // main → renderer (event)
  /** Phone-created terminals recorded while the app was CLOSED → materialize at launch. */
  terminalPendingPanels: 'terminal:pendingPanels', // renderer → main (invoke)
  /** Plan F7: mesh timeline event (agent-up/down, msg-*, spawn) → renderer link layer. */
  meshEvent: 'mesh:event', // main → renderer (event)
  /** Plan F8: renderer asks whether mesh writes are allowed for a workspace (one-click toast). */
  meshConsentRequest: 'mesh:consentRequest', // main → renderer (event)
  meshConsentResponse: 'mesh:consentResponse', // renderer → main (invoke)
  /** v4 B3: chain onFailure 'ask-user' — Fire / Cancel toast. */
  chainAskRequest: 'mesh:chainAskRequest', // main → renderer (event)
  chainAskResponse: 'mesh:chainAskResponse', // renderer → main (invoke)
  /** v4 A5: cancel a chained task from the Mesh view. */
  meshChainCancel: 'mesh:chainCancel', // renderer → main (invoke)
  /** v4 A5: list every chain (Mesh view). */
  meshChainsGet: 'mesh:chainsGet', // renderer → main (invoke)

  // ── agent detection (the signature feature) ──
  agentPing: 'agent:ping',
  agentSignal: 'agent:signal', // main → renderer (event)
  agentResolveSession: 'agent:resolveSession', // renderer → main (invoke): resolve the running agent's conversation ref
  agentResolveSessionSync: 'agent:resolveSessionSync', // renderer → main (sendSync): final close reconciliation
  agentValidateSession: 'agent:validateSession', // renderer → main (invoke): does the on-disk conversation still exist
  agentReportSession: 'agent:reportSession', // renderer → main (send): re-seed the sidecar for a resumed session

  // ── agent mesh (canonical context + control, all in main) ──
  agentMeshGetSnapshot: 'agentMesh:getSnapshot', // renderer → main (invoke): full cross-workspace mesh snapshot
  agentMeshChanged: 'agentMesh:changed', // main → renderer (event): a runtime/verdict/prompt changed
  agentMeshGetTranscript: 'agentMesh:getTranscript', // renderer → main (invoke): bounded redacted tail for one pty
  agentMeshGetTimeline: 'agentMesh:getTimeline', // renderer → main (invoke): recent timeline events
  agentMeshSearch: 'agentMesh:search', // renderer → main (invoke): in-memory context search
  agentMeshDispatch: 'agentMesh:dispatch', // renderer → main (invoke): send a message to N agents (main-write, atomic)
  agentMeshInterrupt: 'agentMesh:interrupt', // renderer → main (invoke): \x03 to one agent
  agentMeshClearContext: 'agentMesh:clearContext', // renderer → main (invoke): drop one pty's clean context
  agentMeshReadScratchpad: 'agentMesh:readScratchpad', // renderer → main (invoke)
  agentMeshWriteScratchpad: 'agentMesh:writeScratchpad', // renderer → main (invoke, append)
  agentPrompt: 'agent:prompt', // renderer → main (send): prompt captured in a terminal
  agentRuntimeMeta: 'agent:runtimeMeta', // renderer → main (send): live cwd/title/number/spaceName patch

  // ── mesh worktree fan-out (git worktrees isolate parallel writing agents) ──
  worktreeIsRepo: 'worktree:isRepo', // renderer → main (invoke): is the workspace folder a git repo?
  worktreeCreate: 'worktree:create', // renderer → main (invoke): create N worktrees + branches
  worktreeStatus: 'worktree:status', // renderer → main (invoke): dirty/ahead/behind for a worktree
  worktreeRemove: 'worktree:remove', // renderer → main (invoke): remove (refuses dirty unless force)
  worktreeList: 'worktree:list', // renderer → main (invoke): tracked worktrees this session

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
  fsReadDirectory: 'fs:readDirectory', // shallow, single-level listing (lazy tree expansion)
  fsReadFile: 'fs:readFile',
  fsWriteFile: 'fs:writeFile',
  fsPickFolder: 'fs:pickFolder',
  fsReadBinaryFile: 'fs:readBinaryFile',
  fsDropPath: 'fs:dropPath', // stat a path dropped onto the canvas + grant read access (the drop is the user gesture)
  fsWatch: 'fs:watch', // start watching a workspace folder for live changes
  fsUnwatch: 'fs:unwatch', // stop watching it
  fsChanged: 'fs:changed', // main → renderer (event) — a watched folder changed on disk
  fsCreateEntry: 'fs:createEntry', // create a file/folder inside an allowed root (Files panel "New File/Folder")
  fsRenameEntry: 'fs:renameEntry', // rename a file/folder in place (same parent directory)
  fsDeleteEntry: 'fs:deleteEntry', // move a file/folder to the OS trash (recoverable, never a hard unlink)

  // ── OS integration (clipboard + native file manager) ──
  clipboardWriteText: 'clipboard:writeText',
  clipboardReadText: 'clipboard:readText',
  shellRevealPath: 'shell:revealPath',
  shellOpenExternal: 'shell:openExternal',

  // ── time tracking (top-bar usage chip) ──
  timeGetStats: 'time:getStats',
  timeAddActive: 'time:addActive',

  // ── status bar (live subscription usage · ports · resources) ──
  usageGet: 'usage:get', // renderer → main (invoke): current usage snapshot (cached by the host)
  usageRefresh: 'usage:refresh', // renderer → main (invoke): force an immediate host refresh
  usageChanged: 'usage:changed', // main → renderer (event): host pushed a new usage snapshot
  statusbarAuxGet: 'statusbar:auxGet', // renderer → main (invoke): ports + resources snapshot
  statusbarAuxChanged: 'statusbar:auxChanged', // main → renderer (event): ports/resources changed
  statusbarKillPid: 'statusbar:killPid', // renderer → main (invoke): taskkill a port owner (user-confirmed)

  // ── app ──
  appGetInfo: 'app:getInfo',
  appGetLaunchFolder: 'app:getLaunchFolder', // folder this instance was launched with (context menu)
  /** Connection info for the PLANO mobile web app (LAN IP + port + token). */
  appGetRemoteInfo: 'app:getRemoteInfo',

  // ── auto-update (GitHub releases) ──
  updateGetState: 'update:getState', // renderer → main (invoke): current updater state
  updateCheck: 'update:check', // renderer → main (invoke): force an update check now
  updateInstall: 'update:install', // renderer → main (invoke): quit + install the downloaded update
  updateStatus: 'update:status', // main → renderer (event): state changed (progress / ready / error)

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
