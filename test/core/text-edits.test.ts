import { describe, expect, test } from 'vitest'

import { McpError } from '../../src/core/errors.js'
import { applyTextEdits } from '../../src/core/text-edits.js'

function failure(work: () => unknown): McpError {
  try {
    work()
  } catch (error) {
    expect(error).toBeInstanceOf(McpError)
    return error as McpError
  }
  throw new Error('expected a failure')
}

describe('applyTextEdits', () => {
  test('applies each edit in order to the text the ones before it left', () => {
    expect(
      applyTextEdits('one two three', [
        { oldText: 'two', newText: '2' },
        { oldText: 'one 2', newText: 'one-two' },
        { oldText: ' three', newText: '' },
      ])
    ).toBe('one-two')
  })

  test('matches exactly: case, whitespace, and line endings count', () => {
    expect(failure(() => applyTextEdits('Line\n', [{ oldText: 'line', newText: 'x' }])).details).toEqual({
      kind: 'edit_not_found',
      editIndex: 0,
    })
    expect(failure(() => applyTextEdits('Line\n', [{ oldText: 'Line\r\n', newText: 'x' }])).details).toEqual({
      kind: 'edit_not_found',
      editIndex: 0,
    })
    expect(applyTextEdits('a  b', [{ oldText: 'a  b', newText: 'a b' }])).toBe('a b')
  })

  test('counts overlapping occurrences as ambiguous', () => {
    expect(failure(() => applyTextEdits('aaa', [{ oldText: 'aa', newText: 'b' }])).details).toEqual({
      kind: 'edit_ambiguous',
      editIndex: 0,
    })
  })

  test('names the failing edit by its 0-based index', () => {
    const error = failure(() =>
      applyTextEdits('x y', [
        { oldText: 'x', newText: 'z' },
        { oldText: 'x', newText: 'w' },
      ])
    )
    expect(error.code).toBe('INVALID_ARGUMENT')
    expect(error.details).toEqual({ kind: 'edit_not_found', editIndex: 1 })
  })

  test('refuses an empty oldText, and deletes with an empty newText', () => {
    expect(failure(() => applyTextEdits('x', [{ oldText: '', newText: 'y' }])).details).toEqual({ editIndex: 0 })
    expect(applyTextEdits('keep drop', [{ oldText: ' drop', newText: '' }])).toBe('keep')
  })
})
