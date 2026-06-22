import { useEffect } from 'react'
import { useSpacesStore } from '@/stores/useSpacesStore'
import { switchSpace } from '@/app/workspaceActions'
import { KEYMAP } from '@/app/commands'
import { eventKey, matchesCombo } from '@/lib/keymap'

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  // xterm focuses a hidden <textarea>, so this also (correctly) shields a focused terminal from
  // non-global panel-creation shortcuts — Alt+B etc. reach the shell's readline instead.
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable
}

/**
 * Global keyboard shortcuts. Static commands come from the command registry (app/commands) so the
 * keys, the command palette, the dock and the context menu can never drift apart. The two
 * parametric shortcuts — cycling spaces (Ctrl+Tab / Ctrl+Shift+Tab) and jumping to space N
 * (Ctrl+1‑9) — are handled here directly. Registry bindings marked `global` fire even while typing;
 * the rest (panel creation) are suppressed while a text field / terminal is focused.
 */
export function useHotkeys(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const mod = e.ctrlKey || e.metaKey
      const key = eventKey(e)

      // Parametric (always global): cycle / jump between spaces.
      if (mod && !e.altKey && key === 'tab') {
        const { spaces, activeId } = useSpacesStore.getState()
        if (spaces.length >= 2) {
          const cur = Math.max(0, spaces.findIndex((s) => s.id === activeId))
          const next = e.shiftKey ? (cur - 1 + spaces.length) % spaces.length : (cur + 1) % spaces.length
          e.preventDefault()
          switchSpace(spaces[next].id)
        }
        return
      }
      if (mod && !e.shiftKey && !e.altKey && key >= '1' && key <= '9') {
        const target = useSpacesStore.getState().spaces[Number(key) - 1]
        if (target) {
          e.preventDefault()
          switchSpace(target.id)
        }
        return
      }

      // Registry commands.
      const typing = isTyping(e.target)
      for (const entry of KEYMAP) {
        if (!entry.global && typing) continue
        if (matchesCombo(e, entry.combo)) {
          e.preventDefault()
          entry.run()
          return
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
