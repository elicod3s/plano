import { useEffect, useRef, type RefObject } from 'react'
import {
  Compartment,
  EditorSelection,
  EditorState,
  Transaction,
  type Extension,
} from '@codemirror/state'
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { searchKeymap } from '@codemirror/search'
import { closeBrackets } from '@codemirror/autocomplete'
import {
  syntaxHighlighting,
  HighlightStyle,
  indentOnInput,
  bracketMatching,
  foldGutter,
} from '@codemirror/language'
import { tags as t } from '@lezer/highlight'
import { languageFor, isMarkdownFile } from './languages'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useViewportStore } from '@/stores/useViewportStore'

/** Editor chrome in Monolith tones (content/syntax keeps color for legibility). */
const planoTheme = EditorView.theme(
  {
    '&': { backgroundColor: 'var(--surface-1)', color: '#e9e9e6', height: '100%', fontSize: '13px' },
    '.cm-content': { fontFamily: 'var(--font-mono)', padding: '8px 0', caretColor: '#ffffff' },
    '.cm-scroller': {
      fontFamily: 'var(--font-mono)',
      lineHeight: '1.55',
      overflowAnchor: 'none',
    },
    '.cm-gutters': {
      backgroundColor: 'var(--surface-inset)',
      color: 'var(--text-quaternary)',
      border: 'none',
    },
    '.cm-activeLineGutter': { backgroundColor: 'rgba(255,255,255,0.04)', color: 'var(--text-secondary)' },
    '.cm-activeLine': { backgroundColor: 'rgba(255,255,255,0.025)' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: '#ffffff' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
      backgroundColor: 'rgba(255,255,255,0.16)',
    },
    '.cm-selectionMatch': { backgroundColor: 'rgba(255,255,255,0.08)' },
    '.cm-foldPlaceholder': { backgroundColor: 'var(--surface-3)', border: 'none', color: 'var(--text-tertiary)' },
  },
  { dark: true },
)

const planoHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.moduleKeyword, t.operatorKeyword], color: '#cba6f7' },
  { tag: [t.string, t.special(t.string)], color: '#a3d9a5' },
  { tag: [t.number, t.bool, t.null, t.atom], color: '#e6c07b' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: '#88b4f0' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: '#6b6a65', fontStyle: 'italic' },
  { tag: [t.typeName, t.className, t.namespace], color: '#8ad7d7' },
  { tag: [t.propertyName, t.attributeName], color: '#c9c8c2' },
  { tag: [t.variableName, t.definition(t.variableName)], color: '#e9e9e6' },
  { tag: [t.tagName], color: '#88b4f0' },
  { tag: [t.invalid], color: '#f87171' },
])

/**
 * Typographic markdown (documents only): headings render at real display sizes in the UI font —
 * a step past VS Code's color-only headings — while syntax marks (#, *, >, `) recede to a quiet
 * gray, bold reads bold, italics italic, and inline code sits in a chip. Monochrome ramp: the
 * design system's white accent + warm grays, so a theme swap re-tints the document.
 */
const markdownHighlight = HighlightStyle.define([
  // Hierarchy by weight and tone (white → gray), not hue — matches the page's own palette.
  {
    tag: t.heading1,
    fontWeight: '780',
    letterSpacing: '-0.02em',
    color: 'var(--text-primary)',
  },
  {
    tag: t.heading2,
    fontWeight: '740',
    letterSpacing: '-0.014em',
    color: 'var(--text-primary)',
  },
  {
    tag: t.heading3,
    fontWeight: '700',
    color: 'var(--text-secondary)',
  },
  {
    tag: t.heading4,
    fontWeight: '660',
    color: 'var(--text-secondary)',
  },
  {
    tag: [t.heading5, t.heading6],
    fontWeight: '620',
    color: 'var(--text-tertiary)',
  },
  { tag: t.strong, fontWeight: '720', color: 'var(--text-primary)' },
  {
    tag: t.emphasis,
    fontStyle: 'italic',
    color: 'var(--text-secondary)',
  },
  { tag: t.strikethrough, textDecoration: 'line-through', color: 'var(--text-tertiary)' },
  {
    tag: t.quote,
    color: 'var(--text-secondary)',
    fontStyle: 'italic',
  },
  {
    tag: t.link,
    color: 'var(--text-primary)',
    textDecoration: 'underline',
    textDecorationColor: 'var(--border-strong)',
    textUnderlineOffset: '3px',
  },
  {
    tag: t.url,
    color: 'var(--text-primary)',
    textDecoration: 'underline',
    textDecorationColor: 'var(--border-strong)',
    textUnderlineOffset: '3px',
  },
  {
    tag: t.monospace,
    color: 'var(--text-primary)',
    backgroundColor: 'var(--surface-2)',
    boxShadow: 'inset 0 0 0 1px var(--border-default)',
    borderRadius: '3px',
    padding: '1px 3px',
  },
  {
    tag: t.contentSeparator,
    color: 'var(--text-tertiary)',
    fontWeight: '600',
    letterSpacing: '0.16em',
  },
  // Structural punctuation recedes to quiet gray: hashes, list marks, quotes and fences.
  {
    tag: t.processingInstruction,
    color: 'var(--text-tertiary)',
    fontWeight: '560',
  },
  {
    tag: [t.documentMeta, t.meta],
    color: 'var(--text-tertiary)',
  },
  { tag: t.labelName, color: 'var(--text-secondary)', fontWeight: '600' },
  { tag: t.escape, color: 'var(--text-secondary)', fontWeight: '600' },
])

/** Document rhythm only; code editors retain their denser grid. */
const markdownEditorTheme = EditorView.theme({
  '.cm-content': { padding: '18px 0 48px' },
  '.cm-line': { paddingLeft: '14px', paddingRight: '18px' },
  '.cm-scroller': { lineHeight: '1.7' },
  '.cm-activeLine': {
    backgroundColor: 'var(--surface-2)',
  },
})

/**
 * Bounded recent-document cache: full EditorStates keyed by path so returning to a recent
 * file restores instantly — undo history, selection and content all come back with the state.
 * Dirty buffers are NEVER evicted silently: eviction skips them (a dirty entry can push the
 * cache past its soft cap; that's fine — dirty docs are few).
 */
const MAX_RECENT_STATES = 8
/** Cap on remembered selection/scroll positions (fresh rebuilds restore them too). */
const MAX_POSITIONS = 32

interface CachedDoc {
  state: EditorState
  dirty: boolean
  used: number
}

interface ViewPosition {
  selection: EditorSelection
  scrollTop: number
  scrollLeft: number
}

/**
 * CodeMirror normalizes line breaks as text enters a document — `\r\n` becomes ONE break — so a
 * buffer's text is always LF, including the one built at mount. Disk content can still arrive
 * CRLF: diffing it raw measures offsets the document will never have, which pushes every
 * position past the change too far (the RangeError) and inserts a stray blank line per `\r`.
 * Normalizing first makes both sides speak the same offsets; the `\r` was never in the buffer.
 */
function normalizeLineEndings(text: string): string {
  return text.includes('\r') ? text.replace(/\r\n?/g, '\n') : text
}

/**
 * Clamp a selection into a document. CodeMirror throws `RangeError: Selection points outside
 * of document` for ANY range past the end — thrown from inside a React effect, so it takes the
 * whole renderer down rather than just the panel. Every selection we hand to a transaction is
 * derived from an EARLIER document (a parked buffer's remembered position, offsets mapped
 * across a diff), so clamping is the correct repair, not a mask.
 */
function clampSelection(selection: EditorSelection, docLength: number): EditorSelection {
  if (selection.ranges.every((range) => range.to <= docLength)) return selection
  const clamp = (position: number): number => Math.max(0, Math.min(position, docLength))
  return EditorSelection.create(
    selection.ranges.map((range) => EditorSelection.range(clamp(range.anchor), clamp(range.head))),
    selection.mainIndex,
  )
}

interface UseCodeMirrorOpts {
  doc: string
  /** Advances when `doc` is intentionally pulled from disk, even when its text is unchanged. */
  docRevision?: number
  filePath?: string
  language?: string
  onChange: (value: string) => void
  /** Bound to Ctrl/Cmd+S; receives the current buffer. Omit to leave the chord untouched. */
  onSave?: (value: string) => void
  /** Panel-level dirty flag; mirrored into the per-path cache so saved buffers cache clean. */
  dirty?: boolean
  /**
   * A path whose dirty buffer the user EXPLICITLY discarded (the panel's discard confirm).
   * When the editor leaves that path its buffer is purged from the cache instead of being
   * parked — the discard stays real, exactly like the pre-cache behavior.
   */
  discardPath?: string
}

export function useCodeMirror(ref: RefObject<HTMLDivElement>, opts: UseCodeMirrorOpts): void {
  // Keep latest callbacks without re-creating the editor on every render.
  const onChangeRef = useRef(opts.onChange)
  onChangeRef.current = opts.onChange
  const onSaveRef = useRef(opts.onSave)
  onSaveRef.current = opts.onSave
  const panelDirtyRef = useRef(opts.dirty === true)
  panelDirtyRef.current = opts.dirty === true

  const viewRef = useRef<EditorView | null>(null)
  const applyingExternalDocRef = useRef(false)
  const pinScrollRef = useRef<((top: number, left: number, durationMs: number) => void) | null>(null)
  /** Path of the buffer currently in the view (undefined = no file). */
  const currentPathRef = useRef<string | undefined>(opts.filePath)
  const recentDocsRef = useRef(new Map<string, CachedDoc>())
  const positionsRef = useRef(new Map<string, ViewPosition>())
  /**
   * Position of a buffer parked with a BLANK document while the panel's fresh read is in
   * flight. It cannot be applied to the blank doc (that is exactly what used to throw), so it
   * waits here and lands together with the content in the same-file path below.
   */
  const pendingRestoreRef = useRef<{ path: string; position: ViewPosition } | null>(null)
  /** Unsaved-edit flag per path, tracked by the hook (survives switches; cleared on save). */
  const perPathDirtyRef = useRef(new Map<string, boolean>())
  const cacheClockRef = useRef(0)

  // Per-file configuration lives in Compartments so a file switch reconfigures the SAME view
  // (language, line wrap, markdown styling, and a fresh undo history per file) in ONE dispatch.
  const compartmentsRef = useRef<{
    lang: Compartment
    wrap: Compartment
    markdown: Compartment
    history: Compartment
  } | null>(null)
  if (!compartmentsRef.current) {
    compartmentsRef.current = {
      lang: new Compartment(),
      wrap: new Compartment(),
      markdown: new Compartment(),
      history: new Compartment(),
    }
  }
  const compartments = compartmentsRef.current

  // Clear the hook's per-path dirty flag when the panel reports a save/apply — the next
  // switch-away then caches the buffer as clean. Declared BEFORE the switch effect so a
  // save-then-switch flushes in the right order.
  useEffect(() => {
    if (panelDirtyRef.current) return
    const path = currentPathRef.current
    if (path) perPathDirtyRef.current.set(path, false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.dirty])

  useEffect(() => {
    const parent = ref.current
    if (!parent) return

    // Read editor preferences at mount; each file switch re-reads them (like a fresh editor
    // used to) so a settings change applies to the next opened file.
    const ed = useSettingsStore.getState().settings.editor
    const isMd = isMarkdownFile(opts.filePath, opts.language)

    const extensions: Extension[] = [
      ...(ed.lineNumbers ? [lineNumbers(), highlightActiveLineGutter()] : []),
      foldGutter(),
      drawSelection(),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      highlightActiveLine(),
      syntaxHighlighting(planoHighlight),
      EditorState.tabSize.of(ed.tabSize),
      keymap.of([
        {
          key: 'Mod-s',
          preventDefault: true,
          run: (view) => {
            onSaveRef.current?.(view.state.doc.toString())
            return true
          },
        },
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
        indentWithTab,
      ]),
      planoTheme,
      EditorView.theme({ '&': { fontSize: `${ed.fontSize}px` } }),
      compartments.lang.of(languageFor(opts.filePath, opts.language) ?? []),
      // Markdown is prose — always soft-wrap it (code files follow the user's setting).
      compartments.wrap.of(ed.wordWrap || isMd ? EditorView.lineWrapping : []),
      compartments.markdown.of(
        isMd ? [syntaxHighlighting(markdownHighlight), markdownEditorTheme] : [],
      ),
      // history() lives in a compartment so a file switch reconfigures it to a FRESH undo
      // stack — the previous file's entries can never leak into the new buffer.
      compartments.history.of(history()),
      EditorView.updateListener.of((u) => {
        if (u.docChanged && !applyingExternalDocRef.current) {
          const path = currentPathRef.current
          if (path) perPathDirtyRef.current.set(path, true)
          // The user typed into the parked buffer — their cursor outranks the old position.
          pendingRestoreRef.current = null
          onChangeRef.current(u.state.doc.toString())
        }
      }),
    ]

    const view = new EditorView({
      state: EditorState.create({ doc: opts.doc, extensions }),
      parent,
    })
    viewRef.current = view

    // ── Canvas-zoom scroll guard ─────────────────────────────────────────────
    // The editor lives inside the canvas's scaled world layer. When the canvas zoom
    // changes, CodeMirror re-measures and its scroll-anchoring compensates using
    // client-px heights from the OLD scale, actively rewriting scrollTop — the open
    // file visibly jumps toward the top. The transform itself never moves a nested
    // scroller, so the right position during a pure zoom is "exactly where it was":
    // pin scrollTop while zoom is changing (plus a trailing beat for CM's async
    // measure passes). Any real user input on the editor releases the pin instantly.
    const scroller = view.scrollDOM
    let keepTop = scroller.scrollTop
    let keepLeft = scroller.scrollLeft
    let guardUntil = 0
    const pinScroll = (top: number, left: number, durationMs: number): void => {
      keepTop = top
      keepLeft = left
      guardUntil = performance.now() + durationMs
      scroller.scrollTop = top
      scroller.scrollLeft = left
    }
    pinScrollRef.current = pinScroll
    const releaseGuard = (): void => {
      guardUntil = 0
      keepTop = scroller.scrollTop
      keepLeft = scroller.scrollLeft
    }
    const onScroll = (): void => {
      if (performance.now() < guardUntil) {
        if (Math.abs(scroller.scrollTop - keepTop) > 1) scroller.scrollTop = keepTop
        if (Math.abs(scroller.scrollLeft - keepLeft) > 1) scroller.scrollLeft = keepLeft
      } else {
        keepTop = scroller.scrollTop
        keepLeft = scroller.scrollLeft
      }
    }
    // A plain wheel / key / pointer on the editor is deliberate scrolling — let it win.
    // (Alt/Ctrl/Shift-wheel zoom-pans never reach the scroller: usePanZoom owns those
    // in the capture phase, so they can't release the pin.)
    scroller.addEventListener('scroll', onScroll, { passive: true })
    scroller.addEventListener('wheel', releaseGuard, { passive: true })
    scroller.addEventListener('pointerdown', releaseGuard, { passive: true })
    scroller.addEventListener('keydown', releaseGuard, true)
    let lastZoom = useViewportStore.getState().zoom
    const unsubZoom = useViewportStore.subscribe((s) => {
      if (s.zoom === lastZoom) return
      lastZoom = s.zoom
      // First notch of a burst: capture the user's position BEFORE CM's rAF measure
      // can touch it (this subscription fires synchronously on the store commit).
      if (performance.now() >= guardUntil) {
        keepTop = scroller.scrollTop
        keepLeft = scroller.scrollLeft
      }
      pinScroll(keepTop, keepLeft, 400)
    })

    return () => {
      unsubZoom()
      scroller.removeEventListener('scroll', onScroll)
      scroller.removeEventListener('wheel', releaseGuard)
      scroller.removeEventListener('pointerdown', releaseGuard)
      scroller.removeEventListener('keydown', releaseGuard, true)
      if (pinScrollRef.current === pinScroll) pinScrollRef.current = null
      if (viewRef.current === view) viewRef.current = null
      view.destroy()
    }
    // Mount once per panel — the view is persistent; file switches reconfigure it below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref])

  // File switch OR external doc update for the current file (live reload / fresh read).
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const filePath = opts.filePath
    if (filePath !== currentPathRef.current) {
      // ── FILE SWITCH — keep this EditorView; swap buffer/state in one shot. ──
      // A switch invalidates any position still waiting for its content to land.
      pendingRestoreRef.current = null
      // 1. Save away the buffer we're leaving: position + full state (undo history, dirty).
      const prev = currentPathRef.current
      if (prev) {
        positionsRef.current.set(prev, {
          selection: view.state.selection,
          scrollTop: view.scrollDOM.scrollTop,
          scrollLeft: view.scrollDOM.scrollLeft,
        })
        trimPositions()
        if (prev === opts.discardPath) {
          // Explicit discard — the user confirmed losing these edits; purge the buffer.
          recentDocsRef.current.delete(prev)
          perPathDirtyRef.current.delete(prev)
        } else {
          const cached = recentDocsRef.current.get(prev)
          if (!cached || cached.state !== view.state) {
            recentDocsRef.current.set(prev, {
              state: view.state,
              dirty: perPathDirtyRef.current.get(prev) === true,
              used: ++cacheClockRef.current,
            })
            evictRecentDocs()
          }
        }
      }
      currentPathRef.current = filePath
      if (!filePath) return // file closed — buffer parked in the cache; pane is hidden

      // 2. Returning to a recent file: restore its full state (undo history intact).
      const cached = recentDocsRef.current.get(filePath)
      const pos = positionsRef.current.get(filePath)
      if (cached) {
        cached.used = ++cacheClockRef.current
        view.setState(cached.state)
        restoreScroll(view, pos?.scrollTop ?? 0, pos?.scrollLeft ?? 0)
        if (cached.dirty) {
          // The restored buffer has unsaved edits — re-sync the panel's value/dirty so a
          // later save writes THIS text, and the disk-read guard doesn't clobber it.
          onChangeRef.current(cached.state.doc.toString())
        }
        return
      }

      // 3. Fresh buffer: ONE transaction reconfigures the per-file compartments (language,
      //    wrap, markdown styling, fresh undo history) and replaces the whole document.
      //    The panel reads the file in the background and fills the blank via the same-file
      //    path below — never a panel-wide loading gate.
      const ed = useSettingsStore.getState().settings.editor
      const isMd = isMarkdownFile(filePath, opts.language)
      const lang = languageFor(filePath, opts.language)
      //    The document this transaction produces is EMPTY, so a cursor at 0 is its only
      //    in-range selection. A remembered position (this file was open before — its state
      //    was evicted from the cache, or its edits were discarded) points past the end of a
      //    blank doc and made CodeMirror throw, killing the renderer. Park it instead; it
      //    lands with the content in the same-file path below.
      if (pos) pendingRestoreRef.current = { path: filePath, position: pos }
      applyingExternalDocRef.current = true
      try {
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: '' },
          selection: EditorSelection.cursor(0),
          effects: [
            compartments.lang.reconfigure(lang ? [lang] : []),
            compartments.wrap.reconfigure(ed.wordWrap || isMd ? EditorView.lineWrapping : []),
            compartments.markdown.reconfigure(
              isMd ? [syntaxHighlighting(markdownHighlight), markdownEditorTheme] : [],
            ),
            compartments.history.reconfigure(history()),
          ],
          annotations: [Transaction.addToHistory.of(false)],
        })
      } finally {
        applyingExternalDocRef.current = false
      }
      restoreScroll(view, pos?.scrollTop ?? 0, pos?.scrollLeft ?? 0)
      return
    }

    // ── SAME FILE — external doc update (live reload, manual reload, fresh read landing). ──
    // A buffer parked blank while its read was in flight restores its remembered position now.
    const parked = pendingRestoreRef.current
    const pending = parked && parked.path === filePath ? parked.position : null
    const current = view.state.doc.toString()
    const next = normalizeLineEndings(opts.doc)
    if (current === next) {
      // Nothing to apply — the parked position has nothing left to land on.
      if (pending) pendingRestoreRef.current = null
      return
    }

    // Apply only the changed middle range. Selection outside it maps naturally, while a
    // selection inside it keeps its relative position instead of collapsing to the file edge.
    let from = 0
    const sharedStartLimit = Math.min(current.length, next.length)
    while (from < sharedStartLimit && current.charCodeAt(from) === next.charCodeAt(from)) from += 1

    let currentTo = current.length
    let nextTo = next.length
    while (
      currentTo > from &&
      nextTo > from &&
      current.charCodeAt(currentTo - 1) === next.charCodeAt(nextTo - 1)
    ) {
      currentTo -= 1
      nextTo -= 1
    }

    const insert = next.slice(from, nextTo)
    const delta = insert.length - (currentTo - from)
    const mapPosition = (position: number): number => {
      if (position < from) return position
      if (position > currentTo || (currentTo === from && position === from)) return position + delta
      return from + Math.min(position - from, insert.length)
    }
    const previousSelection = view.state.selection
    const mappedSelection = EditorSelection.create(
      previousSelection.ranges.map((range) =>
        EditorSelection.range(mapPosition(range.anchor), mapPosition(range.head)),
      ),
      previousSelection.mainIndex,
    )
    const scrollTop = pending?.scrollTop ?? view.scrollDOM.scrollTop
    const scrollLeft = pending?.scrollLeft ?? view.scrollDOM.scrollLeft
    const changes = view.state.changes({ from, to: currentTo, insert })
    // Clamp against the length CodeMirror will actually produce, not the string's: it collapses
    // CRLF into a single line break, so offsets measured on the raw text can overshoot the doc.
    const selection = clampSelection(pending?.selection ?? mappedSelection, changes.newLength)
    // A parked buffer's viewport is a blank document — its snapshot says nothing worth
    // restoring, and it would fight the remembered scroll position below.
    const scrollSnapshot = pending ? null : view.scrollSnapshot().map(changes)
    if (pending) pendingRestoreRef.current = null

    // Pin before dispatch so even a synchronous browser/CodeMirror scroll event cannot replace
    // the saved position. Keep it through delayed Markdown parsing and wrapped-line measurement.
    pinScrollRef.current?.(scrollTop, scrollLeft, 1000)

    applyingExternalDocRef.current = true
    try {
      view.dispatch({
        changes,
        selection,
        effects: scrollSnapshot ? [scrollSnapshot] : undefined,
        annotations: Transaction.addToHistory.of(false),
      })
    } finally {
      applyingExternalDocRef.current = false
    }

    // The buffer now equals the on-disk content — the hook's dirty bookkeeping agrees.
    if (filePath) perPathDirtyRef.current.set(filePath, false)

    const restoreScrollNow = (): void => {
      pinScrollRef.current?.(scrollTop, scrollLeft, 1000)
    }
    restoreScrollNow()
    // Wrapped lines can trigger a later CodeMirror measurement. Restore again in its write
    // phase so that measurement cannot move the viewport after the live update.
    view.requestMeasure({
      read: () => ({ top: scrollTop, left: scrollLeft }),
      write: ({ top, left }) => {
        view.scrollDOM.scrollTop = top
        view.scrollDOM.scrollLeft = left
      },
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.filePath, opts.doc, opts.docRevision])

  /** Restore a saved scroll position through the zoom pin + a measure pass. */
  function restoreScroll(view: EditorView, top: number, left: number): void {
    pinScrollRef.current?.(top, left, 1000)
    view.requestMeasure({
      read: () => ({ top, left }),
      write: ({ top: restoreTop, left: restoreLeft }) => {
        view.scrollDOM.scrollTop = restoreTop
        view.scrollDOM.scrollLeft = restoreLeft
      },
    })
  }

  /** Keep the position cache bounded (FIFO by insertion; re-reads refresh order). */
  function trimPositions(): void {
    const map = positionsRef.current
    if (map.size <= MAX_POSITIONS) return
    const oldest = map.keys().next().value
    if (oldest !== undefined) map.delete(oldest)
  }

  /** LRU eviction that NEVER drops a dirty buffer silently. */
  function evictRecentDocs(): void {
    const map = recentDocsRef.current
    while (map.size > MAX_RECENT_STATES) {
      let oldestKey: string | null = null
      let oldest = Infinity
      for (const [key, entry] of map) {
        if (entry.dirty) continue
        if (entry.used < oldest) {
          oldest = entry.used
          oldestKey = key
        }
      }
      if (oldestKey === null) break // every cached doc is dirty — keep them all
      map.delete(oldestKey)
    }
  }
}
