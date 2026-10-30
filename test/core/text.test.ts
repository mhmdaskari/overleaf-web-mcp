import { describe, expect, test } from 'vitest'

import { lineColumnToOffset, normalizeLf, offsetToLineColumn } from '../../src/core/text.js'

describe('text normalization and positions', () => {
  test('normalizes CRLF and lone CR to LF', () => {
    expect(normalizeLf('one\r\ntwo\rthree\n')).toBe('one\ntwo\nthree\n')
  })

  test('uses one-based UTF-16 columns for astral characters', () => {
    const content = 'a😀b\nnext'

    expect(lineColumnToOffset(content, { line: 1, column: 4 })).toBe(3)
    expect(offsetToLineColumn(content, 3)).toEqual({ line: 1, column: 4 })
  })

  test('rejects columns that split a surrogate pair', () => {
    expect(() => lineColumnToOffset('a😀b', { line: 1, column: 3 })).toThrow(/surrogate pair/i)
  })
})
