import { useEffect, useRef, useState } from 'react'
import type { Panel, BrowserProps } from '@shared/domain/panel'
import { usePanelStore } from '@/stores/usePanelStore'
import { IconButton } from '@/design-system/IconButton'
import type { WebviewElement } from '@/types/webview'

/** Normalize an address-bar entry into a navigable URL (or a web search). */
function normalizeUrl(input: string): string {
  const value = input.trim()
  if (!value) return 'about:blank'
  if (/^[a-z]+:\/\//i.test(value) || value === 'about:blank') return value
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(value)) return `https://${value}`
  return `https://www.google.com/search?q=${encodeURIComponent(value)}`
}

export function BrowserPanel({ panel }: { panel: Panel }) {
  const props = panel.props as BrowserProps
  const updateProps = usePanelStore((s) => s.updateProps)
  const webviewRef = useRef<WebviewElement | null>(null)

  const [address, setAddress] = useState(props.url)
  const [loading, setLoading] = useState(false)
  const [canBack, setCanBack] = useState(false)
  const [canFwd, setCanFwd] = useState(false)

  useEffect(() => {
    const view = webviewRef.current
    if (!view) return
    const onStart = (): void => setLoading(true)
    const onStop = (): void => {
      setLoading(false)
      setCanBack(view.canGoBack())
      setCanFwd(view.canGoForward())
    }
    const onNavigate = (e: Event): void => {
      const url = (e as unknown as { url: string }).url
      if (url) {
        setAddress(url)
        updateProps<'browser'>(panel.id, { url })
      }
    }
    view.addEventListener('did-start-loading', onStart)
    view.addEventListener('did-stop-loading', onStop)
    view.addEventListener('did-navigate', onNavigate as EventListener)
    view.addEventListener('did-navigate-in-page', onNavigate as EventListener)
    return () => {
      view.removeEventListener('did-start-loading', onStart)
      view.removeEventListener('did-stop-loading', onStop)
      view.removeEventListener('did-navigate', onNavigate as EventListener)
      view.removeEventListener('did-navigate-in-page', onNavigate as EventListener)
    }
  }, [panel.id, updateProps])

  const go = (raw: string): void => {
    const url = normalizeUrl(raw)
    setAddress(url)
    void webviewRef.current?.loadURL(url)
  }

  return (
    <div className="flex h-full flex-col bg-surface-1">
      <div className="flex h-10 items-center gap-1 border-b border-subtle bg-surface-2 px-2">
        <IconButton icon="ArrowLeft" label="Back" size={26} disabled={!canBack} onClick={() => webviewRef.current?.goBack()} />
        <IconButton icon="ArrowRight" label="Forward" size={26} disabled={!canFwd} onClick={() => webviewRef.current?.goForward()} />
        <IconButton
          icon={loading ? 'X' : 'RotateCw'}
          label={loading ? 'Stop' : 'Reload'}
          size={26}
          onClick={() => (loading ? webviewRef.current?.stop() : webviewRef.current?.reload())}
        />
        <form
          className="flex-1"
          onSubmit={(e) => {
            e.preventDefault()
            go(address)
          }}
        >
          <input
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            spellCheck={false}
            placeholder="Search or enter address"
            className="app-no-drag h-7 w-full rounded-pill bg-surface-4 px-3 font-mono text-[12px] text-text-primary placeholder:text-text-tertiary focus-caliper"
          />
        </form>
      </div>
      <div className="relative min-h-0 flex-1">
        <webview
          ref={webviewRef as unknown as React.Ref<HTMLElement>}
          src={props.url}
          partition="persist:plano-browser"
          style={{ width: '100%', height: '100%', background: '#0b0b0a' }}
        />
      </div>
    </div>
  )
}
