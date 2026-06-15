import type { PanelType } from '@shared/domain/panel'
import type { Point } from '@shared/domain/geometry'
import { screenToWorld } from '@shared/domain/geometry'
import { usePanelStore } from '@/stores/usePanelStore'
import { useViewportStore } from '@/stores/useViewportStore'

/** Add a panel at a specific world point (e.g. where the user right-clicked). */
export function addPanelAtWorld(type: PanelType, world: Point): string {
  return usePanelStore.getState().addPanel(type, world)
}

/** Add a panel centered in the current viewport. */
export function addPanelAtCenter(type: PanelType): string {
  const { x, y, zoom } = useViewportStore.getState()
  const center = screenToWorld(
    { x: window.innerWidth / 2, y: window.innerHeight / 2 },
    { x, y, zoom },
  )
  return usePanelStore.getState().addPanel(type, center)
}

/** Open a new terminal panel rooted at a folder (used by the Files panel's context menu). */
export function openTerminalAt(cwd: string): string {
  const id = addPanelAtCenter('terminal')
  usePanelStore.getState().updateProps<'terminal'>(id, { cwd })
  return id
}

/** Fit every panel into view (Zoom to fit). */
export function zoomToFitAll(): void {
  const panels = Object.values(usePanelStore.getState().panels)
  useViewportStore.getState().zoomToFit(
    panels.map((p) => p.rect),
    { width: window.innerWidth, height: window.innerHeight },
  )
}
