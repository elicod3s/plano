import { useEffect, useState, type RefObject } from 'react'
import { screenToWorld } from '@shared/domain/geometry'
import { useViewportStore } from '@/stores/useViewportStore'
import { openDroppedPath } from '@/app/actions'

/** True when the drag carries OS files (not an in-app text/element drag). */
function hasFiles(e: DragEvent): boolean {
  return !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')
}

/**
 * Drag-and-drop from the OS onto the canvas: dropping files/folders opens each one as a
 * Files panel at the drop point (folder → explorer rooted there; file → editor / image
 * preview with its parent folder in the sidebar). Returns whether a file drag is hovering
 * the canvas, for the "Drop to open" affordance.
 */
export function useFileDrop(ref: RefObject<HTMLDivElement | null>): boolean {
  const [active, setActive] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    // dragenter/dragleave also fire on every child the drag crosses; a depth counter nets
    // them out so the affordance doesn't flicker while moving over panels.
    let depth = 0

    const onDragEnter = (e: DragEvent): void => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth += 1
      setActive(true)
    }
    const onDragOver = (e: DragEvent): void => {
      if (!hasFiles(e)) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    }
    const onDragLeave = (e: DragEvent): void => {
      if (!hasFiles(e)) return
      depth = Math.max(0, depth - 1)
      if (depth === 0) setActive(false)
    }
    const onDrop = (e: DragEvent): void => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth = 0
      setActive(false)
      const rect = el.getBoundingClientRect()
      const world = screenToWorld(
        { x: e.clientX - rect.left, y: e.clientY - rect.top },
        useViewportStore.getState(),
      )
      const files = Array.from(e.dataTransfer?.files ?? [])
      void (async () => {
        let placed = 0
        for (const file of files) {
          // '' → not an OS file (e.g. an image dragged off a web page) — nothing to open.
          const path = window.plano.fs.pathForFile(file)
          if (!path) continue
          const { kind } = await window.plano.fs.dropPath({ path })
          if (!kind) continue
          // Cascade multiple dropped files so they don't stack exactly on top of each other.
          const offset = placed * 36
          openDroppedPath(path, kind, { x: world.x + offset, y: world.y + offset })
          placed += 1
        }
      })()
    }

    el.addEventListener('dragenter', onDragEnter)
    el.addEventListener('dragover', onDragOver)
    el.addEventListener('dragleave', onDragLeave)
    el.addEventListener('drop', onDrop)
    return () => {
      el.removeEventListener('dragenter', onDragEnter)
      el.removeEventListener('dragover', onDragOver)
      el.removeEventListener('dragleave', onDragLeave)
      el.removeEventListener('drop', onDrop)
    }
  }, [ref])

  // Anywhere else in the window (top bar, dock, overlays): swallow the drag so Chromium
  // never navigates the app window to a dropped file.
  useEffect(() => {
    const guard = (e: DragEvent): void => e.preventDefault()
    window.addEventListener('dragover', guard)
    window.addEventListener('drop', guard)
    return () => {
      window.removeEventListener('dragover', guard)
      window.removeEventListener('drop', guard)
    }
  }, [])

  return active
}
