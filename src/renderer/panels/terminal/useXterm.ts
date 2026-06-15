import { useEffect, type RefObject } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import '@xterm/xterm/css/xterm.css'
import type { TerminalProps } from '@shared/domain/panel'
import { useTerminalStore } from '@/stores/useTerminalStore'
import { usePanelStore } from '@/stores/usePanelStore'
import { useAgentStore } from '@/stores/useAgentStore'
import { useWorkspaceStore } from '@/stores/useWorkspaceStore'
import { xtermTheme, TERMINAL_FONT } from './xtermTheme'

/**
 * Mounts an xterm terminal into `containerRef`, spawns a PTY in main, and wires the
 * bidirectional stream + resize. Agent-detection signals for this PTY are pushed into
 * the agent store so the panel chrome can morph. Robust against StrictMode double-mount.
 */
export function useXterm(panelId: string, containerRef: RefObject<HTMLDivElement>): void {
  const attach = useTerminalStore((s) => s.attach)
  const setStatus = useTerminalStore((s) => s.setStatus)
  const detach = useTerminalStore((s) => s.detach)
  const setVerdict = useAgentStore((s) => s.setVerdict)
  const clearVerdict = useAgentStore((s) => s.clear)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    let disposed = false
    let ptyId: string | null = null
    let resizeObs: ResizeObserver | null = null
    const unsubs: Array<() => void> = []

    const term = new Terminal({
      fontFamily: TERMINAL_FONT,
      fontSize: 13,
      lineHeight: 1.4,
      letterSpacing: 0,
      cursorBlink: true,
      cursorStyle: 'bar',
      theme: xtermTheme,
      allowProposedApi: true,
      scrollback: 5000,
      macOptionIsMeta: true,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon((_e, uri) => window.open(uri, '_blank')))
    const unicode = new Unicode11Addon()
    term.loadAddon(unicode)
    term.unicode.activeVersion = '11'

    term.open(container)
    try {
      term.loadAddon(new WebglAddon())
    } catch {
      /* WebGL unavailable — xterm falls back to the canvas renderer */
    }
    fit.fit()

    // Clipboard: write/read go through main (focus-independent, reliable in Electron).
    const pasteFromClipboard = async (): Promise<void> => {
      try {
        const text = await window.plano.clipboard.readText()
        if (text && ptyId) window.plano.terminal.write(ptyId, text)
      } catch {
        /* clipboard unavailable */
      }
    }
    const copySelection = (): void => {
      const sel = term.getSelection()
      if (sel) void window.plano.clipboard.writeText(sel)
    }

    // Ctrl/Cmd+V pastes; Ctrl/Cmd+C copies only when there's a selection (otherwise it
    // must stay SIGINT). Returning false stops xterm from also handling the key.
    term.attachCustomKeyEventHandler((e): boolean => {
      if (e.type !== 'keydown') return true
      const mod = e.ctrlKey || e.metaKey
      if (!mod) return true
      const key = e.key.toLowerCase()
      if (key === 'v') {
        // preventDefault stops the browser's native paste so we don't paste twice.
        e.preventDefault()
        void pasteFromClipboard()
        return false
      }
      if (key === 'c' && term.hasSelection()) {
        e.preventDefault()
        copySelection()
        return false
      }
      return true
    })

    // Right-click pastes (classic terminal convenience) without opening the canvas menu.
    const onContextMenu = (e: MouseEvent): void => {
      e.preventDefault()
      void pasteFromClipboard()
    }
    container.addEventListener('contextmenu', onContextMenu)

    // A terminal opened from a folder carries its own cwd; otherwise fall back to the workspace.
    const panelCwd = (usePanelStore.getState().panels[panelId]?.props as TerminalProps | undefined)?.cwd
    const cwd = panelCwd ?? useWorkspaceStore.getState().folderPath ?? undefined

    void window.plano.terminal
      .create({ panelId, cols: term.cols, rows: term.rows, cwd })
      .then((res) => {
        if (disposed) {
          void window.plano.terminal.kill(res.ptyId)
          term.dispose()
          return
        }
        const id = res.ptyId
        ptyId = id
        attach(panelId, { ptyId: id, pid: res.pid, shellName: res.shellName, status: 'ready' })

        unsubs.push(
          window.plano.terminal.onData((e) => {
            if (e.ptyId === id) term.write(e.data)
          }),
          window.plano.terminal.onExit((e) => {
            if (e.ptyId === id) {
              term.writeln('\r\n\x1b[2m[process exited]\x1b[0m')
              setStatus(panelId, 'exited')
            }
          }),
          window.plano.agent.onSignal((e) => {
            if (e.ptyId === id) setVerdict(id, e.verdict)
          }),
        )

        term.onData((data) => {
          if (ptyId) window.plano.terminal.write(ptyId, data)
        })

        resizeObs = new ResizeObserver(() => {
          try {
            fit.fit()
            if (ptyId) window.plano.terminal.resize(ptyId, term.cols, term.rows)
          } catch {
            /* fit can throw mid-teardown */
          }
        })
        resizeObs.observe(container)
        term.focus()
      })

    return () => {
      disposed = true
      resizeObs?.disconnect()
      container.removeEventListener('contextmenu', onContextMenu)
      unsubs.forEach((u) => u())
      if (ptyId) {
        void window.plano.terminal.kill(ptyId)
        clearVerdict(ptyId)
      }
      detach(panelId)
      term.dispose()
    }
  }, [panelId, containerRef, attach, setStatus, detach, setVerdict, clearVerdict])
}
