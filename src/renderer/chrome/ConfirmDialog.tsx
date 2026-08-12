/**
 * App-styled confirmation dialog (glass voice) — the single mounted instance that
 * replaces the native `window.confirm`. Driven by useConfirmStore via the `confirm()` helper.
 * Enter confirms, Escape / click-out cancels; the confirm button is auto-focused.
 */
import { useEffect, useRef } from 'react'
import { useConfirmStore } from '@/stores/useConfirmStore'
import { Button } from '@/design-system/Button'
import { Icon } from '@/design-system/Icon'
import { cn } from '@/lib/cn'

export function ConfirmDialog() {
  const open = useConfirmStore((s) => s.open)
  const options = useConfirmStore((s) => s.options)
  const respond = useConfirmStore((s) => s.respond)
  const confirmRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        respond(false)
      } else if (e.key === 'Enter') {
        e.preventDefault()
        respond(true)
      }
    }
    window.addEventListener('keydown', onKey)
    requestAnimationFrame(() => confirmRef.current?.focus())
    return () => window.removeEventListener('keydown', onKey)
  }, [open, respond])

  if (!open || !options) return null
  const { danger, title, message, confirmLabel, cancelLabel } = options

  return (
    <div
      className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center p-6"
      style={{ background: 'var(--scrim)' }}
      onPointerDown={() => respond(false)}
    >
      <div
        data-surface-layer="modal"
        className="animate-palette-in surface-layer surface-layer--modal w-[400px] max-w-[92vw] overflow-hidden rounded-[26px]"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-[13px] px-[22px] pb-2 pt-[22px]">
          <div
            className={cn(
              'flex h-10 w-10 shrink-0 items-center justify-center rounded-pill border',
              danger
                ? 'border-destructive-border text-destructive-hover'
                : 'border-glass-strong text-text-2',
            )}
            style={danger ? { background: 'var(--destructive-soft)' } : { background: 'var(--glass)' }}
          >
            <Icon name={danger ? 'TriangleAlert' : 'CircleHelp'} size={18} />
          </div>
          <div className="min-w-0 flex-1 py-0.5">
            <h2 className="text-[16.5px] font-semibold tracking-tightui text-text-1">{title ?? 'Are you sure?'}</h2>
            <p className="mt-1.5 text-[13.5px] leading-relaxed text-text-2">{message}</p>
          </div>
        </div>

        <div
          className="mt-4 flex items-center justify-end gap-2.5 px-[22px] py-5"
          style={{ borderTop: '1px solid var(--border-glass)' }}
        >
          <Button variant="ghost" size="sm" className="h-[34px] rounded-[12px]" onClick={() => respond(false)}>
            {cancelLabel ?? 'Cancel'}
          </Button>
          {danger ? (
            <button
              ref={confirmRef}
              type="button"
              onClick={() => respond(true)}
              className="app-no-drag inline-flex h-[34px] items-center rounded-[12px] bg-destructive px-4 text-[13px] font-semibold text-white transition-colors hover:bg-destructive-hover focus-caliper-danger"
            >
              {confirmLabel ?? 'Confirm'}
            </button>
          ) : (
            <Button ref={confirmRef} variant="primary" size="sm" className="h-[34px] rounded-[12px]" onClick={() => respond(true)}>
              {confirmLabel ?? 'Confirm'}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
