import { Fragment } from 'react'

const URL_RE = /(?:https?:\/\/|www\.)[^\s<>"'`]+/gi
const TRAILING_PUNCTUATION_RE = /[),.;:!?]+$/

interface TextPart {
  text: string
  url?: string
}

function splitLinkedText(text: string): TextPart[] {
  const parts: TextPart[] = []
  let cursor = 0

  for (const match of text.matchAll(URL_RE)) {
    const start = match.index ?? 0
    if (start > cursor) parts.push({ text: text.slice(cursor, start) })
    const raw = match[0]
    const trailing = raw.match(TRAILING_PUNCTUATION_RE)?.[0] ?? ''
    const link = trailing ? raw.slice(0, -trailing.length) : raw
    parts.push({ text: link, url: link.startsWith('www.') ? `https://${link}` : link })
    if (trailing) parts.push({ text: trailing })
    cursor = start + raw.length
  }

  if (cursor < text.length) parts.push({ text: text.slice(cursor) })
  return parts
}

/** Render links inline and open them in the OS default browser through the guarded shell IPC. */
export function LinkedText({ text, className }: { text: string; className?: string }) {
  return (
    <span className={className}>
      {splitLinkedText(text).map((part, index) =>
        part.url ? (
          <a
            key={`${part.url}-${index}`}
            href={part.url}
            target="_blank"
            rel="noreferrer noopener"
            className="app-no-drag break-all font-medium text-accent underline decoration-current/40 underline-offset-[3px] transition-colors hover:text-accent-hover hover:decoration-current focus-caliper"
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              void window.plano.shell.openExternal(part.url!)
            }}
          >
            {part.text}
          </a>
        ) : (
          <Fragment key={index}>{part.text}</Fragment>
        ),
      )}
    </span>
  )
}
