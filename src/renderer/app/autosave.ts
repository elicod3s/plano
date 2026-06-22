/**
 * The canvas autosave timer, lifted out of App's closure so the workspace lifecycle can
 * coordinate with it. `workspaceActions` suspends it around programmatic canvas swaps (hydrate,
 * space switch) and cancels it before tearing down a project — so a load can never schedule a
 * save of the doc it just replaced (the bug that let a blank/stale doc get persisted over a
 * real workspace). App.tsx wires the panel + viewport store subscriptions to `scheduleAutosave`.
 */

import { useSettingsStore } from '@/stores/useSettingsStore'
import { useWorkspaceStore } from '@/stores/useWorkspaceStore'
import { saveCurrent } from '@/app/workspaceActions'

const AUTOSAVE_DELAY_MS = 800
let timer: number | undefined
let suspended = false

/** Suspend/resume autosave around programmatic canvas swaps (hydrate, space switch). */
export function setAutosaveSuspended(value: boolean): void {
  suspended = value
}

/**
 * Debounced save after a genuine user edit. No-op while suspended, while a project isn't fully
 * open (loading / no folder), or when autosave is disabled — so only real edits ever persist,
 * never the canvas churn of loading another workspace.
 */
export function scheduleAutosave(): void {
  if (suspended) return
  if (useWorkspaceStore.getState().status !== 'ready') return
  if (!useSettingsStore.getState().settings.canvas.autosave) return
  useWorkspaceStore.getState().markDirty()
  window.clearTimeout(timer)
  timer = window.setTimeout(() => void saveCurrent(), AUTOSAVE_DELAY_MS)
}

/** Cancel any pending autosave (e.g. before switching projects). */
export function cancelAutosave(): void {
  window.clearTimeout(timer)
  timer = undefined
}
