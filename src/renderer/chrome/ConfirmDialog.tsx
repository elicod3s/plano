/**
 * App-styled confirmation dialog (Monolith voice) — the single mounted instance that
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
      className="fixed inset-0 z-[80] flex items-center justify-center p-6"
      style={{ background: 'var(--scrim)', backdropFilter: 'blur(12px)' }}
      onPointerDown={() => respond(false)}
    >
      <div
        className="animate-palette-in w-[400px] max-w-[92vw] overflow-hidden rounded-xl border border-strong shadow-overlay"
        style={{ background: 'var(--bg-base)' }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 px-5 pt-5">
          <div
            className={cn(
              'flex h-9 w-9 shrink-0 items-center justify-center rounded-md border',
              danger ? 'border-destructive-border text-destructive-hover' : 'border-default text-text-secondary',
            )}
            style={danger ? { background: 'var(--destructive-soft)' } : undefined}
          >
            <Icon name={danger ? 'TriangleAlert' : 'CircleHelp'} size={18} />
          </div>
          <div className="min-w-0 flex-1 pt-0.5">
            <h2 className="text-[15px] font-semibold text-text-primary">{title ?? 'Are you sure?'}</h2>
            <p className="mt-1 text-[13px] leading-relaxed text-text-secondary">{message}</p>
          </div>
        </div>

        <div className="mt-5 flex items-center justify-end gap-2 border-t border-subtle bg-surface-1 px-4 py-3">
          <Button variant="ghost" size="sm" onClick={() => respond(false)}>
            {cancelLabel ?? 'Cancel'}
          </Button>
          {danger ? (
            <button
              ref={confirmRef}
              type="button"
              onClick={() => respond(true)}
              className="app-no-drag inline-flex h-8 items-center rounded-sm border border-destructive-border bg-destructive-soft px-3.5 text-[13px] font-medium text-destructive-hover transition-colors hover:bg-destructive hover:text-white focus-caliper-danger"
            >
              {confirmLabel ?? 'Confirm'}
            </button>
          ) : (
            <Button ref={confirmRef} variant="primary" size="sm" onClick={() => respond(true)}>
              {confirmLabel ?? 'Confirm'}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
