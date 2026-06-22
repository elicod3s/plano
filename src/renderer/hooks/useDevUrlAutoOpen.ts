import { useEffect } from 'react'
import { PANEL_META, type BrowserProps, type TerminalProps } from '@shared/domain/panel'
import type { Point } from '@shared/domain/geometry'
import { usePanelStore } from '@/stores/usePanelStore'
import { useTerminalStore } from '@/stores/useTerminalStore'
import { useSettingsStore } from '@/stores/useSettingsStore'

/** Gap (world px) left between the source terminal and the browser panel we open beside it. */
const GAP = 32
/** Cap on the remembered-URLs list per terminal so the persisted prop stays small. */
const MAX_OPENED_URLS = 32

const sameUrl = (a: string, b: string): boolean =>
  a.replace(/\/+$/, '').toLowerCase() === b.replace(/\/+$/, '').toLowerCase()

/** Open `url` inside PLANO — beside the terminal that printed it, never duplicating. */
function openInPlano(ptyId: string, url: string): void {
  const panels = usePanelStore.getState().panels

  // Already showing this URL? Surface that panel instead of opening another (server restarts
  // reprint the same URL).
  const existing = Object.values(panels).find(
    (p) => p.type === 'browser' && sameUrl((p.props as BrowserProps).url ?? '', url),
  )
  if (existing) {
    usePanelStore.getState().bringToFront(existing.id)
    return
  }

  // Place the new browser to the RIGHT of the terminal that emitted the URL (when we can find
  // it), so the dev server and its preview sit side by side. Otherwise let addPanel cascade.
  // byPanel is keyed by TERMINAL id (a panel can host several); map pty→terminal→owning panel.
  const byPanel = useTerminalStore.getState().byPanel
  const srcRt = Object.values(byPanel).find((rt) => rt.ptyId === ptyId)
  const src = srcRt ? panels[srcRt.panelId] : undefined
  const size = PANEL_META.browser.defaultSize
  const center: Point | undefined = src
    ? { x: src.rect.x + src.rect.width + GAP + size.width / 2, y: src.rect.y + size.height / 2 }
    : undefined

  const id = usePanelStore.getState().addPanel('browser', center)
  usePanelStore.getState().updateProps<'browser'>(id, { url })
}

/**
 * Auto-open local dev-server URLs (localhost:PORT) that PLANO's terminals print, governed by
 * Settings → Browser → "URLs from terminal":
 *   plano    → open a browser panel inside PLANO (the default — magic, but only for localhost)
 *   external → open in the system browser
 *   ignore   → do nothing
 * ('ask' currently behaves like 'plano' — an inline confirm chip is a future nicety.)
 * Mounted once at the app root. Detection itself lives in main (DevUrlService).
 */
export function useDevUrlAutoOpen(): void {
  useEffect(() => {
    // Defensive: tolerate an older preload bridge (e.g. a dev reload that updated the renderer
    // but not yet the preload) so a version skew degrades to "feature off" instead of crashing
    // the whole renderer. Once the preload rebuilds, the method is present and this wires up.
    if (typeof window.plano.terminal.onUrlDetected !== 'function') return
    return window.plano.terminal.onUrlDetected(({ ptyId, url }) => {
      const action = useSettingsStore.getState().settings.browser.terminalUrlAction
      if (action === 'ignore') return

      // Find the SOURCE terminal panel (stable across respawns) and skip if it has already
      // auto-opened this URL. This is the durable guard: a workspace reopen — or a resumed agent
      // redrawing its old transcript that mentions the URL — must NOT re-open it. (The detector's
      // own per-session dedup is lost on respawn; the browser-panel check can miss after the page
      // navigated away from the original URL.)
      // openedDevUrls is panel-level; map pty→terminal→owning panel (byPanel keys are termIds).
      const byPanel = useTerminalStore.getState().byPanel
      const panelId = Object.values(byPanel).find((rt) => rt.ptyId === ptyId)?.panelId
      const opened = panelId
        ? ((usePanelStore.getState().panels[panelId]?.props as TerminalProps).openedDevUrls ?? [])
        : []
      if (opened.some((u) => sameUrl(u, url))) return

      if (action === 'external') {
        void window.plano.shell.openExternal(url)
      } else {
        openInPlano(ptyId, url)
      }

      // Remember it on the terminal panel so reopens never re-open the same URL.
      if (panelId) {
        const next = [...opened.filter((u) => !sameUrl(u, url)), url].slice(-MAX_OPENED_URLS)
        usePanelStore.getState().updateProps<'terminal'>(panelId, { openedDevUrls: next })
      }
    })
  }, [])
}
