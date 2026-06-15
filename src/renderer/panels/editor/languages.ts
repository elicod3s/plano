import type { Extension } from '@codemirror/state'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { html } from '@codemirror/lang-html'
import { css } from '@codemirror/lang-css'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'

/** Resolve a CodeMirror language extension from a file path or explicit language id. */
export function languageFor(filePath?: string, language?: string): Extension | null {
  const ext = (language || filePath?.split('.').pop() || '').toLowerCase()
  switch (ext) {
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return javascript({ jsx: ext === 'jsx' })
    case 'ts':
      return javascript({ typescript: true })
    case 'tsx':
      return javascript({ typescript: true, jsx: true })
    case 'json':
      return json()
    case 'html':
    case 'htm':
      return html()
    case 'css':
    case 'scss':
    case 'less':
      return css()
    case 'md':
    case 'markdown':
      return markdown()
    case 'py':
      return python()
    default:
      return null
  }
}
