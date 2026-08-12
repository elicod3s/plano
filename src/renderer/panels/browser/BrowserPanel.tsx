import { useCallback, useEffect, useRef, useState } from 'react'
import type { Panel, BrowserProps } from '@shared/domain/panel'
import { SEARCH_ENGINES } from '@shared/domain/settings'
import { usePanelStore } from '@/stores/usePanelStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { Icon } from '@/design-system/Icon'
import { IconButton } from '@/design-system/IconButton'
import type { WebviewElement } from '@/types/webview'

const BLANK = 'about:blank'

/** Normalize an address-bar entry into a navigable URL (or a web search via `searchTemplate`). */
function normalizeUrl(input: string, searchTemplate: string): string {
  const value = input.trim()
  if (!value) return BLANK
  // Already an explicit scheme (http://, https://, file://, data:…) → use as-is.
  if (/^[a-z][\w+.-]*:\/\//i.test(value)) return value
  if (/^(about|chrome|data|mailto|file|view-source):/i.test(value)) return value
  // localhost (optionally with port/path) → http, the common dev case.
  if (value === 'localhost' || /^localhost[:/]/i.test(value)) return `http://${value}`
  // Looks like a bare host (has a dot, no whitespace) → assume https.
  if (!/\s/.test(value) && /^[^\s.]+(\.[^\s.]+)+(:\d+)?(\/.*)?$/.test(value)) return `https://${value}`
  // Otherwise treat it as a web search.
  return `${searchTemplate}${encodeURIComponent(value)}`
}

/** What to show in the address bar for a given URL (blank pages read as empty placeholder). */
function displayUrl(url: string): string {
  return !url || url === BLANK ? '' : url
}

export function BrowserPanel({ panel }: { panel: Panel }) {
  const props = panel.props as BrowserProps
  const updateProps = usePanelStore((s) => s.updateProps)
  const setTitle = usePanelStore((s) => s.setTitle)

  const webviewRef = useRef<WebviewElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  // dom-ready gate: the <webview> navigation methods throw if called before the guest is
  // attached. We queue any navigation requested earlier and flush it on dom-ready.
  const readyRef = useRef(false)
  const pendingUrlRef = useRef<string | null>(null)
  // src is set ONCE (see <webview> below). Binding it to the live props.url caused a reload
  // loop: did-navigate → updateProps(url) → re-render → src changes → webview reloads → repeat
  // (endless on sites like Google that rewrite the URL, e.g. ?zx=…). Capture the mount URL.
  const initialUrl = useRef(props.url || BLANK).current
  // The last URL we've reconciled — guards the did-navigate write-back AND the external-nav
  // effect against feedback loops (our own navigations update this first, so the resulting
  // prop change becomes a no-op).
  const lastUrl = useRef(props.url || BLANK)
  // True while the user is editing the address bar — suppresses the live-URL write-back so we
  // never clobber what they're typing.
  const editingRef = useRef(false)

  const [address, setAddress] = useState(displayUrl(props.url || BLANK))
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const [canBack, setCanBack] = useState(false)
  const [canFwd, setCanFwd] = useState(false)

  // Read back/forward availability, preferring the modern navigationHistory controller and
  // falling back to the (deprecated but present) legacy methods. Guarded: the methods throw
  // if the guest isn't live yet.
  const syncNav = useCallback((): void => {
    const view = webviewRef.current
    if (!view) return
    try {
      const nh = view.navigationHistory
      setCanBack(nh?.canGoBack ? nh.canGoBack() : view.canGoBack())
      setCanFwd(nh?.canGoForward ? nh.canGoForward() : view.canGoForward())
    } catch {
      /* guest not ready — keep the last known state */
    }
  }, [])

  // Drive a navigation, gating on dom-ready (queue otherwise). We pre-set lastUrl so the
  // resulting did-navigate write-back doesn't echo back into a reload.
  const navigate = useCallback((url: string): void => {
    const view = webviewRef.current
    if (!view) return
    lastUrl.current = url
    editingRef.current = false
    setAddress(displayUrl(url))
    setFailed(false)
    if (readyRef.current) {
      try {
        void view.loadURL(url)
      } catch {
        pendingUrlRef.current = url
      }
    } else {
      pendingUrlRef.current = url
    }
  }, [])

  useEffect(() => {
    const view = webviewRef.current
    if (!view) return

    const commitUrl = (url: string): void => {
      if (!url || url === lastUrl.current) return
      lastUrl.current = url
      if (!editingRef.current) setAddress(displayUrl(url))
      updateProps<'browser'>(panel.id, { url })
    }

    const onReady = (): void => {
      readyRef.current = true
      const pending = pendingUrlRef.current
      pendingUrlRef.current = null
      if (pending) {
        try {
          void view.loadURL(pending)
        } catch {
          /* ignore */
        }
      }
      syncNav()
    }
    const onStart = (): void => {
      setFailed(false)
      setLoading(true)
    }
    const onStop = (): void => {
      setLoading(false)
      syncNav()
    }
    const onNavigate = (e: Event): void => {
      const url = (e as unknown as { url?: string }).url
      if (url) commitUrl(url)
      syncNav()
    }
    const onFail = (e: Event): void => {
      const ev = e as unknown as { errorCode?: number; isMainFrame?: boolean }
      // -3 == ERR_ABORTED (user navigated away / pressed stop) — not a real failure.
      if (ev.isMainFrame && ev.errorCode !== -3) setFailed(true)
      setLoading(false)
      syncNav()
    }
    const onTitle = (e: Event): void => {
      const title = (e as unknown as { title?: string }).title?.trim()
      // Mirror the page title into the panel header (browser-tab feel). A manual rename
      // sticks until the next navigation, which is the expected tab behaviour.
      if (title && title !== BLANK) setTitle(panel.id, title)
    }

    view.addEventListener('dom-ready', onReady)
    view.addEventListener('did-start-loading', onStart)
    view.addEventListener('did-stop-loading', onStop)
    view.addEventListener('did-navigate', onNavigate as EventListener)
    view.addEventListener('did-navigate-in-page', onNavigate as EventListener)
    view.addEventListener('did-fail-load', onFail as EventListener)
    view.addEventListener('page-title-updated', onTitle as EventListener)
    return () => {
      view.removeEventListener('dom-ready', onReady)
      view.removeEventListener('did-start-loading', onStart)
      view.removeEventListener('did-stop-loading', onStop)
      view.removeEventListener('did-navigate', onNavigate as EventListener)
      view.removeEventListener('did-navigate-in-page', onNavigate as EventListener)
      view.removeEventListener('did-fail-load', onFail as EventListener)
      view.removeEventListener('page-title-updated', onTitle as EventListener)
      readyRef.current = false
    }
  }, [panel.id, updateProps, setTitle, syncNav])

  // Navigate only when props.url changes EXTERNALLY (not from our own did-navigate write-back).
  // Loop-safe via lastUrl: self-driven navigations update lastUrl first, so the prop change
  // they cause is a no-op here.
  useEffect(() => {
    const view = webviewRef.current
    const url = props.url || BLANK
    if (!view || url === lastUrl.current) return
    lastUrl.current = url
    if (!editingRef.current) setAddress(displayUrl(url))
    if (readyRef.current) {
      try {
        void view.loadURL(url)
      } catch {
        pendingUrlRef.current = url
      }
    } else {
      pendingUrlRef.current = url
    }
  }, [props.url])

  const go = (raw: string): void => {
    const engine = useSettingsStore.getState().settings.browser.searchEngine
    navigate(normalizeUrl(raw, SEARCH_ENGINES[engine].query))
    inputRef.current?.blur()
  }

  const back = (): void => {
    const view = webviewRef.current
    try {
      if (view?.navigationHistory?.goBack) view.navigationHistory.goBack()
      else view?.goBack()
    } catch {
      /* ignore */
    }
  }
  const forward = (): void => {
    const view = webviewRef.current
    try {
      if (view?.navigationHistory?.goForward) view.navigationHistory.goForward()
      else view?.goForward()
    } catch {
      /* ignore */
    }
  }
  const reloadOrStop = (): void => {
    const view = webviewRef.current
    try {
      if (loading) view?.stop()
      else view?.reload()
    } catch {
      /* ignore */
    }
  }

  return (
    <div
      className="flex h-full flex-col bg-transparent"
      onKeyDown={(e) => {
        // Ctrl/Cmd+L focuses the address bar (standard browser shortcut).
        if (e.key.toLowerCase() === 'l' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault()
          inputRef.current?.focus()
        }
      }}
    >
      <div className="relative flex h-9 shrink-0 items-center gap-1.5 border-b border-glass px-3">
        <IconButton icon="ArrowLeft" label="Back" size={32} disabled={!canBack} onClick={back} />
        <IconButton icon="ArrowRight" label="Forward" size={32} disabled={!canFwd} onClick={forward} />
        <IconButton
          icon={loading ? 'X' : 'RotateCw'}
          label={loading ? 'Stop' : 'Reload'}
          size={32}
          onClick={reloadOrStop}
        />
        <form
          className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-pill border border-glass px-3 transition-colors focus-within:border-glass-hover"
          style={{ background: 'var(--inset-soft)', boxShadow: '0 1px 6px rgba(0,0,0,0.5)' }}
          onSubmit={(e) => {
            e.preventDefault()
            go(address)
          }}
        >
          <Icon name="Lock" size={11} className="shrink-0" style={{ color: 'var(--success)' }} />
          <input
            ref={inputRef}
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            onFocus={(e) => {
              editingRef.current = true
              // Reclaim keyboard focus from the guest page and select-all (browser-style).
              try {
                webviewRef.current?.blur()
              } catch {
                /* ignore */
              }
              e.currentTarget.select()
            }}
            onBlur={() => {
              editingRef.current = false
              setAddress(displayUrl(lastUrl.current))
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                editingRef.current = false
                setAddress(displayUrl(lastUrl.current))
                inputRef.current?.blur()
              }
            }}
            spellCheck={false}
            placeholder="Search or enter address"
            className="app-no-drag h-full min-w-0 flex-1 bg-transparent font-mono text-[12px] text-text-1 placeholder:text-text-3 focus:outline-none"
          />
        </form>
        {/* Indeterminate loading hairline along the bottom edge of the toolbar. */}
        {loading && (
          <div
            className="pointer-events-none absolute inset-x-0 bottom-0 h-px overflow-hidden"
            aria-hidden
          >
            <div className="h-full w-1/3 animate-progress-slide" style={{ background: 'var(--accent-primary)' }} />
          </div>
        )}
      </div>
      {/* the page — fills the panel below the URL row, clipped by the panel's rounding */}
      <div className="relative min-h-0 flex-1 overflow-hidden" style={{ background: 'var(--inset-deep)' }}>
        <webview
          ref={webviewRef as unknown as React.Ref<HTMLElement>}
          src={initialUrl}
          partition="persist:plano-browser"
          // Lets window.open / target="_blank" reach the guest's window-open handler in main,
          // which denies the popup and loads the URL in-place (see hardenWebviews).
          allowpopups={true}
          style={{ width: '100%', height: '100%', background: 'var(--bg-base)' }}
        />
        {failed && !loading && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-surface-1 text-center">
            <span className="text-[13px] font-semibold text-text-primary">This page couldn’t be loaded</span>
            <span className="max-w-[80%] truncate font-mono text-[11px] text-text-tertiary">
              {displayUrl(lastUrl.current) || 'about:blank'}
            </span>
            <button
              type="button"
              onClick={() => {
                setFailed(false)
                navigate(lastUrl.current)
              }}
              className="app-no-drag rounded-pill bg-surface-4 px-4 py-1.5 text-[12px] font-medium text-text-primary transition-colors hover:bg-accent-soft focus-caliper"
            >
              Try again
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
