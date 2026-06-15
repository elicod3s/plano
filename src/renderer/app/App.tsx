import { useEffect } from 'react'
import { usePanelStore } from '@/stores/usePanelStore'
import { useViewportStore } from '@/stores/useViewportStore'
import { useWorkspaceStore } from '@/stores/useWorkspaceStore'
import { useHotkeys } from '@/hooks/useHotkeys'
import { useTimeTracker } from '@/hooks/useTimeTracker'
import { CanvasRoot } from '@/canvas/CanvasRoot'
import { Minimap } from '@/canvas/Minimap'
import { TopBar } from '@/chrome/TopBar'
import { Dock } from '@/chrome/Dock'
import { ContextMenu } from '@/chrome/ContextMenu'
import { CommandPalette } from '@/chrome/CommandPalette'
import { EmptyState } from '@/chrome/EmptyState'
import { loadWorkspace, saveCurrent } from '@/app/workspaceActions'

export function App() {
  useHotkeys()
  useTimeTracker()
  const isEmpty = usePanelStore((s) => Object.keys(s.panels).length === 0)

  // Restore the most recently opened workspace on launch.
  useEffect(() => {
    void window.plano.workspace.listRecent().then(({ recents }) => {
      if (recents[0]) void loadWorkspace(recents[0].path).catch(() => undefined)
    })
  }, [])

  // Debounced autosave whenever panels or the camera change.
  useEffect(() => {
    let timer: number | undefined
    const schedule = (): void => {
      useWorkspaceStore.getState().markDirty()
      window.clearTimeout(timer)
      timer = window.setTimeout(() => void saveCurrent(), 800)
    }
    const unsubPanels = usePanelStore.subscribe(schedule)
    const unsubViewport = useViewportStore.subscribe(schedule)
    return () => {
      unsubPanels()
      unsubViewport()
      window.clearTimeout(timer)
    }
  }, [])

  return (
    <div className="flex h-full flex-col">
      <TopBar />
      <main className="relative min-h-0 flex-1">
        <CanvasRoot />
        {isEmpty && <EmptyState />}
        <Minimap />
        <Dock />
      </main>
      <ContextMenu />
      <CommandPalette />
    </div>
  )
}
