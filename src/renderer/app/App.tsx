import { useEffect } from 'react'
import { usePanelStore } from '@/stores/usePanelStore'
import { useViewportStore } from '@/stores/useViewportStore'
import { useWorkspaceStore } from '@/stores/useWorkspaceStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useSpacesStore } from '@/stores/useSpacesStore'
import { useUpdateStore } from '@/stores/useUpdateStore'
import { useHotkeys } from '@/hooks/useHotkeys'
import { useTimeTracker } from '@/hooks/useTimeTracker'
import { useDevUrlAutoOpen } from '@/hooks/useDevUrlAutoOpen'
import { CanvasRoot } from '@/canvas/CanvasRoot'
import { Minimap } from '@/canvas/Minimap'
import { TopBar } from '@/chrome/TopBar'
import { Dock } from '@/chrome/Dock'
import { StatusBar } from '@/chrome/statusbar/StatusBar'
import { ViewControls } from '@/chrome/ViewControls'
import { ContextMenu } from '@/chrome/ContextMenu'
import { CommandPalette } from '@/chrome/CommandPalette'
import { LastPromptsOverlay } from '@/chrome/LastPromptsOverlay'
import { AgentControlCenter } from '@/chrome/AgentControlCenter'
import { SettingsModal } from '@/chrome/settings/SettingsModal'
import { ConfirmDialog } from '@/chrome/ConfirmDialog'
import { Toasts } from '@/chrome/Toasts'
import { FocusStage } from '@/chrome/FocusStage'
import { UpdateBanner } from '@/chrome/UpdateBanner'
import { MeshConsentToast } from '@/chrome/MeshConsentToast'
import { ChainAskToast } from '@/chrome/ChainAskToast'
import { TerminalCloseDialog } from '@/chrome/TerminalCloseDialog'
import { EmptyState } from '@/chrome/EmptyState'
import { VoiceOverlay } from '@/voice/VoiceOverlay'
import { openFilesPanel } from '@/app/actions'
import { restoreWorkspaces, openWorkspaceFolder, flushWorkspaceSync } from '@/app/workspaceActions'
import { restoreSurvivingTerminals } from '@/app/terminalRestore'
import { materializePendingPanels, subscribeExternalTerminals, setPendingProtectedIds } from '@/app/externalTerminals'
import { startHibernationSupervisor } from '@/app/terminalHibernation'
import { startAgentDoneSound } from '@/app/agentDoneSound'
import { startAgentActivity } from '@/app/agentActivity'
import { startAgentNotifier } from '@/app/agentNotifier'
import { primeAgentChime } from '@/lib/agentChime'
import { scheduleAutosave, cancelAutosave } from '@/app/autosave'
import { reconcileAgentSessionsBeforeClose } from '@/app/agentSessionPersistence'

function agentSessionFingerprint(): string {
  const refs: string[] = []
  for (const space of useSpacesStore.getState().spaces) {
    for (const panel of space.panels) {
      if (panel.type !== 'terminal') continue
      for (const tab of panel.props.tabs ?? []) {
        const ref = tab.agentSession
        refs.push(`${panel.id}:${tab.id}:${ref?.agent ?? ''}:${ref?.sessionId ?? ''}:${ref?.cwd ?? ''}`)
      }
    }
  }
  return refs.sort().join('|')
}

export function App() {
  useHotkeys()
  useTimeTracker()
  useDevUrlAutoOpen()
  // Auto-update: subscribe to status pushes + load the current snapshot once.
  useEffect(() => useUpdateStore.getState().hydrate(), [])
  const isEmpty = usePanelStore((s) => Object.keys(s.panels).length === 0)
  // The status bar is docked to the shell's bottom edge (plan PLAN_STATUS_BAR_LIVE_USAGE); the
  // canvas container loses the bar's height so panels never sit underneath it. All canvas
  // geometry changes for the bar live HERE in App.tsx — the canvas files themselves stay
  // untouched (another agent is reworking canvas input concurrently).
  const showStatusBar = useSettingsStore((s) => s.settings.usage.showStatusBar)

  // Hydrate settings first (applies theme/accent), then honor launch preferences.
  useEffect(() => {
    startHibernationSupervisor()
    startAgentActivity()
    startAgentDoneSound()
    startAgentNotifier()
    primeAgentChime()
    void (async () => {
      await useSettingsStore.getState().hydrate()
      // Phone-created terminals (mobile web app) recorded while PLANO was closed: fetch them now
      // so their terminal ids join the restore's kept set (their live host sessions must NOT be
      // orphan-killed), then materialize the panels AFTER workspaces restore (so they join their
      // real workspace instead of spinning up a new one).
      const pending = await window.plano.terminal
        .pendingPanels()
        .then((r) => r.panels)
        .catch(() => [])
      setPendingProtectedIds(pending.map((p) => p.terminalId))
      // herdr-style restore: terminals that survived the app closing live in the detached Agent
      // Host — seed them into the terminal store BEFORE workspace panels mount, so they reattach
      // (replaying buffered output) instead of respawning. Agents keep running across restarts.
      await restoreSurvivingTerminals(pending.map((p) => p.terminalId)).catch(() => undefined)
      const { general } = useSettingsStore.getState().settings
      // Restore every open workspace (each with its own folder) from the app-global state, or — on
      // the first run of this build — migrate the legacy single-folder session into workspaces.
      await restoreWorkspaces().catch(() => undefined)
      // Phone-created panels land in their (now-restored) workspaces.
      await materializePendingPanels(pending).catch(() => undefined)
      // Launched via Explorer's "Open in PLANO"? Open that folder as a workspace on top of restore
      // (switches to it if already open, else adopts a blank/new workspace for it).
      const { folderPath: launch } = await window.plano.app.getLaunchFolder()
      if (launch) await openWorkspaceFolder(launch).catch(() => undefined)
      // Optionally surface the active workspace's files on launch — but only when it has a folder,
      // and rooted at it (never an empty "No folder open" panel). No folder → nothing is added.
      if (general.showFilesOnLaunch) {
        const hasFiles = Object.values(usePanelStore.getState().panels).some((p) => p.type === 'editor')
        const folderPath = useWorkspaceStore.getState().folderPath
        if (!hasFiles && folderPath) openFilesPanel(folderPath)
      }
    })()
  }, [])

  // "Open in PLANO" on a folder while we're already running → load it live into the canvas.
  useEffect(
    () =>
      window.plano.workspace.onOpenFolder(({ folderPath }) => {
        void openWorkspaceFolder(folderPath).catch(() => undefined)
      }),
    [],
  )

  // A phone created a terminal/agent while PLANO is running → materialize its canvas panel.
  useEffect(() => subscribeExternalTerminals(), [])

  // Debounced autosave whenever the CAMERA settles or session metadata changes (plan D5:
  // panel-store writes no longer schedule autosave per write — a drag used to fire 60 saves
  // per second. Panel geometry now autosaves on GESTURE END (PanelFrame.endGesture); the
  // camera store only writes on settle since plan A1; beforeunload flushes the rest).
  useEffect(() => {
    const unsubViewport = useViewportStore.subscribe(scheduleAutosave)
    // A terminal in a background workspace keeps running. Its exact agent-session id is patched
    // into that workspace snapshot (not the active panel store), so watch just this narrow metadata
    // fingerprint and persist it without autosaving on unrelated workspace bookkeeping.
    let previousAgentSessions = agentSessionFingerprint()
    const unsubSpaces = useSpacesStore.subscribe(() => {
      const next = agentSessionFingerprint()
      if (next === previousAgentSessions) return
      previousAgentSessions = next
      scheduleAutosave()
    })
    return () => {
      unsubViewport()
      unsubSpaces()
      cancelAutosave()
    }
  }, [])

  // Closing the window / quitting the app would otherwise drop any edit made within the autosave
  // debounce window. Flush the live canvas to disk SYNCHRONOUSLY on `beforeunload` so the last
  // note/todo/layout change is always persisted, no matter how it was left.
  useEffect(() => {
    const onBeforeUnload = (): void => {
      cancelAutosave()
      reconcileAgentSessionsBeforeClose()
      flushWorkspaceSync()
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [])

  return (
    <div className="isolate relative h-full w-full overflow-hidden">
      <TopBar />
      {/* The usage island floats INSIDE the canvas area: it never reserves height, so showing or
          hiding it can't shift the workspace under the user. */}
      <main className="absolute inset-x-0 bottom-0 top-0">
        <CanvasRoot />
        {isEmpty && <EmptyState />}
        <Minimap />
        <Dock />
        <ViewControls />
        {showStatusBar && <StatusBar />}
      </main>
      <ContextMenu />
      <FocusStage />
      <Toasts />
      <UpdateBanner />
      <MeshConsentToast />
      <ChainAskToast />
      <CommandPalette />
      <LastPromptsOverlay />
      <AgentControlCenter />
      <SettingsModal />
      <ConfirmDialog />
      <TerminalCloseDialog />
      <VoiceOverlay />
    </div>
  )
}
