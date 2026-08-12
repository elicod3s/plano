/** A minimal external store (useSyncExternalStore-compatible) for live daemon state. */
import { useSyncExternalStore } from 'react'

export function createStore<T>(initial: T) {
  let state = initial
  const listeners = new Set<() => void>()
  return {
    get: (): T => state,
    set: (updater: T | ((prev: T) => T)): void => {
      state = typeof updater === 'function' ? (updater as (p: T) => T)(state) : updater
      for (const l of listeners) l()
    },
    subscribe: (l: () => void): (() => void) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    use: (): T => useSyncExternalStore(
      (l) => {
        listeners.add(l)
        return () => listeners.delete(l)
      },
      () => state,
      () => state,
    ),
  }
}
