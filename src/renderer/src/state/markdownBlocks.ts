/**
 * Pure block parser for the minimal Summary-tab Markdown renderer. Kept in its
 * own module (no React) so it stays unit-testable and so the component file can
 * export only its component (react-refresh). See `components/MarkdownLite.tsx`
 * for the rendering half.
 *
 * Recognised blocks: `#`/`##`/`###` headings (→ h2/h3/h4), `- `/`* ` bullet
 * lists, `1. ` ordered lists, and paragraphs (blank line = break). Inline
 * `**bold**` is handled at render time.
 */
export type MarkdownBlock =
  | { kind: 'h'; level: 2 | 3 | 4; text: string }
  | { kind: 'ul'; items: string[] }
  | { kind: 'ol'; items: string[] }
  | { kind: 'p'; lines: string[] }

/** Parse summary Markdown into a flat list of blocks. Pure — unit-testable. */
export function parseMarkdownBlocks(md: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = []
  let para: string[] = []

  const flushPara = (): void => {
    if (para.length > 0) {
      blocks.push({ kind: 'p', lines: para })
      para = []
    }
  }

  for (const rawLine of md.split('\n')) {
    const line = rawLine.replace(/\s+$/, '')
    if (line.trim() === '') {
      flushPara()
      continue
    }
    const heading = line.match(/^(#{1,3})[ \t]+(.+)$/)
    if (heading) {
      flushPara()
      const level = (heading[1].length + 1) as 2 | 3 | 4
      blocks.push({ kind: 'h', level, text: heading[2].trim() })
      continue
    }
    const bullet = line.match(/^[ \t]*[-*][ \t]+(.+)$/)
    if (bullet) {
      flushPara()
      const last = blocks[blocks.length - 1]
      if (last && last.kind === 'ul') last.items.push(bullet[1])
      else blocks.push({ kind: 'ul', items: [bullet[1]] })
      continue
    }
    const ordered = line.match(/^[ \t]*\d+\.[ \t]+(.+)$/)
    if (ordered) {
      flushPara()
      const last = blocks[blocks.length - 1]
      if (last && last.kind === 'ol') last.items.push(ordered[1])
      else blocks.push({ kind: 'ol', items: [ordered[1]] })
      continue
    }
    para.push(line.trim())
  }
  flushPara()
  return blocks
}
