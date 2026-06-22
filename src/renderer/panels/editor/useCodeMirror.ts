import { useEffect, useRef, type RefObject } from 'react'
import { EditorState, type Extension } from '@codemirror/state'
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
import { languageFor } from './languages'
import { useSettingsStore } from '@/stores/useSettingsStore'

/** Editor chrome in Monolith tones (content/syntax keeps color for legibility). */
const planoTheme = EditorView.theme(
  {
    '&': { backgroundColor: 'var(--surface-1)', color: '#e9e9e6', height: '100%', fontSize: '13px' },
    '.cm-content': { fontFamily: 'var(--font-mono)', padding: '8px 0', caretColor: '#ffffff' },
    '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.55' },
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

interface UseCodeMirrorOpts {
  doc: string
  filePath?: string
  language?: string
  onChange: (value: string) => void
  /** Bound to Ctrl/Cmd+S; receives the current buffer. Omit to leave the chord untouched. */
  onSave?: (value: string) => void
}

export function useCodeMirror(ref: RefObject<HTMLDivElement>, opts: UseCodeMirrorOpts): void {
  // Keep latest callbacks without re-creating the editor on every render.
  const onChangeRef = useRef(opts.onChange)
  onChangeRef.current = opts.onChange
  const onSaveRef = useRef(opts.onSave)
  onSaveRef.current = opts.onSave

  useEffect(() => {
    const parent = ref.current
    if (!parent) return

    // Read editor preferences at mount; new/reopened editors pick up changes.
    const ed = useSettingsStore.getState().settings.editor

    const extensions: Extension[] = [
      ...(ed.lineNumbers ? [lineNumbers(), highlightActiveLineGutter()] : []),
      foldGutter(),
      history(),
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
      ...(ed.wordWrap ? [EditorView.lineWrapping] : []),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) onChangeRef.current(u.state.doc.toString())
      }),
    ]

    const lang = languageFor(opts.filePath, opts.language)
    if (lang) extensions.push(lang)

    const view = new EditorView({
      state: EditorState.create({ doc: opts.doc, extensions }),
      parent,
    })

    return () => view.destroy()
    // Intentionally mount once per panel; file/language are fixed for a given editor instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref])
}
