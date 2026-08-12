/**
 * Registers every ipcMain handler in one place and routes it to a service.
 * Renderer → main is `handle` (request/response) or `on` (fire-and-forget).
 * Each handler is the trust boundary: validate inputs before touching a service.
 */

import { ipcMain, app, BrowserWindow, shell, clipboard } from 'electron'
import { randomUUID } from 'node:crypto'
import { promises as fs, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'
import { CH } from '@shared/ipc/channels'
import type {
  TerminalCreateRequest,
  WorkspaceOpenRequest,
  WorkspaceSaveRequest,
  FsReadDirectoryRequest,
  FsReadFileRequest,
  FsWriteFileRequest,
  FsReadBinaryFileRequest,
  FsDropPathRequest,
  FsWatchRequest,
  FsUnwatchRequest,
  FsCreateEntryRequest,
  FsRenameEntryRequest,
  FsDeleteEntryRequest,
  TimeAddActiveRequest,
  GitStatusRequest,
  AppInfo,
  SessionSetRequest,
  WorkspaceStateSaveRequest,
} from '@shared/ipc/contracts'
import type { AgentSessionRef, ResumableAgent } from '@shared/domain/agent'
import { RESUMABLE_AGENTS, SESSION_ID_RE } from '@shared/domain/agent'
import type { PtyManager } from '../services/PtyManager'
import type { WorkspaceService } from '../services/WorkspaceService'
import type { WorkspaceStateService } from '../services/WorkspaceStateService'
import type { FileSystemService } from '../services/FileSystemService'
import type { FileWatcherService } from '../services/FileWatcherService'
import type { GitService } from '../services/GitService'
import type { TimeTrackingService } from '../services/TimeTrackingService'
import type { SettingsService } from '../services/SettingsService'
import type { SessionService } from '../services/SessionService'
import type { VoiceService } from '../services/VoiceService'
import type { VoiceTranscribeRequest, VoiceInterpretRequest } from '@shared/ipc/contracts'
import type { AgentSessionService } from '../services/AgentSessionService'
import type { AgentContextService } from '../services/AgentContextService'
import type { MeshWorktreeService } from '../services/MeshWorktreeService'
import { MESH_LIMITS } from '../services/AgentContextService'
import { redactContext } from '../services/contextRedaction'
import type { WebviewMotionService } from '../services/WebviewMotionService'
import type { DiagnosticsService } from '../services/DiagnosticsService'
import type { UpdateService } from '../services/UpdateService'

export interface Services {
  diagnostics: DiagnosticsService
  pty: PtyManager
  workspace: WorkspaceService
  workspaceState: WorkspaceStateService
  fs: FileSystemService
  fileWatcher: FileWatcherService
  git: GitService
  time: TimeTrackingService
  settings: SettingsService
  session: SessionService
  voice: VoiceService
  agentSession: AgentSessionService
  agentContext: AgentContextService
  worktree: MeshWorktreeService
  webviewMotion: WebviewMotionService
  update: UpdateService
}

/** Cross-cutting bits the handlers need that aren't a service (e.g. launch arguments). */
export interface IpcEnv {
  /** Returns the folder PLANO was launched with ("Open in PLANO"), clearing it so a reload won't reopen. */
  takeLaunchFolder: () => string | null
}

/** Valid resume targets (the values of RESUMABLE_AGENTS) — the trust boundary's allow-list. */
const RESUMABLE_SET = new Set<ResumableAgent>(Object.values(RESUMABLE_AGENTS) as ResumableAgent[])

/** Validate an AgentSessionRef arriving over IPC; null if malformed (rejected). */
function sanitizeRef(raw: unknown): AgentSessionRef | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as { agent?: unknown; sessionId?: unknown; cwd?: unknown }
  if (typeof r.agent !== 'string' || !RESUMABLE_SET.has(r.agent as ResumableAgent)) return null
  if (typeof r.cwd !== 'string') return null
  if (r.sessionId !== undefined && (typeof r.sessionId !== 'string' || !SESSION_ID_RE.test(r.sessionId)))
    return null
  return { agent: r.agent as ResumableAgent, sessionId: r.sessionId as string | undefined, cwd: r.cwd }
}

/** A stable id (panel/terminal/space/pty): string, ≤128 chars, safe charset. '' → invalid. */
function validId(v: unknown): string | null {
  if (typeof v !== 'string' || v.length === 0 || v.length > 128) return null
  return /^[\w.:-]+$/.test(v) ? v : null
}

export function registerIpc(services: Services, env: IpcEnv): void {
  const { diagnostics, pty, workspace, workspaceState, fs, fileWatcher, git, time, settings,
    session, voice, agentSession, agentContext, worktree, webviewMotion, update } = services

  // ── terminal ──
  // Stable identity fields (panelId/terminalId/spaceId) are validated here — the trust
  // boundary for the agent-mesh topology. Anything non-string, overlong, or with
  // unexpected characters is rejected so a tampered renderer can't smuggle garbage.
  ipcMain.handle(CH.terminalCreate, (_e, req: TerminalCreateRequest) => {
    const panelId = validId(req?.panelId)
    const terminalId = validId(req?.terminalId)
    const spaceId = validId(req?.spaceId)
    if (!panelId || !terminalId || !spaceId) {
      return { ptyId: '', pid: -1, shellName: 'invalid', cwd: '' }
    }
    return pty.create({ ...req, panelId, terminalId, spaceId })
  })
  ipcMain.on(CH.terminalWrite, (_e, p: { ptyId: string; data: string }) => pty.write(p.ptyId, p.data))
  ipcMain.on(CH.terminalResize, (_e, p: { ptyId: string; cols: number; rows: number }) =>
    pty.resize(p.ptyId, p.cols, p.rows),
  )
  ipcMain.handle(CH.terminalKill, (_e, p: { ptyId: string }) => pty.kill(p.ptyId))
  ipcMain.handle(CH.terminalAttach, (_e, p: { ptyId: string }) => pty.attach(p.ptyId))
  ipcMain.on(CH.terminalDetach, (_e, p: { ptyId: string }) => pty.detach(p.ptyId))
  ipcMain.handle(CH.terminalListProcesses, async (_e, p: { ptyId: string }) => ({
    processes: await pty.listProcesses(p.ptyId),
  }))
  // Restore: re-discover the detached Agent Host's live sessions (terminals that survived the app
  // closing). keptTerminalIds = every terminal-tab id across all persisted workspaces — host
  // sessions not in it are orphaned and killed. The renderer seeds its terminal store from this
  // BEFORE panels mount, so surviving terminals reattach instead of respawning.
  ipcMain.handle(CH.terminalRestore, async (_e, p: { keptTerminalIds?: unknown }) => {
    const raw = Array.isArray(p?.keptTerminalIds) ? p.keptTerminalIds : []
    const kept =
      raw.length === 0
        ? undefined
        : [...new Set(raw.filter((x): x is string => typeof x === 'string' && validId(x) !== null))].slice(0, 500)
    try {
      const sessions = await pty.restoreSessions(kept)
      return { sessions }
    } catch (err) {
      diagnostics.log('terminal-restore-failed', { error: String(err) })
      return { sessions: [] }
    }
  })
  // Pending panels (terminals/agents created from the MOBILE web app while PLANO was closed).
  // The renderer materializes them into their workspaces BEFORE restore so their live sessions
  // are in the kept set (no orphan kill) and reattach.
  ipcMain.handle(CH.terminalPendingPanels, async (_e, p: { clear?: unknown }) => {
    if (p?.clear === true) {
      await pty.clearPendingPanels().catch(() => undefined)
      return { panels: [] }
    }
    try {
      const panels = await pty.pendingPanels()
      return { panels }
    } catch (err) {
      diagnostics.log('terminal-pending-failed', { error: String(err) })
      return { panels: [] }
    }
  })

  // ── agent detection ──
  ipcMain.on(CH.agentPing, (_e, p: { ptyId: string }) => pty.ping(p.ptyId))
  ipcMain.handle(CH.agentResolveSession, (_e, p: { ptyId: string; cwd: string }) => {
    if (!p || typeof p.ptyId !== 'string' || !/^[\w-]+$/.test(p.ptyId)) return null
    if (typeof p.cwd !== 'string') return null
    return agentSession.resolve(p.ptyId, p.cwd)
  })
  ipcMain.on(CH.agentResolveSessionSync, (e, p: { ptyId: string; cwd: string }) => {
    if (!p || typeof p.ptyId !== 'string' || !/^[\w-]+$/.test(p.ptyId)) {
      e.returnValue = null
      return
    }
    if (typeof p.cwd !== 'string') {
      e.returnValue = null
      return
    }
    e.returnValue = agentSession.resolveSync(p.ptyId, p.cwd)
  })
  ipcMain.handle(CH.agentValidateSession, (_e, p: { ref: unknown; cwd: string }) => {
    const ref = sanitizeRef(p?.ref)
    if (!ref || typeof p?.cwd !== 'string') return null
    return agentSession.validate(ref, p.cwd)
  })
  ipcMain.on(CH.agentReportSession, (_e, p: { ptyId: string; ref: unknown }) => {
    const ref = sanitizeRef(p?.ref)
    if (!ref || typeof p?.ptyId !== 'string' || !/^[\w-]+$/.test(p.ptyId)) return
    agentSession.report(p.ptyId, ref)
  })

  // ── agent mesh (canonical context + control, main-owned) ──
  // Prompt captured in a terminal (keyboard/mesh/voice) → canonical context + timeline.
  ipcMain.on(CH.agentPrompt, (_e, p: unknown) => {
    if (!p || typeof p !== 'object') return
    const { ptyId, text, first, source } = p as {
      ptyId?: unknown
      text?: unknown
      first?: unknown
      source?: unknown
    }
    if (typeof ptyId !== 'string' || !/^[\w-]+$/.test(ptyId)) return
    if (typeof text !== 'string' || !text.trim()) return
    const src =
      source === 'mesh' || source === 'voice' || source === 'keyboard' ? source : 'keyboard'
    agentContext.recordPrompt({
      ptyId,
      text: text.slice(0, 4096),
      first: first === true,
      source: src,
      at: Date.now(),
    })
  })
  // Live runtime metadata patch (OSC-7 cwd, title, numbering, workspace name) with debounce/dedupe.
  ipcMain.on(CH.agentRuntimeMeta, (_e, p: unknown) => {
    if (!p || typeof p !== 'object') return
    const patch = p as { ptyId?: unknown; cwd?: unknown; terminalTitle?: unknown; tabTitle?: unknown; terminalNumber?: unknown; spaceName?: unknown }
    if (typeof patch.ptyId !== 'string' || !/^[\w-]+$/.test(patch.ptyId)) return
    if (typeof patch.cwd === 'string' && patch.cwd) pty.updateRuntimeMeta(patch.ptyId, { cwd: patch.cwd })
    if (typeof patch.terminalTitle === 'string' && patch.terminalTitle)
      pty.updateRuntimeMeta(patch.ptyId, { title: patch.terminalTitle })
  })

  // Full cross-workspace mesh snapshot. The descriptor is assembled HERE in main from the
  // canonical context + PtyManager identity + workspace state — never fabricated in the renderer.
  ipcMain.handle(CH.agentMeshGetSnapshot, async () => {
    const { state } = await workspaceState.get()
    const spaces = state?.workspaces ?? []
    const spaceById = new Map(spaces.map((s) => [s.id, s]))
    const nameById = new Map(spaces.map((s) => [s.id, s.name]))
    // Opt-in persistence: when enabled, write the redacted context index to the active
    // workspace's .plano/context/ so a restart can re-search it (fire-and-forget).
    const meshSettings = await settings.get()
    if (meshSettings.agentMesh.contextPersistence && state?.activeId) {
      const active = state.workspaces.find((s) => s.id === state.activeId)
      if (active?.folderPath) {
        void agentContext
          .persistIndex(active.folderPath, meshSettings.agentMesh.maxPersistBytes)
          .catch(() => undefined)
      }
    }
    // Panel/tab metadata (title, number, tabTitle) resolves from the workspace snapshots.
    const panelMeta = new Map<string, { title: string; number?: number; tabs?: Array<{ id: string; title?: string }> }>()
    for (const sp of spaces) {
      for (const panel of sp.panels) {
        if (panel.type !== 'terminal') continue
        const props = panel.props as { terminalNumber?: number; tabs?: Array<{ id: string; title?: string }>; title?: string }
        panelMeta.set(panel.id, {
          title: (panel as { title?: string }).title || 'Terminal',
          number: props.terminalNumber,
          tabs: props.tabs,
        })
      }
    }

    const agents = agentContext
      .snapshot()
      .map((entry) => {
        const meta = pty.runtimeMeta(entry.ptyId)
        const space = spaceById.get(entry.spaceId)
        const pm = panelMeta.get(entry.panelId)
        const tab = pm?.tabs?.find((t) => t.id === entry.terminalId)
        const active = entry.verdict.active
        const capabilities: string[] = active
          ? ['prompt', 'interrupt', 'resume']
          : []
        return {
          ptyId: entry.ptyId,
          terminalId: entry.terminalId,
          panelId: entry.panelId,
          spaceId: entry.spaceId,
          spaceName: nameById.get(entry.spaceId) ?? space?.folderPath ?? '',
          terminalNumber: pm?.number ?? 0,
          // Prefer the terminal TAB's smart title (the task label) over the panel title.
          terminalTitle: tab?.title ?? pm?.title ?? entry.title ?? 'Terminal',
          tabTitle: tab?.title ?? '',
          cwd: entry.cwd || meta?.cwd || '',
          pid: meta?.pid ?? entry.pid ?? 0,
          shell: meta?.shellName ?? '',
          status: entry.exited ? 'exited' : 'ready',
          verdict: entry.verdict,
          firstPrompt: entry.firstPrompt,
          lastPrompt: entry.lastPrompt,
          modelLabel: undefined,
          providerLabel: undefined,
          capabilities,
          lastOutputAt: entry.lastOutputAt,
          updatedAt: entry.updatedAt,
        }
      })
      .sort((a, b) => b.updatedAt - a.updatedAt)

    return {
      agents,
      workspaceNames: Object.fromEntries(nameById),
      usageBytes: agentContext.usageBytes(),
      takenAt: Date.now(),
    }
  })

  // Bounded, redacted clean tail for one PTY.
  ipcMain.handle(CH.agentMeshGetTranscript, (_e, p: { ptyId: string }) => {
    if (!p || typeof p.ptyId !== 'string' || !/^[\w-]+$/.test(p.ptyId)) return { text: '', truncated: false, redactions: 0 }
    return agentContext.transcript(p.ptyId)
  })

  // Recent timeline events (newest first).
  ipcMain.handle(CH.agentMeshGetTimeline, (_e, p: { limit?: unknown }) => {
    const limit =
      p && typeof p.limit === 'number' && Number.isFinite(p.limit)
        ? Math.min(500, Math.max(1, Math.floor(p.limit)))
        : 200
    return { events: agentContext.timelineEvents(limit) }
  })

  // In-memory context search with workspace/agent/terminal filters.
  ipcMain.handle(CH.agentMeshSearch, (_e, p: { q?: unknown; opts?: unknown }) => {
    const q = typeof p?.q === 'string' ? p.q : ''
    const o = (p?.opts ?? {}) as { workspace?: unknown; agent?: unknown; terminal?: unknown; limit?: unknown }
    return agentContext.search(q, {
      workspace: typeof o.workspace === 'string' ? o.workspace : undefined,
      agent: typeof o.agent === 'string' ? o.agent : undefined,
      terminal: typeof o.terminal === 'string' ? o.terminal : undefined,
      limit: typeof o.limit === 'number' ? Math.min(200, Math.max(1, Math.floor(o.limit))) : undefined,
    })
  })

  // ── mesh dispatch (multi-target, main-write, atomic) ──
  // Flow: validate → dedupe → cap → check pty exists/not exited/has active agent → onlyWhenIdle →
  // compose context (redacted) → cap size → write each PTY → record prompt(source mesh) + event →
  // per-target result. Normal shells are NEVER targets.
  ipcMain.handle(
    CH.agentMeshDispatch,
    async (_e, req: { targetPtyIds?: unknown; message?: unknown; includeContext?: unknown; onlyWhenIdle?: unknown }) => {
      const targets = Array.isArray(req?.targetPtyIds)
        ? [...new Set(req.targetPtyIds.filter((x): x is string => typeof x === 'string' && /^[\w-]+$/.test(x)))]
        : []
      const message = typeof req?.message === 'string' ? req.message.trim() : ''
      const includeContext = req?.includeContext !== false
      const onlyWhenIdle = req?.onlyWhenIdle === true

      if (!message) return { results: [], ok: false }
      if (targets.length > MESH_LIMITS.maxDispatchTargets) targets.length = MESH_LIMITS.maxDispatchTargets

      // Compose the shared-context block from the live mesh snapshot (redacted, metadata-only).
      let contextBlock = ''
      if (includeContext) {
        contextBlock = buildMeshContext(services)
      }

      const fullMessage = contextBlock ? `${contextBlock}\n\n${message}` : message
      const { text: finalMessage, truncated } =
        fullMessage.length > MESH_LIMITS.maxDispatchBytes
          ? { text: fullMessage.slice(0, MESH_LIMITS.maxDispatchBytes), truncated: true }
          : { text: fullMessage, truncated: false }

      const results: {
        ptyId: string
        ok: boolean
        error?: string
        delivered?: boolean
        bytes?: number
      }[] = []
      for (const ptyId of targets) {
        const meta = pty.runtimeMeta(ptyId)
        if (!meta) {
          results.push({ ptyId, ok: false, error: 'not-found' })
          continue
        }
        if (meta.exited) {
          results.push({ ptyId, ok: false, error: 'exited' })
          continue
        }
        const verdict = agentContext.entry(ptyId)?.verdict
        if (!verdict?.active) {
          results.push({ ptyId, ok: false, error: 'not-agent' })
          continue
        }
        if (onlyWhenIdle && verdict.phase !== 'idle') {
          results.push({ ptyId, ok: false, error: 'working' })
          continue
        }
        try {
          pty.write(ptyId, finalMessage + '\r')
          results.push({ ptyId, ok: true, delivered: true, bytes: finalMessage.length })
          agentContext.recordPrompt({ ptyId, text: message, first: false, source: 'mesh', at: Date.now() })
          agentContext.recordDispatch(ptyId, message)
        } catch {
          results.push({ ptyId, ok: false, error: 'write-failed' })
        }
      }
      return {
        results,
        ok: results.some((r) => r.ok),
        context: contextBlock || undefined,
        truncated,
      }
    },
  )

  // Interrupt one agent: write \x03 ONLY after re-validating the target. Never marks it exited.
  ipcMain.handle(CH.agentMeshInterrupt, (_e, p: { ptyId: string }) => {
    const ptyId = p?.ptyId
    if (typeof ptyId !== 'string' || !/^[\w-]+$/.test(ptyId)) return { ok: false }
    const meta = pty.runtimeMeta(ptyId)
    if (!meta || meta.exited) return { ok: false }
    const verdict = agentContext.entry(ptyId)?.verdict
    if (!verdict?.active) return { ok: false }
    try {
      pty.write(ptyId, '\x03')
      return { ok: true }
    } catch {
      return { ok: false }
    }
  })

  // Drop one PTY's clean context (tail + prompts). The PTY itself keeps running.
  ipcMain.handle(CH.agentMeshClearContext, (_e, p: { ptyId: string }) => {
    const ptyId = p?.ptyId
    if (typeof ptyId !== 'string' || !/^[\w-]+$/.test(ptyId)) return { ok: false }
    agentContext.clearContext(ptyId)
    return { ok: true }
  })

  // Scratchpad: <workspace>/.plano/agent-scratchpad.md — fixed path, bounded, atomic, serialised.
  ipcMain.handle(CH.agentMeshReadScratchpad, async () => {
    const result = await scratchpadIO(services)
    return result
  })
  ipcMain.handle(CH.agentMeshWriteScratchpad, async (_e, p: { entry?: unknown }) => {
    const entry = typeof p?.entry === 'string' ? p.entry.trim() : ''
    if (!entry) return { ok: false, bytes: 0 }
    return appendScratchpad(services, entry)
  })

  // ── git (read-only) ──
  ipcMain.handle(CH.gitStatus, (_e, req: GitStatusRequest) => git.status(req))

  // ── workspace ──
  ipcMain.handle(CH.workspaceOpen, async (_e, req: WorkspaceOpenRequest) => {
    const result = await workspace.open(req)
    fs.setAllowedRoot(result.folderPath)
    // Re-grant read access to folders that editor panels opened in a previous session,
    // so their file trees load on reload without forcing the user to re-pick.
    for (const space of result.workspace.spaces) {
      for (const p of space.panels) {
        if (p.type === 'editor' && p.props.folderPath) fs.setAllowedRoot(p.props.folderPath)
        // Legacy File Explorer panels (pre-merge) carry the folder in `rootPath`;
        // grant it too so the migrated Files panel can read its tree on first load.
        else if (p.type === 'files' && p.props.rootPath) fs.setAllowedRoot(p.props.rootPath)
      }
    }
    return result
  })
  ipcMain.handle(CH.workspaceSave, (_e, req: WorkspaceSaveRequest) => workspace.save(req))
  ipcMain.handle(CH.workspaceListRecent, () => workspace.listRecent())
  ipcMain.handle(CH.workspacePickFolder, () => workspace.pickFolder())

  // App-global open-workspaces state (the single source of truth, hydrated on launch).
  ipcMain.handle(CH.workspacesGet, async () => {
    const result = await workspaceState.get()
    // Re-grant read access to every workspace's own folder + any editor/files panel root, so file
    // trees load on launch without re-picking (mirrors the per-folder workspace.open grant above).
    for (const ws of result.state?.workspaces ?? []) {
      if (ws.folderPath) fs.setAllowedRoot(ws.folderPath)
      for (const p of ws.panels) {
        if (p.type === 'editor' && p.props.folderPath) fs.setAllowedRoot(p.props.folderPath)
        else if (p.type === 'files' && p.props.rootPath) fs.setAllowedRoot(p.props.rootPath)
      }
    }
    return result
  })
  ipcMain.handle(CH.workspacesSave, (_e, req: WorkspaceStateSaveRequest) => workspaceState.save(req))
  // Blocking final flush for the renderer's `beforeunload` (window close / quit) — guarantees the
  // last note/todo edit hits disk before the renderer is torn down (the async save can't finish in time).
  ipcMain.on(CH.workspacesSaveSync, (e, req: WorkspaceStateSaveRequest) => {
    e.returnValue = workspaceState.saveSync(req)
  })

  // ── filesystem ──
  // Shallow listing for lazy tree expansion (same path guard as readTree had — the service resolves).
  ipcMain.handle(CH.fsReadDirectory, (_e, req: FsReadDirectoryRequest) => fs.readDirectory(req))
  ipcMain.handle(CH.fsReadFile, (_e, req: FsReadFileRequest) => fs.readFile(req))
  ipcMain.handle(CH.fsWriteFile, (_e, req: FsWriteFileRequest) => fs.writeFile(req))
  // The native dialog is an explicit user gesture, so the chosen folder is trusted:
  // grant it as an allowed root before returning so the editor can read its tree.
  ipcMain.handle(CH.fsPickFolder, async () => {
    const { folderPath } = await workspace.pickFolder()
    if (folderPath) fs.setAllowedRoot(folderPath)
    return { folderPath }
  })
  ipcMain.handle(CH.fsReadBinaryFile, (_e, req: FsReadBinaryFileRequest) => fs.readBinaryFile(req))
  // Dragging a file/folder from the OS onto the canvas is an explicit user gesture (like the
  // dialog above), so the dropped path is trusted: stat it and grant read access to its folder.
  ipcMain.handle(CH.fsDropPath, (_e, req: FsDropPathRequest) => fs.registerDroppedPath(req))
  // Live folder watching for the Files panel. The service self-guards on allowed roots.
  ipcMain.handle(CH.fsWatch, (_e, req: FsWatchRequest) => fileWatcher.watch(req.dir))
  ipcMain.handle(CH.fsUnwatch, (_e, req: FsUnwatchRequest) => fileWatcher.unwatch(req.dir))
  // File-manager operations (Files panel). The service validates paths + names; delete is
  // always a recoverable move to the OS trash, never a hard unlink.
  ipcMain.handle(CH.fsCreateEntry, (_e, req: FsCreateEntryRequest) => fs.createEntry(req))
  ipcMain.handle(CH.fsRenameEntry, (_e, req: FsRenameEntryRequest) => fs.renameEntry(req))
  ipcMain.handle(CH.fsDeleteEntry, async (_e, req: FsDeleteEntryRequest) => {
    await shell.trashItem(fs.resolveForDelete(req.path))
    return { ok: true }
  })

  // ── OS integration ──
  ipcMain.handle(CH.clipboardWriteText, (_e, text: string) => {
    clipboard.writeText(typeof text === 'string' ? text : String(text))
  })
  ipcMain.handle(CH.clipboardReadText, () => clipboard.readText())
  ipcMain.handle(CH.shellRevealPath, (_e, path: string) => {
    // Only reveal paths inside an opened workspace/editor root.
    if (typeof path === 'string' && fs.isAllowed(path)) shell.showItemInFolder(path)
  })
  ipcMain.handle(CH.shellOpenExternal, (_e, url: string) => {
    // Only ever hand http(s) URLs to the OS — never file:// or custom schemes.
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) return shell.openExternal(url)
    return undefined
  })

  // ── window controls ──
  ipcMain.on(CH.windowMinimize, (e) => BrowserWindow.fromWebContents(e.sender)?.minimize())
  ipcMain.on(CH.windowToggleMaximize, (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return
    win.isMaximized() ? win.unmaximize() : win.maximize()
  })
  ipcMain.on(CH.windowClose, (e) => {
    diagnostics.log('window-close-ipc')
    BrowserWindow.fromWebContents(e.sender)?.close()
  })
  ipcMain.handle(CH.windowIsMaximized, (e) => BrowserWindow.fromWebContents(e.sender)?.isMaximized() ?? false)

  // ── status bar (live subscription usage · ports · resources) ──
  // The collector lives in the Agent Host (survives app closes, serves the phone); main is a
  // thin relay. `usage:get` reads the host's cached snapshot; `usage:refresh` forces a re-read.
  ipcMain.handle(CH.usageGet, async () => {
    try {
      return (await pty.hostRpc('usage:get', {})) as unknown
    } catch {
      return { providers: [], at: Date.now() }
    }
  })
  ipcMain.handle(CH.usageRefresh, async () => {
    try {
      await pty.hostRpc('usage:refresh', {})
    } catch {
      /* host may be down — the bar just keeps its last snapshot */
    }
    return { ok: true }
  })
  // Ports + resources: the host scans them; main adds its OWN RSS (a main-process fact).
  ipcMain.handle(CH.statusbarAuxGet, async () => {
    try {
      const aux = (await pty.hostRpc('statusbar:aux', {})) as {
        ports?: unknown
        resources?: { agentRssBytes?: unknown; at?: unknown }
      }
      return {
        ports: Array.isArray(aux?.ports) ? aux.ports : [],
        resources: {
          agentRssBytes: typeof aux?.resources?.agentRssBytes === 'number' ? aux.resources.agentRssBytes : 0,
          appRssBytes: process.memoryUsage().rss,
          at: typeof aux?.resources?.at === 'number' ? aux.resources.at : Date.now(),
        },
      }
    } catch {
      return { ports: [], resources: { agentRssBytes: 0, appRssBytes: process.memoryUsage().rss, at: Date.now() } }
    }
  })
  // Destructive port-owner kill — user-confirmed in the popover; the host only kills PIDs the
  // bar itself surfaced.
  ipcMain.handle(CH.statusbarKillPid, async (_e, p: { pid?: unknown }) => {
    try {
      const pid = Number(p?.pid)
      if (!Number.isInteger(pid) || pid <= 0) return { ok: false }
      const r = (await pty.hostRpc('statusbar:killPid', { pid })) as { ok?: boolean }
      return { ok: r?.ok === true }
    } catch {
      return { ok: false }
    }
  })

  // ── time tracking ──
  ipcMain.handle(CH.timeGetStats, () => time.getStats())
  ipcMain.handle(CH.timeAddActive, (_e, req: TimeAddActiveRequest) => time.addActive(req))

  // ── settings ──
  ipcMain.handle(CH.settingsGet, () => settings.get())
  // Synchronous read for the renderer's FIRST paint — the preload calls this via sendSync
  // before any page script runs, so the saved theme applies instantly (no wrong-theme flash
  // while the async settings IPC + workspace restore take their time).
  ipcMain.on(CH.settingsGet, (e) => {
    e.returnValue = settings.getSync()
  })
  ipcMain.handle(CH.settingsSave, async (_e, doc: unknown) => {
    const result = await settings.save(doc)
    // Appearance → "Reduce motion" also governs what browser-panel pages see as
    // prefers-reduced-motion; re-apply to the open guests so the toggle is live.
    webviewMotion.refresh()
    return result
  })

  // ── voice assistant (local Parakeet ASR) ──
  ipcMain.handle(CH.voiceStatus, () => voice.status())
  ipcMain.handle(CH.voicePrepare, () => voice.prepare())
  ipcMain.handle(CH.voiceTranscribe, (_e, req: VoiceTranscribeRequest) => {
    if (!req || (!(req.pcm instanceof ArrayBuffer) && !ArrayBuffer.isView(req.pcm))) {
      return { ok: false, text: '', error: 'Invalid audio payload.' }
    }
    return voice.transcribe(req)
  })
  ipcMain.handle(CH.voiceInterpret, (_e, req: VoiceInterpretRequest) => {
    if (!req || typeof req.transcript !== 'string' || typeof req.apiKey !== 'string') {
      return { ok: false, action: null, error: 'Invalid interpret request' }
    }
    return voice.interpret(req)
  })

  // ── session (open-project pointer for launch restore) ──
  ipcMain.handle(CH.sessionGet, () => session.get())
  ipcMain.handle(CH.sessionSet, (_e, req: SessionSetRequest) => session.set(req))

  // ── mesh worktree fan-out (git worktrees isolate parallel writing agents) ──
  // v4 A5: cancel a chained task from the Mesh view (on the arming agent's behalf).
  ipcMain.handle(CH.meshChainCancel, async (_e, p: { chainId?: unknown }) => {
    try {
      const chainId = typeof p?.chainId === 'string' ? p.chainId : ''
      if (!chainId) return { ok: false, error: 'missing-chain-id' }
      const r = (await pty.hostRpc('chainCancel', { chainId })) as { ok?: boolean; error?: string }
      return { ok: r?.ok === true, error: r?.error ?? null }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  })
  // v4 A5: the Mesh view lists every chain.
  ipcMain.handle(CH.meshChainsGet, async () => {
    try {
      const r = (await pty.hostRpc('chainsView', {})) as { ok?: boolean; chains?: unknown[] }
      return { ok: r?.ok === true, chains: Array.isArray(r?.chains) ? r.chains : [] }
    } catch (err) {
      return { ok: false, chains: [], error: String(err) }
    }
  })
  ipcMain.handle(CH.worktreeIsRepo, async (_e, p: { folder?: unknown }) => {    const folder = typeof p?.folder === 'string' ? p.folder : ''
    if (!folder || !fs.isAllowed(folder)) return { ok: false }
    return { ok: await worktree.isRepo(folder) }
  })
  ipcMain.handle(CH.worktreeCreate, async (_e, p: { repo?: unknown; mission?: unknown; count?: unknown }) => {
    const repo = typeof p?.repo === 'string' ? p.repo : ''
    if (!repo || !fs.isAllowed(repo)) return { ok: false, error: 'Folder not allowed.' }
    const mission = typeof p?.mission === 'string' ? p.mission.slice(0, 80) : 'mission'
    const count = typeof p?.count === 'number' ? Math.max(1, Math.min(8, Math.floor(p.count))) : 1
    try {
      const worktrees = await worktree.create({ repo, mission, count })
      return { ok: true, worktrees }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle(CH.worktreeStatus, async (_e, p: { path?: unknown }) => {
    const path = typeof p?.path === 'string' ? p.path : ''
    if (!path || !fs.isAllowed(path)) return { ok: false, error: 'Not allowed.' }
    const info = await worktree.status(path)
    return info ? { ok: true, info } : { ok: false, error: 'Unknown worktree.' }
  })
  ipcMain.handle(CH.worktreeRemove, async (_e, p: { path?: unknown; force?: unknown }) => {
    const path = typeof p?.path === 'string' ? p.path : ''
    if (!path || !fs.isAllowed(path)) return { ok: false, error: 'Not allowed.' }
    return worktree.remove(path, p?.force === true)
  })
  ipcMain.handle(CH.worktreeList, () => ({ worktrees: worktree.list() }))

  // ── app ──
  ipcMain.handle(CH.appGetInfo, (): AppInfo => {
    return {
      versions: {
        app: app.getVersion(),
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
      },
      platform: process.platform,
      isPackaged: app.isPackaged,
      homeDir: app.getPath('home'),
    }
  })
  ipcMain.handle(CH.appGetLaunchFolder, () => ({ folderPath: env.takeLaunchFolder() }))
  // LAN connection info for the PLANO mobile web app: reads the Agent Host's port file and
  // lists this machine's real LAN IPv4 addresses so the phone knows where to point. Virtual
  // adapters (VPNs like NordLynx, loopbacks, Npcap, Hyper-V, APIPA auto-config) are filtered out
  // — a QR encoding a VPN adapter's IP would silently fail from the phone.
  ipcMain.handle(CH.appGetRemoteInfo, async () => {
    try {
      const hostFile = join(app.getPath('userData'), 'agent-host.json')
      const parsed = JSON.parse(readFileSync(hostFile, 'utf8')) as {
        webPort?: number
        token?: string
      }
      const webPort = typeof parsed.webPort === 'number' ? parsed.webPort : 0
      const token = typeof parsed.token === 'string' ? parsed.token : ''
      const VIRTUAL =
        /nord|tailscale|zerotier|vmware|virtualbox|hyper-v|vethernet|npcap|loopback|openvpn|tap|docker|wsl|vpn|tunnel|teredo|isatap|btpan|bluetooth/i
      const ifaces = os.networkInterfaces()
      const lanIps: string[] = []
      for (const [name, list] of Object.entries(ifaces)) {
        for (const i of list ?? []) {
          if (i.family !== 'IPv4' || i.internal) continue
          if (VIRTUAL.test(name)) continue
          if (i.address.startsWith('169.254.')) continue // APIPA self-assigned — no route
          lanIps.push(i.address)
        }
      }
      // Prefer a physical adapter name when several survive the filter.
      lanIps.sort((a, b) => {
        const score = (ip: string): number => {
          for (const [name, list] of Object.entries(ifaces)) {
            if ((list ?? []).some((i) => i.address === ip)) {
              if (/ethernet|lan|wi-?fi|wlan|en\d|eth\d/i.test(name)) return 0
              return 1
            }
          }
          return 2
        }
        return score(a) - score(b)
      })
      const primary = lanIps[0] ?? ''
      const phoneConnected = (await pty.phoneClients()) > 0
      return {
        lanIps,
        webPort,
        token,
        pairingCode: token.slice(0, 6).toUpperCase(),
        url: webPort > 0 && primary ? `http://${primary}:${webPort}/` : '',
        phoneConnected,
      }
    } catch {
      return { lanIps: [], webPort: 0, token: '', pairingCode: '', url: '', phoneConnected: false }
    }
  })

  // ── auto-update (GitHub releases) ──
  ipcMain.handle(CH.updateGetState, () => update.getState())
  ipcMain.handle(CH.updateCheck, async () => {
    const state = await update.checkNow()
    return { ok: state.phase !== 'error', state }
  })
  ipcMain.handle(CH.updateInstall, () => update.installNow())
}

// ── mesh helpers (pure-ish, testable) ────────────────────────────────────────────────────────────

/**
 * Build the [PLANO SHARED CONTEXT] block for a mesh dispatch, from the LIVE canonical snapshot.
 * Metadata-only (no raw tails), redacted, capped — a normal shell is never described as an agent.
 */
export function buildMeshContext(services: Services): string {
  const agents = services.agentContext
    .snapshot()
    .filter((e) => e.verdict.active)
    .map((e) => {
      const meta = services.pty.runtimeMeta(e.ptyId)
      const kind = e.verdict.displayName ?? e.verdict.kind ?? 'AI Agent'
      const phase = e.verdict.phase ?? 'idle'
      const task = e.firstPrompt ? `task: ${e.firstPrompt.slice(0, 120)}` : ''
      return `- Terminal ${meta?.terminalId ?? '?'} / ${kind} / ${phase}${task ? ' / ' + task : ''}`
    })

  const lines = [
    '[PLANO SHARED CONTEXT]',
    `Workspace: ${services.agentContext.snapshot()[0]?.spaceId ?? ''}`,
    'Coordination:',
    '- Avoid duplicating work already owned by another listed agent.',
    '- State conflicts before editing the same files.',
    '[/PLANO SHARED CONTEXT]',
  ]
  if (agents.length > 0) {
    lines.splice(2, 0, 'Agents:', ...agents, '')
  }
  return lines.join('\n')
}

/** Resolve the active workspace folder (the scratchpad root). */
async function activeWorkspaceFolder(services: Services): Promise<string | null> {
  const { state } = await services.workspaceState.get()
  if (state?.activeId) {
    const active = state.workspaces.find((s) => s.id === state.activeId)
    if (active?.folderPath) return active.folderPath
  }
  const session = await services.session.get()
  return session.folderPath
}

const SCRATCHPAD_MAX = 256 * 1024
const SCRATCHPAD_NAME = 'agent-scratchpad.md'

/** Read the workspace scratchpad (redacted). Returns empty text when none exists. */
async function scratchpadIO(services: Services): Promise<{ text: string; path: string; bytes: number }> {
  const folder = await activeWorkspaceFolder(services)
  if (!folder) return { text: '', path: '', bytes: 0 }
  const file = join(folder, '.plano', SCRATCHPAD_NAME)
  try {
    const raw = await fs.readFile(file, 'utf8')
    const { text } = redactContext(raw)
    return { text, path: file, bytes: Buffer.byteLength(text) }
  } catch {
    return { text: '', path: file, bytes: 0 }
  }
}

/** Append a serialised entry to the workspace scratchpad (atomic, bounded, fixed path). */
async function appendScratchpad(services: Services, entry: string): Promise<{ ok: boolean; bytes: number }> {
  const folder = await activeWorkspaceFolder(services)
  if (!folder) return { ok: false, bytes: 0 }
  const dir = join(folder, '.plano')
  const file = join(dir, SCRATCHPAD_NAME)
  try {
    mkdirSync(dir, { recursive: true })
    const existing = await fs.readFile(file, 'utf8').catch(() => '')
    const stamp = `\n--- ${new Date().toISOString()} ---\n`
    const next = existing + stamp + entry.replace(/\n?$/, '\n')
    const bytes = Buffer.byteLength(next)
    if (bytes > SCRATCHPAD_MAX) {
      // Rotate from the top: keep the newest half of the file.
      const overflow = bytes - SCRATCHPAD_MAX
      const cut = next.indexOf('\n--- ', overflow)
      const kept = cut === -1 ? next.slice(overflow) : next.slice(cut + 1)
      const tmp = `${file}.${randomUUID()}.tmp`
      await fs.writeFile(tmp, kept, 'utf8')
      await fs.rename(tmp, file)
      return { ok: true, bytes: Buffer.byteLength(kept) }
    }
    const tmp = `${file}.${randomUUID()}.tmp`
    await fs.writeFile(tmp, next, 'utf8')
    await fs.rename(tmp, file)
    return { ok: true, bytes }
  } catch {
    return { ok: false, bytes: 0 }
  }
}
