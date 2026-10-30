import { McpError } from './errors.js'

export interface LineColumn {
  line: number
  column: number
}

export function normalizeLf(value: string): string {
  return value.replace(/\r\n?|\n/g, '\n')
}

function assertNotSplitSurrogate(text: string, offset: number): void {
  if (
    offset > 0 &&
    offset < text.length &&
    /[\uD800-\uDBFF]/u.test(text[offset - 1] ?? '') &&
    /[\uDC00-\uDFFF]/u.test(text[offset] ?? '')
  ) {
    throw new McpError('INVALID_ARGUMENT', 'The requested position splits a UTF-16 surrogate pair.')
  }
}

/** Converts 1-based browser-style UTF-16 positions to a normalized document offset. */
export function lineColumnToOffset(content: string, position: LineColumn): number {
  if (!Number.isInteger(position.line) || position.line < 1) {
    throw new McpError('INVALID_ARGUMENT', 'Line must be a positive integer.')
  }
  if (!Number.isInteger(position.column) || position.column < 1) {
    throw new McpError('INVALID_ARGUMENT', 'Column must be a positive integer.')
  }

  const normalized = normalizeLf(content)
  let lineStart = 0
  for (let line = 1; line < position.line; line += 1) {
    const newline = normalized.indexOf('\n', lineStart)
    if (newline < 0) {
      throw new McpError('INVALID_ARGUMENT', `Line ${position.line} does not exist.`)
    }
    lineStart = newline + 1
  }

  const lineEnd = normalized.indexOf('\n', lineStart)
  const actualLineEnd = lineEnd < 0 ? normalized.length : lineEnd
  const offset = lineStart + position.column - 1
  if (offset > actualLineEnd) {
    throw new McpError('INVALID_ARGUMENT', `Column ${position.column} is outside line ${position.line}.`)
  }
  assertNotSplitSurrogate(normalized, offset)
  return offset
}

/** Converts a normalized document offset to 1-based UTF-16 line and column values. */
export function offsetToLineColumn(content: string, offset: number): LineColumn {
  const normalized = normalizeLf(content)
  if (!Number.isInteger(offset) || offset < 0 || offset > normalized.length) {
    throw new McpError('INVALID_ARGUMENT', 'Offset is outside the document.')
  }
  assertNotSplitSurrogate(normalized, offset)

  let line = 1
  let lineStart = 0
  for (let index = 0; index < offset; index += 1) {
    if (normalized[index] === '\n') {
      line += 1
      lineStart = index + 1
    }
  }
  return { line, column: offset - lineStart + 1 }
}
