import type { ReactNode } from 'react'
import { parseMarkdownBlocks } from '../state/markdownBlocks'

/**
 * A deliberately minimal, safe Markdown renderer for the meeting Summary tab.
 *
 * Timbre pulls in NO Markdown dependency: the LLM protocol is trusted-but-local
 * text and we only need a handful of block/inline constructs. Everything is
 * built as React nodes — we NEVER use `dangerouslySetInnerHTML`, so injected
 * HTML in a summary can't execute; React escapes all text by construction.
 *
 * Supported:
 *   - `#` / `##` / `###` headings → real <h2>/<h3>/<h4> (so the tabpanel has a
 *     proper heading outline for screen readers)
 *   - `- ` / `* ` bullet lists → <ul>
 *   - `1. ` ordered lists → <ol>
 *   - `**bold**` inline emphasis
 *   - blank line → paragraph break; other lines fold into a <p>
 *
 * Anything not recognised renders as escaped paragraph text — never raw HTML.
 */

/** Split a line's `**bold**` spans into React nodes; all text stays escaped. */
function renderInline(text: string, keyBase: string): ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*)/g)
  return parts
    .filter((p) => p.length > 0)
    .map((part, i) => {
      const bold = part.match(/^\*\*([^*]+)\*\*$/)
      if (bold) {
        return <strong key={`${keyBase}-${i}`}>{bold[1]}</strong>
      }
      return <span key={`${keyBase}-${i}`}>{part}</span>
    })
}

export function MarkdownLite({ markdown }: { markdown: string }): JSX.Element {
  const blocks = parseMarkdownBlocks(markdown)
  return (
    <div className="markdown-lite">
      {blocks.map((block, i) => {
        const key = `b-${i}`
        if (block.kind === 'h') {
          const inner = renderInline(block.text, key)
          if (block.level === 2) return <h2 key={key}>{inner}</h2>
          if (block.level === 3) return <h3 key={key}>{inner}</h3>
          return <h4 key={key}>{inner}</h4>
        }
        if (block.kind === 'ul') {
          return (
            <ul key={key}>
              {block.items.map((it, j) => (
                <li key={`${key}-${j}`}>{renderInline(it, `${key}-${j}`)}</li>
              ))}
            </ul>
          )
        }
        if (block.kind === 'ol') {
          return (
            <ol key={key}>
              {block.items.map((it, j) => (
                <li key={`${key}-${j}`}>{renderInline(it, `${key}-${j}`)}</li>
              ))}
            </ol>
          )
        }
        return (
          <p key={key}>
            {block.lines.map((ln, j) => (
              <span key={`${key}-${j}`}>
                {j > 0 ? ' ' : ''}
                {renderInline(ln, `${key}-${j}`)}
              </span>
            ))}
          </p>
        )
      })}
    </div>
  )
}
