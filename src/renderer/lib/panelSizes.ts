import type { Size } from '@shared/domain/geometry'
import type { PanelType } from '@shared/domain/panel'

/**
 * Remembers the last size the user resized each panel TYPE to, so a new panel of that
 * type opens at the size they last preferred (e.g. a terminal reopens at "their" size).
 * Persisted in localStorage so it survives restarts.
 */
const key = (type: PanelType): string => `plano:size:${type}`

export function loadSize(type: PanelType): Size | null {
  try {
    const raw = localStorage.getItem(key(type))
    if (!raw) return null
    const value = JSON.parse(raw) as Partial<Size>
    if (typeof value.width === 'number' && typeof value.height === 'number') {
      return { width: value.width, height: value.height }
    }
  } catch {
    /* ignore corrupt entries */
  }
  return null
}

export function saveSize(type: PanelType, size: Size): void {
  try {
    localStorage.setItem(
      key(type),
      JSON.stringify({ width: Math.round(size.width), height: Math.round(size.height) }),
    )
  } catch {
    /* storage may be unavailable; remembering size is best-effort */
  }
}
