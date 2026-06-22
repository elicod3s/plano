import type { TodoPriority } from '@shared/domain/panel'

export interface PriorityDef {
  key: TodoPriority
  label: string
  /** CSS variable reference (declared in theme.css), never a raw hex per the design rule. */
  color: string
}

/** Ordered low → high; drives the flag picker, the left-click cycle, and priority sort. */
export const PRIORITIES: PriorityDef[] = [
  { key: 'none', label: 'No priority', color: 'var(--priority-none)' },
  { key: 'low', label: 'Low', color: 'var(--priority-low)' },
  { key: 'medium', label: 'Medium', color: 'var(--priority-medium)' },
  { key: 'high', label: 'High', color: 'var(--priority-high)' },
  { key: 'urgent', label: 'Urgent', color: 'var(--priority-urgent)' },
]

export const PRIORITY_RANK: Record<TodoPriority, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  urgent: 4,
}

export const priorityColor = (p: TodoPriority): string =>
  PRIORITIES.find((d) => d.key === p)?.color ?? 'var(--priority-none)'

export const priorityLabel = (p: TodoPriority): string =>
  PRIORITIES.find((d) => d.key === p)?.label ?? 'No priority'

/** Next priority in the cycle (used by left-clicking a task's flag). */
export const nextPriority = (p: TodoPriority): TodoPriority => {
  const i = PRIORITIES.findIndex((d) => d.key === p)
  return PRIORITIES[(i + 1) % PRIORITIES.length].key
}
