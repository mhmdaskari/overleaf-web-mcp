import { McpError } from './errors.js'

const SECTION_LEVELS = new Map([
  ['part', 0],
  ['chapter', 1],
  ['section', 2],
  ['subsection', 3],
  ['subsubsection', 4],
  ['paragraph', 5],
  ['subparagraph', 6],
])

const IGNORED_ENVIRONMENTS = new Set([
  'verbatim',
  'verbatim*',
  'lstlisting',
  'minted',
  'comment',
])

export interface LatexSection {
  id: string
  index: number
  command: string
  level: number
  starred: boolean
  title: string
  shortTitle?: string
  start: number
  headingEnd: number
  bodyStart: number
  end: number
}

function skipWhitespace(source: string, index: number): number {
  while (/\s/u.test(source[index] ?? '')) index += 1
  return index
}

function readBalanced(
  source: string,
  index: number,
  open: '[' | '{',
  close: ']' | '}'
): { value: string; end: number } | null {
  if (source[index] !== open) return null
  let depth = 1
  let cursor = index + 1
  while (cursor < source.length) {
    const char = source[cursor]
    if (char === '\\') {
      cursor += 2
      continue
    }
    if (char === open) depth += 1
    if (char === close) depth -= 1
    if (depth === 0) return { value: source.slice(index + 1, cursor), end: cursor + 1 }
    cursor += 1
  }
  return null
}

function isEscaped(source: string, index: number): boolean {
  // `\\` is a complete control symbol, so only an odd run of backslashes escapes the next char.
  let backslashes = 0
  while (source[index - 1 - backslashes] === '\\') backslashes += 1
  return backslashes % 2 === 1
}

function maskIgnored(source: string): string {
  // Spaces preserve every source offset; newlines preserve line structure for returned ranges.
  const chars = [...source]
  let lineComment = false
  const environmentStack: string[] = []

  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '\n') {
      lineComment = false
      continue
    }
    if (lineComment) {
      chars[index] = ' '
      continue
    }
    if (source[index] === '%' && !isEscaped(source, index)) {
      lineComment = true
      chars[index] = ' '
      continue
    }

    const tail = source.slice(index)
    const begin = /^\\begin\{([^}]+)\}/u.exec(tail)
    const end = /^\\end\{([^}]+)\}/u.exec(tail)
    if (begin && IGNORED_ENVIRONMENTS.has(begin[1] ?? '')) {
      environmentStack.push(begin[1]!)
    }

    if (environmentStack.length > 0) {
      const length = (begin?.[0] ?? end?.[0] ?? source[index] ?? '').length
      for (let offset = 0; offset < Math.max(length, 1); offset += 1) {
        if (chars[index + offset] !== '\n') chars[index + offset] = ' '
      }
      if (end && end[1] === environmentStack.at(-1)) environmentStack.pop()
      index += Math.max(length - 1, 0)
    }
  }
  return chars.join('')
}

export function findSections(input: string): LatexSection[] {
  const source = input.replace(/\r\n?|\n/g, '\n')
  const masked = maskIgnored(source)
  const candidates: Omit<LatexSection, 'index' | 'id' | 'end'>[] = []
  const commandPattern = /\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)(\*)?/gu

  for (const match of masked.matchAll(commandPattern)) {
    const command = match[1]!
    const start = match.index
    let cursor = start + match[0].length
    cursor = skipWhitespace(masked, cursor)
    let shortTitle: string | undefined
    const optional = readBalanced(masked, cursor, '[', ']')
    if (optional) {
      shortTitle = source.slice(cursor + 1, optional.end - 1)
      cursor = skipWhitespace(masked, optional.end)
    }
    const titleRange = readBalanced(masked, cursor, '{', '}')
    if (!titleRange) continue
    const title = source.slice(cursor + 1, titleRange.end - 1)
    const headingEnd = titleRange.end
    const bodyStart = source[headingEnd] === '\n' ? headingEnd + 1 : headingEnd
    candidates.push({
      command,
      level: SECTION_LEVELS.get(command)!,
      starred: match[2] === '*',
      title,
      ...(shortTitle === undefined ? {} : { shortTitle }),
      start,
      headingEnd,
      bodyStart,
    })
  }

  return candidates.map((candidate, index) => {
    const next = candidates.slice(index + 1).find(item => item.level <= candidate.level)
    return {
      ...candidate,
      id: `${candidate.command}:${candidate.start}`,
      index,
      end: next?.start ?? source.length,
    }
  })
}

export function replaceSection(
  source: string,
  selector: string | number,
  replacement: string
): string {
  const sections = findSections(source)
  const section =
    typeof selector === 'number'
      ? sections[selector]
      : sections.find(candidate => candidate.id === selector)
  if (!section) throw new McpError('NOT_FOUND', `Section ${String(selector)} was not found.`)

  const start = typeof selector === 'number' ? section.start : section.bodyStart
  return source.slice(0, start) + replacement + source.slice(section.end)
}
