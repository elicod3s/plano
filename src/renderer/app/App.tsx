import { useEffect } from 'react'
import { usePanelStore } from '@/stores/usePanelStore'
import { useViewportStore } from '@/stores/useViewportStore'
import { useWorkspaceStore } from '@/stores/useWorkspaceStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useHotkeys } from '@/hooks/useHotkeys'
import { useTimeTracker } from '@/hooks/useTimeTracker'
import { useDevUrlAutoOpen } from '@/hooks/useDevUrlAutoOpen'
import { CanvasRoot } from '@/canvas/CanvasRoot'
import { Minimap } from '@/canvas/Minimap'
import { TopBar } from '@/chrome/TopBar'
import { Dock } from '@/chrome/Dock'
import { ViewControls } from '@/chrome/ViewControls'
import { ContextMenu } from '@/chrome/ContextMenu'
import { CommandPalette } from '@/chrome/CommandPalette'
import { SettingsModal } from '@/chrome/settings/SettingsModal'
import { ConfirmDialog } from '@/chrome/ConfirmDialog'
import { TerminalCloseDialog } from '@/chrome/TerminalCloseDialog'
import { EmptyState } from '@/chrome/EmptyState'
import { VoiceOverlay } from '@/voice/VoiceOverlay'
import { openFilesPanel } from '@/app/actions'
import { restoreWorkspaces, openWorkspaceFolder, flushWorkspaceSync } from '@/app/workspaceActions'
import { scheduleAutosave, cancelAutosave } from '@/app/autosave'

export function App() {
  useHotkeys()
  useTimeTracker()
  useDevUrlAutoOpen()
  const isEmpty = usePanelStore((s) => Object.keys(s.panels).length === 0)

  // Hydrate settings first (applies theme/accent), then honor launch preferences.
  useEffect(() => {
    void (async () => {
      await useSettingsStore.getState().hydrate()
      const { general } = useSettingsStore.getState().settings
      // Restore every open workspace (each with its own folder) from the app-global state, or — on
      // the first run of this build — migrate the legacy single-folder session into workspaces.
      await restoreWorkspaces().catch(() => undefined)
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

  // Debounced autosave whenever panels or the camera change. The timer lives in app/autosave so the
  // workspace lifecycle can suspend/cancel it around hydration and project switches.
  useEffect(() => {
    const unsubPanels = usePanelStore.subscribe(scheduleAutosave)
    const unsubViewport = useViewportStore.subscribe(scheduleAutosave)
    return () => {
      unsubPanels()
      unsubViewport()
      cancelAutosave()
    }
  }, [])

  // Closing the window / quitting the app would otherwise drop any edit made within the autosave
  // debounce window. Flush the live canvas to disk SYNCHRONOUSLY on `beforeunload` so the last
  // note/todo/layout change is always persisted, no matter how it was left.
  useEffect(() => {
    const onBeforeUnload = (): void => {
      cancelAutosave()
      flushWorkspaceSync()
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [])

  return (
    <div className="flex h-full flex-col">
      <TopBar />
      <main className="relative min-h-0 flex-1">
        <CanvasRoot />
        {isEmpty && <EmptyState />}
        <Minimap />
        <Dock />
        <ViewControls />
      </main>
      <ContextMenu />
      <CommandPalette />
      <SettingsModal />
      <ConfirmDialog />
      <TerminalCloseDialog />
      <VoiceOverlay />
    </div>
  )
}
