import { describe, expect, test } from 'vitest'

import { assertDocumentSize, assertUpdateSize } from '../../src/core/limits.js'

describe('preflight size limits', () => {
  test('rejects content at the configured document limit', () => {
    expect(() => assertDocumentSize('1234', 4)).toThrowError(expect.objectContaining({ code: 'DOC_TOO_LARGE' }))
    expect(() => assertDocumentSize('123', 4)).not.toThrow()
  })

  test('measures the exact serialized update string length', () => {
    const update = { v: 1, op: [{ p: 0, i: 'hello' }] }
    const exact = JSON.stringify(update).length

    expect(() => assertUpdateSize(update, exact)).not.toThrow()
    expect(() => assertUpdateSize(update, exact - 1)).toThrowError(
      expect.objectContaining({ code: 'UPDATE_TOO_LARGE' })
    )
  })
})
