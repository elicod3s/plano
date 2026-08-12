import type { Extension } from '@codemirror/state'
import { LanguageDescription } from '@codemirror/language'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { html } from '@codemirror/lang-html'
import { css } from '@codemirror/lang-css'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'

/** Languages a fenced ``` block inside markdown can highlight with (```ts, ```py, …). */
const fencedLanguages: LanguageDescription[] = [
  LanguageDescription.of({
    name: 'javascript',
    alias: ['js', 'jsx', 'mjs', 'cjs'],
    load: async () => javascript({ jsx: true }),
  }),
  LanguageDescription.of({
    name: 'typescript',
    alias: ['ts', 'tsx'],
    load: async () => javascript({ typescript: true, jsx: true }),
  }),
  LanguageDescription.of({ name: 'json', load: async () => json() }),
  LanguageDescription.of({ name: 'html', alias: ['htm'], load: async () => html() }),
  LanguageDescription.of({ name: 'css', alias: ['scss', 'less'], load: async () => css() }),
  LanguageDescription.of({ name: 'python', alias: ['py'], load: async () => python() }),
]

/** True when the path / explicit language id is a markdown document. */
export function isMarkdownFile(filePath?: string, language?: string): boolean {
  const ext = (language || filePath?.split('.').pop() || '').toLowerCase()
  return ext === 'md' || ext === 'markdown' || ext === 'mdx'
}

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
    case 'mdx':
      // GFM base (tables, task lists, strikethrough, autolinks) + syntax-highlighted fenced code.
      return markdown({ base: markdownLanguage, codeLanguages: fencedLanguages })
    case 'py':
      return python()
    default:
      return null
  }
}
