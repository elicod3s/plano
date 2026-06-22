import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import type { TodoItem, TodoPriority } from '@shared/domain/panel'
import { Icon } from '@/design-system/Icon'
import { cn } from '@/lib/cn'
import { PRIORITIES } from './priority'

const MENU_WIDTH = 224

interface Action {
  label: string
  icon: string
  onClick: () => void
  danger?: boolean
}

/**
 * Right-click menu for a single task. Rendered in a body portal so the canvas transform
 * can't scale or clip it. The top strip is the colored priority-flag picker; standard task
 * actions follow. Priority flags are the one place color enters the To-do panel — they tag
 * user task data, like a label color (see theme.css priority tokens).
 */
export function TodoContextMenu({
  item,
  x,
  y,
  onClose,
  onSetPriority,
  onEdit,
  onToggle,
  onDuplicate,
  onMoveTop,
  onMoveBottom,
  onDelete,
}: {
  item: TodoItem
  x: number
  y: number
  onClose: () => void
  onSetPriority: (p: TodoPriority) => void
  onEdit: () => void
  onToggle: () => void
  onDuplicate: () => void
  onMoveTop: () => void
  onMoveBottom: () => void
  onDelete: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const run = (fn: () => void) => (): void => {
    fn()
    onClose()
  }

  const actions: Array<Action | 'separator'> = [
    { label: 'Rename', icon: 'Pencil', onClick: onEdit },
    {
      label: item.done ? 'Mark as active' : 'Mark as complete',
      icon: item.done ? 'Circle' : 'CheckCircle2',
      onClick: onToggle,
    },
    { label: 'Duplicate', icon: 'Copy', onClick: onDuplicate },
    'separator',
    { label: 'Move to top', icon: 'ArrowUpToLine', onClick: onMoveTop },
    { label: 'Move to bottom', icon: 'ArrowDownToLine', onClick: onMoveBottom },
    'separator',
    { label: 'Delete', icon: 'Trash2', onClick: onDelete, danger: true },
  ]

  // Estimated height: flag strip (~46) + actions (32 each) + separators + padding.
  const approxHeight = 60 + actions.length * 32
  const left = Math.min(x, window.innerWidth - MENU_WIDTH - 12)
  const top = Math.min(y, window.innerHeight - approxHeight)

  return createPortal(
    <>
      <div
        className="fixed inset-0 z-[70]"
        onPointerDown={onClose}
        onContextMenu={(e) => {
          e.preventDefault()
          onClose()
        }}
      />
      <div
        className="animate-menu-in fixed z-[71] origin-top-left rounded-md border bg-surface-3 p-1.5 shadow-popover"
        style={{ left, top: Math.max(8, top), width: MENU_WIDTH }}
        onContextMenu={(e) => e.preventDefault()}
      >
        {/* priority flag picker */}
        <div className="px-1 pb-1 pt-0.5">
          <div className="label-caps px-1 pb-1 text-text-tertiary">Priority</div>
          <div className="flex items-center gap-1">
            {PRIORITIES.map((p) => {
              const selected = item.priority === p.key
              return (
                <button
                  key={p.key}
                  type="button"
                  title={p.label}
                  onClick={run(() => onSetPriority(p.key))}
                  className={cn(
                    'flex h-8 flex-1 items-center justify-center rounded-sm border transition-colors',
                    selected ? 'border-strong bg-accent-soft-strong' : 'border-transparent hover:bg-accent-soft',
                  )}
                >
                  <Icon
                    name={p.key === 'none' ? 'FlagOff' : 'Flag'}
                    size={15}
                    color={p.color}
                    fill={p.key === 'none' ? 'none' : p.color}
                  />
                </button>
              )
            })}
          </div>
        </div>

        <div className="mx-1 my-1 h-px bg-[var(--border-subtle)]" />

        {actions.map((action, i) =>
          action === 'separator' ? (
            <div key={i} className="mx-1 my-1 h-px bg-[var(--border-subtle)]" />
          ) : (
            <button
              key={i}
              type="button"
              onClick={run(action.onClick)}
              className={cn(
                'flex h-8 w-full items-center gap-2.5 rounded-sm px-2 text-left text-[13px] transition-colors',
                action.danger
                  ? 'text-text-primary hover:bg-destructive-soft hover:text-destructive-hover'
                  : 'text-text-primary hover:bg-accent-soft',
              )}
            >
              <Icon
                name={action.icon}
                size={15}
                className={action.danger ? 'text-destructive' : 'text-text-secondary'}
              />
              <span className="flex-1">{action.label}</span>
            </button>
          ),
        )}
      </div>
    </>,
    document.body,
  )
}
