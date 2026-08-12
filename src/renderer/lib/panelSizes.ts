import type { Size } from '@shared/domain/geometry'
import type { PanelType } from '@shared/domain/panel'

/**
 * Remembers the last size the user resized each panel TYPE to, so a new panel of that
 * type opens at the size they last preferred (e.g. a terminal reopens at "their" size).
 * Persisted in localStorage so it survives restarts. The v2 key intentionally resets the old,
 * unbounded values that could make every newly opened panel fill a huge part of the canvas.
 */
const key = (type: PanelType): string => 'plano:size:v2:' + type
const MAX_DEFAULT_SCALE = 1.5

function bounded(size: Size, defaultSize: Size): Size {
  return {
    width: Math.min(Math.round(size.width), Math.round(defaultSize.width * MAX_DEFAULT_SCALE)),
    height: Math.min(Math.round(size.height), Math.round(defaultSize.height * MAX_DEFAULT_SCALE)),
  }
}

export function loadSize(type: PanelType, defaultSize: Size): Size | null {
  try {
    const raw = localStorage.getItem(key(type))
    if (!raw) return null
    const value = JSON.parse(raw) as Partial<Size>
    if (
      typeof value.width === 'number' &&
      Number.isFinite(value.width) &&
      value.width > 0 &&
      typeof value.height === 'number' &&
      Number.isFinite(value.height) &&
      value.height > 0
    ) {
      return bounded({ width: value.width, height: value.height }, defaultSize)
    }
  } catch {
    /* ignore corrupt entries */
  }
  return null
}

export function saveSize(type: PanelType, size: Size, defaultSize: Size): void {
  try {
    const next = bounded(size, defaultSize)
    localStorage.setItem(
      key(type),
      JSON.stringify(next),
    )
  } catch {
    /* storage may be unavailable; remembering size is best-effort */
  }
}

/** Forget the preferred size for this panel type; the next panel uses PANEL_META.defaultSize. */
export function clearSize(type: PanelType): void {
  try {
    localStorage.removeItem(key(type))
  } catch {
    /* storage may be unavailable */
  }
}
