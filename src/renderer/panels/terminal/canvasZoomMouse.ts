import type { Terminal } from '@xterm/xterm'

/**
 * Keep an xterm terminal's mouse mapping correct while it lives inside the canvas's
 * `transform: scale(zoom)` world layer.
 *
 * THE PROBLEM. xterm resolves a pointer event to a cell by measuring the pointer relative to its
 * screen element (`getBoundingClientRect()`, which reflects the world's scale) and dividing by the
 * cell size in *unscaled* CSS pixels. The two are in different spaces, so at any zoom ≠ 1 the
 * result comes out as `cell × zoom`: selection, mouse-reporting (agent TUIs like htop/vim) and link
 * hover all drift — zoomed out, a click lands a line or more ABOVE the pointer, and the error grows
 * toward the bottom of the panel.
 *
 * WHY A WRAPPER, NOT A SETTING. xterm exposes no public API to tell it about an enclosing CSS
 * transform (a long-standing upstream gap). The alternatives are worse: rendering the terminal at
 * screen-scale-1 and resizing it would reflow the shell/TUI every time you zoom the canvas, which is
 * far more disruptive than this. So we wrap the one internal seam — the mouse service's coordinate
 * methods — and feed them a pointer whose offset has been un-scaled by the live zoom, which exactly
 * cancels the transform. xterm's own cell math then runs unchanged and resolves the true cell.
 *
 * Properties that make this safe rather than a hack:
 *  - Nothing is hardcoded: it derives everything from the *live* `getZoom()` each event, so it is
 *    correct at every zoom, including ones never used before.
 *  - It is a pure no-op at zoom 1 (the common case): the original event passes straight through.
 *  - It is feature-detected and guarded: if a future xterm moves these internals, the patch simply
 *    doesn't apply and the terminal falls back to xterm's stock behavior instead of throwing.
 *  - It is the single, clearly-labelled place that reaches into xterm internals; pin is `5.5.0`.
 *
 * @param term     the xterm instance, already `open()`ed (its mouse service exists by then)
 * @param getZoom  reads the current camera zoom (injected so this stays decoupled + testable)
 */
export function applyCanvasZoomMouseFix(term: Terminal, getZoom: () => number): void {
  const service = (term as unknown as { _core?: { _mouseService?: Record<string, unknown> } })._core
    ?._mouseService
  if (!service) return

  // Return a pointer whose distance from the element is divided by the zoom, so when xterm
  // subtracts the (scaled) element origin and divides by the (unscaled) cell size, the cell is
  // exact. Only the coordinates are overridden — every other event prop/method passes through.
  const unscalePointer = (event: MouseEvent, element: HTMLElement): MouseEvent => {
    // `getZoom()` returns the EFFECTIVE on-screen scale (world zoom ÷ render-box counter-scale), which
    // can be a non-integer ratio (e.g. 20/13). Compare with a small epsilon, not `=== 1`, so a value
    // that rounds to 1 is treated as the no-op it is rather than slipping into the proxy path.
    const zoom = getZoom() || 1
    if (Math.abs(zoom - 1) < 1e-3) return event
    const rect = element.getBoundingClientRect()
    const clientX = rect.left + (event.clientX - rect.left) / zoom
    const clientY = rect.top + (event.clientY - rect.top) / zoom
    return new Proxy(event, {
      get(target, prop) {
        if (prop === 'clientX') return clientX
        if (prop === 'clientY') return clientY
        const value = Reflect.get(target, prop)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  }

  // Both coordinate methods share the same (event, element, …) shape and the same scaled-offset bug.
  for (const method of ['getCoords', 'getMouseReportCoords'] as const) {
    const original = service[method]
    if (typeof original !== 'function') continue
    const bound = (original as (...args: unknown[]) => unknown).bind(service)
    service[method] = (event: MouseEvent, element: HTMLElement, ...rest: unknown[]): unknown =>
      bound(unscalePointer(event, element), element, ...rest)
  }
}
