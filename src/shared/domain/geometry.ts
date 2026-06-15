/**
 * Pure 2D geometry for the infinite canvas. No DOM, no node — usable on both sides.
 * World coordinates are the persisted, zoom-independent space. Screen coordinates are
 * pixels in the viewport. The camera (Viewport) maps between them.
 */

export interface Point {
  x: number
  y: number
}

export interface Size {
  width: number
  height: number
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** Canvas camera: pan offset (screen px) + zoom factor. */
export interface Transform {
  x: number
  y: number
  zoom: number
}

export const ZOOM_MIN = 0.1
export const ZOOM_MAX = 3
export const DEFAULT_GRID = 24

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function clampZoom(zoom: number): number {
  return clamp(zoom, ZOOM_MIN, ZOOM_MAX)
}

/** Screen point -> world point under the given camera. */
export function screenToWorld(screen: Point, t: Transform): Point {
  return {
    x: (screen.x - t.x) / t.zoom,
    y: (screen.y - t.y) / t.zoom,
  }
}

/** World point -> screen point under the given camera. */
export function worldToScreen(world: Point, t: Transform): Point {
  return {
    x: world.x * t.zoom + t.x,
    y: world.y * t.zoom + t.y,
  }
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  )
}

export function pointInRect(p: Point, r: Rect): boolean {
  return p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height
}

export function snap(value: number, grid: number): number {
  return Math.round(value / grid) * grid
}

/** Axis-aligned bounding box of a set of rects (used for zoom-to-fit). */
export function boundingBox(rects: Rect[]): Rect | null {
  if (rects.length === 0) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const r of rects) {
    minX = Math.min(minX, r.x)
    minY = Math.min(minY, r.y)
    maxX = Math.max(maxX, r.x + r.width)
    maxY = Math.max(maxY, r.y + r.height)
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}
