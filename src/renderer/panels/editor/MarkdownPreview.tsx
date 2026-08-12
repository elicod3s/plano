import { memo, useMemo, useState, type ReactNode } from 'react'
import type { SyntaxNode } from '@lezer/common'
import { GFM, parser } from '@lezer/markdown'
import { Icon } from '@/design-system/Icon'
import './markdown-preview.css'

const gfmParser = parser.configure(GFM)
const MARKS = new Set(['HeaderMark', 'EmphasisMark', 'StrikethroughMark', 'CodeMark', 'LinkMark', 'TaskMarker'])
interface Props { source: string; filePath?: string }
interface Context { source: string; filePath?: string }

function children(node: SyntaxNode): SyntaxNode[] {
  const result: SyntaxNode[] = []
  for (let item = node.firstChild; item; item = item.nextSibling) result.push(item)
  return result
}
function child(node: SyntaxNode, name: string): SyntaxNode | undefined {
  return children(node).find((item) => item.name === name)
}
function inline(node: SyntaxNode, context: Context): ReactNode[] {
  const result: ReactNode[] = []
  let cursor = node.from
  for (const item of children(node)) {
    if (cursor < item.from) result.push(context.source.slice(cursor, item.from))
    if (!MARKS.has(item.name)) result.push(inlineNode(item, context))
    cursor = item.to
  }
  if (cursor < node.to) result.push(context.source.slice(cursor, node.to))
  return result
}
function Link({ href, content }: { href: string; content: ReactNode }) {
  const safe = /^(https?:|mailto:)/i.test(href.trim()) ? href.trim() : undefined
  return <a href={safe ?? '#'} title={href} onClick={(event) => {
    event.preventDefault()
    if (safe) void window.plano.shell.openExternal(safe)
  }}>{content}{safe && <Icon name='ArrowUpRight' size={11} aria-hidden />}</a>
}
function inlineNode(node: SyntaxNode, context: Context): ReactNode {
  const key = node.name + '-' + node.from
  if (node.name === 'StrongEmphasis') return <strong key={key}>{inline(node, context)}</strong>
  if (node.name === 'Emphasis') return <em key={key}>{inline(node, context)}</em>
  if (node.name === 'Strikethrough') return <del key={key}>{inline(node, context)}</del>
  if (node.name === 'InlineCode') return <code key={key}>{context.source.slice(node.from, node.to).replace(/^\x60+|\x60+$/g, '')}</code>
  if (node.name === 'Link' || node.name === 'Autolink') {
    const url = child(node, 'URL')
    const href = url ? context.source.slice(url.from, url.to) : ''
    return <Link key={key} href={href} content={node.name === 'Autolink' ? href : inline(node, context)} />
  }
  if (node.name === 'Image') {
    const url = child(node, 'URL')
    const src = url ? context.source.slice(url.from, url.to) : ''
    const alt = /^!\[([^\]]*)\]/.exec(context.source.slice(node.from, node.to))?.[1] ?? ''
    return <img key={key} src={src} alt={alt.replace(/[*_~]/g, '')} loading='lazy' />
  }
  if (node.name === 'Escape') return context.source.slice(node.from + 1, node.to)
  if (node.name === 'HardBreak') return <br key={key} />
  if (node.name === 'URL' || node.name === 'LinkTitle') return null
  if (node.name === 'HTMLTag') return <code key={key}>{context.source.slice(node.from, node.to)}</code>
  return node.firstChild ? <span key={key}>{inline(node, context)}</span> : context.source.slice(node.from, node.to)
}

const CODE_TOKEN = /(#.*$|\/\/.*$|\x22(?:\\.|[^\x22])*\x22|'(?:\\.|[^'])*'|\b(?:const|let|var|function|return|if|else|class|interface|type|import|from|export|async|await|def|npm|pnpm|yarn|git|node|python|docker|true|false|null|undefined)\b|\b\d+(?:\.\d+)?\b)/gim

/** Cells made only of numbers, dims, currency and punctuation — right-align as data. */
const NUMERIC_CELL = /^[\d.,%$€£¥\s\-–—+×]+$/

/** Closing-quote heuristic: the cell ends on a quoted phrase (with optional trailing note). */
const QUOTE_END = /["”“][^"”“]*["”“]$/

/** Inline tokens worth surfacing as chips: episode codes (S2E07/E10), timecodes (61:40-62:05),
 *  verified marks (✓). Alternation groups 1-3, scanned in one pass, never overlapping. */
const CELL_CHIP = /(\bS\d{1,2}E\d{1,2}(?:\s*\/\s*E?\d{1,2})*)|(\b\d{1,2}:\d{2}(?:[-–]\d{1,2}:\d{2})?\b\+?)|(✓)/g

/** Cells containing markdown syntax keep full inline parsing; chips only apply to plain text. */
const MARKDOWN_SYNTAX = /[*_`\[\]~]/

function chipify(raw: string, keyBase: string): ReactNode[] {
  const nodes: ReactNode[] = []
  let cursor = 0
  for (const match of raw.matchAll(CELL_CHIP)) {
    if (match.index > cursor) nodes.push(raw.slice(cursor, match.index))
    const className = match[1] ? 'md-chip ep' : match[2] ? 'md-chip time' : 'md-ok'
    nodes.push(<span key={keyBase + match.index} className={className}>{match[0]}</span>)
    cursor = match.index + match[0].length
  }
  if (cursor < raw.length) nodes.push(raw.slice(cursor))
  return nodes
}

function highlightedCode(code: string): ReactNode[] {
  const result: ReactNode[] = []
  let cursor = 0
  for (const match of code.matchAll(CODE_TOKEN)) {
    const index = match.index
    if (cursor < index) result.push(code.slice(cursor, index))
    const value = match[0]
    const className = /^(#|\/\/)/.test(value) ? 'md-token-comment'
      : /^(\x22|')/.test(value) ? 'md-token-string'
      : /^\d/.test(value) ? 'md-token-number'
      : /^(true|false|null|undefined)$/i.test(value) ? 'md-token-literal'
      : /^(npm|pnpm|yarn|git|node|python|docker)$/i.test(value) ? 'md-token-command'
      : 'md-token-keyword'
    result.push(<span key={index} className={className}>{value}</span>)
    cursor = index + value.length
  }
  if (cursor < code.length) result.push(code.slice(cursor))
  return result
}

function CodeBlock({ code, language = 'text' }: { code: string; language?: string }) {
  const [copied, setCopied] = useState(false)
  return <div className='md-code-block'>
    <div className='md-code-toolbar'>
      <span>{language || 'text'}</span>
      <button type='button' onClick={() => {
        void window.plano.clipboard.writeText(code)
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1400)
      }}>
        <Icon name={copied ? 'Check' : 'Copy'} size={13} />
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
    <pre><code>{highlightedCode(code)}</code></pre>
  </div>
}

function table(node: SyntaxNode, context: Context): ReactNode {
  const direct = children(node)
  const separator = direct.find((item) => item.name === 'TableDelimiter')
  const align: Array<'left' | 'center' | 'right'> = separator
    ? context.source.slice(separator.from, separator.to).trim()
        .replace(/^\|/, '').replace(/\|$/, '').split('|').map((part) => {
          const value = part.trim()
          return value.startsWith(':') && value.endsWith(':')
            ? 'center'
            : value.endsWith(':') ? 'right' : 'left'
        })
    : []
  const header = direct.find((item) => item.name === 'TableHeader')
  const rows = direct.filter((item) => item.name === 'TableRow')
  const cells = (row: SyntaxNode) =>
    children(row).filter((item) => item.name === 'TableCell')
  const cellText = (cell: SyntaxNode | undefined): string =>
    cell ? context.source.slice(cell.from, cell.to).trim() : ''
  const colCount = Math.max(
    header ? cells(header).length : 0,
    ...rows.map((row) => cells(row).length),
  )
  // Column-level intelligence, so every cell in a column is treated alike (organised look):
  // a column whose body is entirely numeric reads right-aligned data; a column where most
  // cells end on a quoted phrase reads as dialogue/scene lines and gets an accent rail.
  const bodyOf = (index: number): SyntaxNode[] =>
    rows.map((row) => cells(row)[index]).filter((c): c is SyntaxNode => Boolean(c))
  const numericCol = (index: number): boolean => {
    const body = bodyOf(index)
    return body.length > 0 && body.every((cell) => NUMERIC_CELL.test(cellText(cell)))
  }
  const quoteCol = (index: number): boolean => {
    const body = bodyOf(index)
    if (body.length === 0) return false
    const quoted = body.filter((cell) => QUOTE_END.test(cellText(cell))).length
    return quoted / body.length >= 0.5
  }
  const cellAlign = (index: number): 'left' | 'center' | 'right' =>
    align[index] ?? (numericCol(index) ? 'right' : 'left')
  // Plain-text cells get inline chips (episode codes, timecodes, ✓); cells with markdown
  // syntax (links, emphasis, code) keep the full inline renderer untouched.
  const renderCell = (cell: SyntaxNode): ReactNode => {
    const raw = cellText(cell)
    return MARKDOWN_SYNTAX.test(raw) ? inline(cell, context) : chipify(raw, 'c' + cell.from)
  }
  return <div className='md-table-wrap' key={node.from}><table>
    {header && <thead><tr>{cells(header).map((cell, index) =>
      <th key={cell.from} className={numericCol(index) ? 'num' : undefined}
        style={{ textAlign: cellAlign(index) }}>
        {inline(cell, context)}
      </th>,
    )}</tr></thead>}
    <tbody>{rows.map((row) => <tr key={row.from}>{cells(row).map((cell, index) => {
      const numeric = numericCol(index)
      const quote = quoteCol(index)
      const className = [numeric && 'num', quote && 'quote']
        .filter(Boolean).join(' ') || undefined
      return <td key={cell.from} className={className}
        style={{ textAlign: cellAlign(index) }}>
        {renderCell(cell)}
      </td>
    })}</tr>)}</tbody>
  </table>{rows.length > 0 &&
    <div className='md-table-meta'>{colCount} × {rows.length}</div>
  }</div>
}

function listItem(node: SyntaxNode, context: Context): ReactNode {
  const content = children(node)
    .filter((item) => item.name !== 'ListMark')
    .map((item) => {
      if (item.name !== 'Task') return block(item, context)
      const marker = child(item, 'TaskMarker')
      const checked = marker
        ? /\[[xX]\]/.test(context.source.slice(marker.from, marker.to))
        : false
      return <span className='md-task' key={item.from}>
        <span className={'md-checkbox' + (checked ? ' is-checked' : '')}>
          {checked && <Icon name='Check' size={11} />}
        </span>
        <span>{inline(item, context)}</span>
      </span>
    })
  return <li key={node.from}>{content}</li>
}

function heading(node: SyntaxNode, context: Context, level: number): ReactNode {
  const key = node.name + '-' + node.from
  const content = inline(node, context)
  if (level === 1) return <h1 key={key}>{content}</h1>
  if (level === 2) return <h2 key={key}>{content}</h2>
  if (level === 3) return <h3 key={key}>{content}</h3>
  if (level === 4) return <h4 key={key}>{content}</h4>
  if (level === 5) return <h5 key={key}>{content}</h5>
  return <h6 key={key}>{content}</h6>
}

function block(node: SyntaxNode, context: Context): ReactNode {
  const key = node.name + '-' + node.from
  const level = /Heading([1-6])$/.exec(node.name)
  if (level) return heading(node, context, Number(level[1]))
  if (node.name === 'Paragraph') return <p key={key}>{inline(node, context)}</p>
  if (node.name === 'Blockquote') {
    return <blockquote key={key}>
      {children(node)
        .filter((item) => item.name !== 'QuoteMark')
        .map((item) => block(item, context))}
    </blockquote>
  }
  if (node.name === 'BulletList') {
    return <ul key={key}>{children(node)
      .filter((item) => item.name === 'ListItem')
      .map((item) => listItem(item, context))}</ul>
  }
  if (node.name === 'OrderedList') {
    return <ol key={key}>{children(node)
      .filter((item) => item.name === 'ListItem')
      .map((item) => listItem(item, context))}</ol>
  }
  if (node.name === 'Table') return table(node, context)
  if (node.name === 'FencedCode') {
    const info = child(node, 'CodeInfo')
    const code = child(node, 'CodeText')
    return <CodeBlock
      key={key}
      language={info ? context.source.slice(info.from, info.to) : 'text'}
      code={code ? context.source.slice(code.from, code.to) : ''}
    />
  }
  if (node.name === 'CodeBlock') {
    const code = children(node)
      .filter((item) => item.name === 'CodeText')
      .map((item) => context.source.slice(item.from, item.to))
      .join('\n')
    return <CodeBlock key={key} code={code} />
  }
  if (node.name === 'HTMLBlock') {
    return <CodeBlock key={key} code={context.source.slice(node.from, node.to)} language='html' />
  }
  if (node.name === 'HorizontalRule') return <hr key={key} />
  if (node.name === 'LinkReference') return null
  return node.firstChild
    ? <div key={key}>{children(node).map((item) => block(item, context))}</div>
    : null
}

export const MarkdownPreview = memo(function MarkdownPreview({ source, filePath }: Props) {
  const rendered = useMemo(() => {
    // Windows files often carry CRLF endings; the GFM table extension treats the trailing
    // \r as cell content and refuses to recognize the delimiter row — the whole table
    // silently degrades to a plain paragraph. Normalize before parsing so tables render
    // (positions stay consistent: every slice reads from the same normalized source).
    const normalized = source.replace(/\r\n?/g, '\n')
    const context = { source: normalized, filePath }
    return children(gfmParser.parse(normalized).topNode).map((node) => block(node, context))
  }, [filePath, source])
  return <div className='md-preview-scroll' data-wheel-own>
    <article className='md-preview'>{rendered}</article>
  </div>
})
