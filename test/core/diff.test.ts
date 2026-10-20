import { describe, expect, test } from 'vitest'

import {
  applyTextEdit,
  createMinimalTextEdit,
  createOutsideBmpPreservingEdits,
  type TextEdit,
} from '../../src/core/diff.js'

function applyInOrder(content: string, edits: TextEdit[]): string {
  return edits.reduce((result, edit) => applyTextEdit(result, edit), content)
}

describe('minimal text diff', () => {
  test('returns no edit when content is unchanged', () => {
    expect(createMinimalTextEdit('same', 'same')).toBeNull()
  })

  test('preserves the common prefix and suffix', () => {
    const edit = createMinimalTextEdit('alpha middle omega', 'alpha revised omega')

    expect(edit).toEqual({ position: 6, deleteText: 'middle', insertText: 'revised' })
    expect(applyTextEdit('alpha middle omega', edit)).toBe('alpha revised omega')
  })

  test('does not split surrogate pairs', () => {
    const before = 'A😀B'
    const edit = createMinimalTextEdit(before, 'A😎B')
    if (!edit) throw new Error('expected a text edit')

    expect(applyTextEdit(before, edit)).toBe('A😎B')
    expect(edit.position).toBe(1)
    expect(edit.deleteText).toBe('😀')
  })
})

describe('edits that keep characters outside the BMP in place', () => {
  const outsideBmp = /[\u{10000}-\u{10FFFF}\uD800-\uDFFF]/u

  test('is the minimal edit when no such character is inserted', () => {
    expect(createOutsideBmpPreservingEdits('alpha old omega', 'alpha new omega')).toEqual({
      edits: [{ position: 6, deleteText: 'old', insertText: 'new' }],
    })
    expect(createOutsideBmpPreservingEdits('same', 'same')).toEqual({ edits: [] })
  })

  test('edits each side of an unchanged character instead of sending it again', () => {
    const before = 'Intro \u{1F600} text old.'
    const after = 'Intro2 \u{1F600} text new.'
    const plan = createOutsideBmpPreservingEdits(before, after)
    if (!('edits' in plan)) throw new Error('expected edits')

    expect(plan.edits).toEqual([
      { position: 5, deleteText: '', insertText: '2' },
      { position: 15, deleteText: 'old', insertText: 'new' },
    ])
    expect(applyInOrder(before, plan.edits)).toBe(after)
  })

  test('counts each position in the text the previous edits left', () => {
    const before = 'a \u{1F600} b \u{1F601} c'
    const after = 'a longer \u{1F600} \u{1F601} c changed'
    const plan = createOutsideBmpPreservingEdits(before, after)
    if (!('edits' in plan)) throw new Error('expected edits')

    expect(plan.edits.length).toBeGreaterThan(1)
    expect(plan.edits.some(edit => outsideBmp.test(edit.insertText))).toBe(false)
    expect(applyInOrder(before, plan.edits)).toBe(after)
  })

  test('deletes one such character while keeping another the edit spans', () => {
    const before = 'x \u{1F600} y \u{1F601} z'
    const after = 'x2 y \u{1F601} z2'
    const plan = createOutsideBmpPreservingEdits(before, after)
    if (!('edits' in plan)) throw new Error('expected edits')

    expect(plan.edits.some(edit => outsideBmp.test(edit.insertText))).toBe(false)
    expect(applyInOrder(before, plan.edits)).toBe(after)
  })

  test('reports the offset of a character the text adds', () => {
    expect(createOutsideBmpPreservingEdits('old', 'old \u{1F600}')).toEqual({ insertedAt: 4 })
    expect(createOutsideBmpPreservingEdits('old', 'old \uD83D')).toEqual({ insertedAt: 4 })
  })

  test('reports a new copy, not the existing character the edit spans', () => {
    const before = 'a \u{1F600} b'
    const after = 'a2 \u{1F600} b\n\u{1F600}'
    expect(createOutsideBmpPreservingEdits(before, after)).toEqual({ insertedAt: after.length - 2 })
  })

  test('reports a reorder, which sends a character again', () => {
    expect(
      createOutsideBmpPreservingEdits('x\n\u{1F600}\u{1F601}', 'x\n\u{1F601}\u{1F600}')
    ).toEqual({ insertedAt: 4 })
  })
})
