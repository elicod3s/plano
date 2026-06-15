import { useEffect } from 'react'
import { useUiStore } from '@/stores/useUiStore'
import { useViewportStore } from '@/stores/useViewportStore'
import { useSpacesStore } from '@/stores/useSpacesStore'
import { addPanelAtCenter, zoomToFitAll } from '@/app/actions'
import { openFolder, saveCurrent, switchSpace, createNewSpace } from '@/app/workspaceActions'

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable
}

/** Global keyboard shortcuts. Panel-creation shortcuts are suppressed while typing. */
export function useHotkeys(): void {
  const togglePalette = useUiStore((s) => s.toggleCommandPalette)
  const setPalette = useUiStore((s) => s.setCommandPalette)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const mod = e.ctrlKey || e.metaKey
      if (!mod) return
      const k = e.key.toLowerCase()
      const typing = isTyping(e.target)
      const vp = { width: window.innerWidth, height: window.innerHeight }

      // Palette works everywhere.
      if (k === 'k') return run(e, togglePalette)
      if (e.shiftKey && k === 'e') return run(e, () => setPalette(true))

      // Workspace switching — global, so it works even with a panel focused.
      if (k === 'tab') {
        const { spaces, activeId } = useSpacesStore.getState()
        if (spaces.length < 2) return run(e, () => undefined)
        const cur = Math.max(0, spaces.findIndex((s) => s.id === activeId))
        const next = e.shiftKey ? (cur - 1 + spaces.length) % spaces.length : (cur + 1) % spaces.length
        return run(e, () => switchSpace(spaces[next].id))
      }
      if (!e.shiftKey && !e.altKey && k >= '1' && k <= '9') {
        const target = useSpacesStore.getState().spaces[Number(k) - 1]
        return run(e, () => target && switchSpace(target.id))
      }

      if (typing) return

      if (e.shiftKey && k === 't') return run(e, () => addPanelAtCenter('terminal'))
      if (e.shiftKey && k === 'b') return run(e, () => addPanelAtCenter('browser'))
      if (e.altKey && k === 'e') return run(e, () => addPanelAtCenter('editor'))
      if (k === 'n') return run(e, () => createNewSpace())
      if (e.shiftKey && k === 'f') return run(e, () => zoomToFitAll())
      if (k === '0') return run(e, () => useViewportStore.getState().zoomTo(1, vp))
      if (k === 's') return run(e, () => void saveCurrent())
      if (k === 'o') return run(e, () => void openFolder())
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [togglePalette, setPalette])
}

function run(e: KeyboardEvent, fn: () => void): void {
  e.preventDefault()
  fn()
}
