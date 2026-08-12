/**
 * Auto-update banner (bottom-center). Surfaces the updater lifecycle without stealing focus or
 * overlapping the canvas chrome: ViewControls/Minimap own bottom-right, Dock is left, Toasts are
 * top-center — bottom-center is free. Download progress while fetching, a "Restart" action once
 * the installer is on disk, and a quiet auto-hiding card when a check fails. Nothing in dev.
 */
import { useEffect, useRef, useState } from 'react'
import { useUpdateStore } from '@/stores/useUpdateStore'
import { Button } from '@/design-system/Button'
import { BrandMark } from '@/design-system/BrandMark'

const ERROR_AUTO_HIDE_MS = 10_000

/** Compact byte-rate: "12.4 MB/s", "860 KB/s". */
function formatSpeed(bytesPerSecond: number): string {
  if (bytesPerSecond >= 1024 * 1024) return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s`
  if (bytesPerSecond >= 1024) return `${Math.round(bytesPerSecond / 1024)} KB/s`
  return `${Math.round(bytesPerSecond)} B/s`
}

export function UpdateBanner() {
  const phase = useUpdateStore((s) => s.phase)
  const canCheck = useUpdateStore((s) => s.canCheck)
  const version = useUpdateStore((s) => s.version)
  const percent = useUpdateStore((s) => s.percent)
  const bytesPerSecond = useUpdateStore((s) => s.bytesPerSecond)
  const message = useUpdateStore((s) => s.message)
  const dismissed = useUpdateStore((s) => s.dismissed)
  const checkNow = useUpdateStore((s) => s.checkNow)
  const installNow = useUpdateStore((s) => s.installNow)
  const dismiss = useUpdateStore((s) => s.dismiss)
  const [errorVisible, setErrorVisible] = useState(false)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Auto-hide the error card after a while — a failed check is transient (offline, rate limit),
  // and the next scheduled check will surface it again if it persists.
  useEffect(() => {
    if (phase === 'error') {
      setErrorVisible(true)
      if (hideTimer.current) clearTimeout(hideTimer.current)
      hideTimer.current = setTimeout(() => setErrorVisible(false), ERROR_AUTO_HIDE_MS)
      return () => {
        if (hideTimer.current) clearTimeout(hideTimer.current)
      }
    }
    setErrorVisible(false)
  }, [phase])

  if (!canCheck || dismissed) return null

  // Centering wrapper keeps the -translate-x-1/2 on the fixed element; the card animates inside.
  const shell = 'pointer-events-none fixed bottom-6 left-1/2 z-[var(--z-toast)] -translate-x-1/2'
  const card =
    'pointer-events-auto animate-menu-in surface-layer surface-layer--popover flex w-80 items-center gap-3 px-4 py-3'

  if (phase === 'downloading') {
    return (
      <div className={shell}>
        <div data-surface-layer="popover" className={card}>
          <BrandMark size={16} className="shrink-0 text-text-secondary" />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between gap-3">
              <span className="truncate text-[12.5px] font-medium text-text-1">
                Updating to{version ? ` ${version}` : ''}…
              </span>
              <span className="shrink-0 text-[11.5px] tabular-nums text-text-3">
                {percent ?? 0}%{bytesPerSecond ? ` · ${formatSpeed(bytesPerSecond)}` : ''}
              </span>
            </div>
            <div className="mt-2 h-[3px] w-full overflow-hidden rounded-full bg-surface-inset">
              <div
                className="h-full rounded-full bg-accent transition-[width] duration-200 ease-settle"
                style={{ width: `${percent ?? 0}%` }}
              />
            </div>
          </div>
        </div>
      </div>
    )
  }

  if (phase === 'downloaded') {
    return (
      <div className={shell}>
        <div data-surface-layer="popover" className={card}>
          <BrandMark size={16} className="shrink-0 text-text-secondary" />
          <div className="min-w-0 flex-1 truncate text-[13px] font-medium text-text-1">
            Update ready{version ? ` · v${version}` : ''}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <Button variant="primary" size="sm" onClick={() => void installNow()}>
              Restart
            </Button>
            <Button variant="ghost" size="sm" onClick={dismiss}>
              Later
            </Button>
          </div>
        </div>
      </div>
    )
  }

  if (phase === 'error' && errorVisible) {
    return (
      <div className={shell}>
        <div data-surface-layer="popover" className={card}>
          <BrandMark size={16} className="shrink-0 text-text-secondary" />
          <div className="min-w-0 flex-1 truncate text-[12.5px] text-text-secondary">
            Update check failed{message ? ` — ${message}` : ''}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <Button variant="ghost" size="sm" onClick={() => void checkNow()}>
              Retry
            </Button>
            <Button variant="ghost" size="sm" onClick={dismiss}>
              Dismiss
            </Button>
          </div>
        </div>
      </div>
    )
  }

  return null
}
