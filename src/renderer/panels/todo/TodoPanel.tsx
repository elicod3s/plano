import { useMemo, useState } from 'react'
import type { Panel, TodoItem, TodoPriority, TodoProps } from '@shared/domain/panel'
import { usePanelStore } from '@/stores/usePanelStore'
import { IconButton } from '@/design-system/IconButton'
import { Icon } from '@/design-system/Icon'
import { LinkedText } from '@/design-system/LinkedText'
import { newId } from '@/lib/id'
import { cn } from '@/lib/cn'
import { TodoContextMenu } from './TodoContextMenu'
import { PRIORITY_RANK, nextPriority, priorityColor, priorityLabel } from './priority'

type Filter = TodoProps['filter']
const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'active', label: 'Active' },
  { key: 'completed', label: 'Done' },
]

interface MenuState {
  item: TodoItem
  x: number
  y: number
}

export function TodoPanel({ panel }: { panel: Panel }) {
  const props = panel.props as TodoProps
  const updateProps = usePanelStore((s) => s.updateProps)

  const [draft, setDraft] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)

  // Always mutate from the freshest store state to avoid stale-closure races.
  const current = (): TodoItem[] => (usePanelStore.getState().panels[panel.id]?.props as TodoProps)?.todos ?? []
  const commit = (todos: TodoItem[]): void => updateProps<'todo'>(panel.id, { todos })
  const setFilter = (filter: Filter): void => updateProps<'todo'>(panel.id, { filter })

  const addTodo = (): void => {
    const text = draft.trim()
    if (!text) return
    commit([
      ...current(),
      { id: newId(), text, done: false, priority: 'none', createdAt: Date.now() },
    ])
    setDraft('')
  }
  const toggle = (id: string): void =>
    commit(current().map((t) => (t.id === id ? { ...t, done: !t.done } : t)))
  const setPriority = (id: string, priority: TodoPriority): void =>
    commit(current().map((t) => (t.id === id ? { ...t, priority } : t)))
  const rename = (id: string, text: string): void => {
    const next = text.trim()
    commit(next ? current().map((t) => (t.id === id ? { ...t, text: next } : t)) : current().filter((t) => t.id !== id))
  }
  const remove = (id: string): void => commit(current().filter((t) => t.id !== id))
  const duplicate = (id: string): void => {
    const list = current()
    const i = list.findIndex((t) => t.id === id)
    if (i < 0) return
    const copy: TodoItem = { ...list[i], id: newId(), done: false, createdAt: Date.now() }
    commit([...list.slice(0, i + 1), copy, ...list.slice(i + 1)])
  }
  const moveTop = (id: string): void => {
    const list = current()
    const item = list.find((t) => t.id === id)
    if (!item) return
    commit([item, ...list.filter((t) => t.id !== id)])
  }
  const moveBottom = (id: string): void => {
    const list = current()
    const item = list.find((t) => t.id === id)
    if (!item) return
    commit([...list.filter((t) => t.id !== id), item])
  }
  const sortByPriority = (): void =>
    commit(
      [...current()].sort(
        (a, b) =>
          Number(a.done) - Number(b.done) ||
          PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority] ||
          a.createdAt - b.createdAt,
      ),
    )
  const clearCompleted = (): void => commit(current().filter((t) => !t.done))

  const filter = props.filter ?? 'all'
  const todos = props.todos ?? []
  const visible = useMemo(
    () =>
      todos.filter((t) => (filter === 'active' ? !t.done : filter === 'completed' ? t.done : true)),
    [todos, filter],
  )
  const remaining = todos.filter((t) => !t.done).length
  const hasCompleted = todos.some((t) => t.done)

  const openMenu = (item: TodoItem) => (e: React.MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ item, x: e.clientX, y: e.clientY })
  }

  return (
    <div className="flex h-full w-full flex-col bg-transparent">
      {/* add row */}
      <div className="mx-3 mt-3 flex h-[34px] shrink-0 items-center gap-2 rounded-[11px] border border-glass px-3 transition-colors focus-within:border-glass-hover" style={{ background: 'var(--inset-soft)' }}>
        <Icon name="Plus" size={15} className="shrink-0 text-text-3" />
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') addTodo()
          }}
          placeholder="Add a task…"
          spellCheck={false}
          className="app-no-drag h-7 min-w-0 flex-1 bg-transparent text-[13px] text-text-primary placeholder:text-text-quaternary focus:outline-none"
        />
        {draft.trim() && (
          <button
            type="button"
            onClick={addTodo}
            className="app-no-drag h-7 shrink-0 rounded-sm bg-accent px-2.5 text-[12px] font-medium text-text-onsolid transition-colors hover:bg-accent-hover"
          >
            Add
          </button>
        )}
      </div>

      {/* toolbar: filter + actions */}
      <div className="mx-3 mt-1 flex h-[34px] shrink-0 items-center gap-1">
        <div className="flex items-center rounded-pill border border-glass p-0.5" style={{ background: 'var(--glass)' }}>
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              className={cn(
                'app-no-drag h-6 rounded-pill px-2.5 text-[11px] font-medium transition-colors',
                filter === f.key ? 'bg-accent text-text-onsolid' : 'text-text-3 hover:text-text-2',
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
        <span className="ml-auto font-mono text-[11px] text-text-3">
          {remaining} left
        </span>
        <IconButton icon="ArrowDownWideNarrow" label="Sort by priority" size={26} onClick={sortByPriority} />
        <IconButton icon="Eraser" label="Clear completed" size={26} disabled={!hasCompleted} onClick={clearCompleted} />
      </div>

      {/* list */}
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-2">
        {visible.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
            <Icon name="ListChecks" size={22} className="text-text-4" />
            <p className="text-[12px] text-text-3">
              {todos.length === 0 ? 'No tasks yet. Add one above.' : 'Nothing here.'}
            </p>
          </div>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {visible.map((item) => (
              <li
                key={item.id}
                onContextMenu={openMenu(item)}
                // items-start (not center) so a task that wraps to several lines keeps its checkbox /
                // flag aligned to the FIRST line instead of floating to the vertical middle.
                className="group/row flex min-h-[38px] items-center gap-2.5 rounded-[11px] px-2.5 transition-colors hover:bg-glass"
              >
                {/* checkbox — the design's 20px accent circle */}
                <button
                  type="button"
                  onClick={() => toggle(item.id)}
                  aria-label={item.done ? 'Mark as active' : 'Mark as complete'}
                  className={cn(
                    'app-no-drag flex h-5 w-5 shrink-0 items-center justify-center rounded-pill transition-colors',
                    item.done
                      ? 'bg-accent text-text-onsolid'
                      : 'border hover:border-text-2',
                  )}
                  style={item.done ? undefined : { borderColor: 'var(--border-glass-hover)' }}
                >
                  {item.done && <Icon name="Check" size={12} strokeWidth={3} />}
                </button>

                {/* priority flag — click to cycle, right-click row for the full picker */}
                <button
                  type="button"
                  onClick={() => setPriority(item.id, nextPriority(item.priority))}
                  title={`Priority: ${priorityLabel(item.priority)}`}
                  className="app-no-drag flex h-5 w-5 shrink-0 items-center justify-center rounded-sm hover:bg-accent-soft"
                >
                  <Icon
                    name="Flag"
                    size={13}
                    color={priorityColor(item.priority)}
                    fill={item.priority === 'none' ? 'none' : priorityColor(item.priority)}
                    className={item.priority === 'none' ? 'opacity-50' : ''}
                  />
                </button>

                {/* text / inline edit */}
                {editingId === item.id ? (
                  // A textarea (not input) so a long task wraps and the WHOLE thing is visible while
                  // editing; it auto-grows to fit. Enter commits (a task is one logical line), Escape
                  // cancels, and any pasted line breaks are collapsed to spaces on commit.
                  <textarea
                    autoFocus
                    rows={1}
                    spellCheck={false}
                    defaultValue={item.text}
                    onFocus={(e) => {
                      const v = e.currentTarget.value
                      e.currentTarget.setSelectionRange(v.length, v.length)
                    }}
                    onBlur={(e) => {
                      rename(item.id, e.target.value.replace(/\s+/g, ' '))
                      setEditingId(null)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        ;(e.target as HTMLTextAreaElement).blur()
                      }
                      if (e.key === 'Escape') setEditingId(null)
                    }}
                    className="app-no-drag min-w-0 flex-1 resize-none whitespace-pre-wrap break-words bg-transparent text-[13px] leading-5 text-text-primary focus:outline-none [field-sizing:content]"
                  />
                ) : (
                  <span
                    onDoubleClick={() => setEditingId(item.id)}
                    // Wrap + break long words so the full task text is always visible (no ellipsis).
                    className={cn(
                      'min-w-0 flex-1 whitespace-pre-wrap break-words text-[13px] leading-5',
                      item.done ? 'text-text-quaternary line-through' : 'text-text-primary',
                    )}
                  >
                    <LinkedText text={item.text} />
                  </span>
                )}

                {/* quick delete on hover */}
                <IconButton
                  icon="Trash2"
                  label="Delete task"
                  size={24}
                  danger
                  onClick={() => remove(item.id)}
                  className="shrink-0 opacity-0 transition-opacity group-hover/row:opacity-100"
                />
              </li>
            ))}
          </ul>
        )}
      </div>

      {menu && (
        <TodoContextMenu
          item={menu.item}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          onSetPriority={(p) => setPriority(menu.item.id, p)}
          onEdit={() => setEditingId(menu.item.id)}
          onToggle={() => toggle(menu.item.id)}
          onDuplicate={() => duplicate(menu.item.id)}
          onMoveTop={() => moveTop(menu.item.id)}
          onMoveBottom={() => moveBottom(menu.item.id)}
          onDelete={() => remove(menu.item.id)}
        />
      )}
    </div>
  )
}
