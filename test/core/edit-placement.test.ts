import { describe, expect, test } from 'vitest'

import { applyTextEdits, createMinimalTextEdit, outsideBmpSafeEdits } from '../../src/core/diff.js'
import { chooseEdits, createRangeLayout, editsTouch, placeEdits } from '../../src/core/edit-placement.js'

function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    return state / 2 ** 32
  }
}

const PIECES = ['a', 'b', 'ab', 'the', 'cat', 'cot', ' ', '  ', '\n', ',', '.', 'é', '\u{1F600}']

function text(next: () => number, pieces: number): string {
  let result = ''
  for (let index = 0; index < pieces; index += 1) result += PIECES[Math.floor(next() * PIECES.length)]
  return result
}

/** Whether `offset` would split a surrogate pair. */
function splitsPair(value: string, offset: number): boolean {
  const code = value.charCodeAt(offset)
  return code >= 0xdc00 && code <= 0xdfff
}

describe('edit placement around ranges', () => {
  test('an edit touches a range it overlaps, or reaches an end of, at either end', () => {
    const layout = createRangeLayout([10], [{ start: 3, end: 6 }])
    const touched = (position: number, deleteText: string, insertText: string): boolean =>
      editsTouch([{ position, deleteText, insertText }], layout)
    // The span [3, 6): an insertion at either end, a deletion reaching either end, one inside.
    expect([touched(3, '', 'x'), touched(6, '', 'x'), touched(1, 'ab', ''), touched(6, 'ab', '')]).toEqual([
      true,
      true,
      true,
      true,
    ])
    expect(touched(4, '', 'x')).toBe(true)
    // The tracked deletion's point 10: an insertion at it, a deletion ending or starting at it.
    expect([touched(10, '', 'x'), touched(8, 'ab', ''), touched(10, 'ab', '')]).toEqual([true, true, true])
    // Clear of both.
    expect([touched(1, 'a', 'b'), touched(7, 'ab', 'x'), touched(12, '', 'x')]).toEqual([false, false, false])
  })

  test('a range with no visible length is still touched at its point', () => {
    const layout = createRangeLayout([], [{ start: 4, end: 4 }])
    expect(editsTouch([{ position: 4, deleteText: '', insertText: 'x' }], layout)).toBe(true)
    expect(editsTouch([{ position: 5, deleteText: '', insertText: 'x' }], layout)).toBe(false)
  })

  test('a pure insertion moves along equal text off a range boundary', () => {
    const before = 'One two three four.\n'
    const layout = createRangeLayout([], [{ start: 14, end: 18 }])
    // " " inserted after the space at 13 lands at the range's start; one place earlier it is clear.
    expect(placeEdits(before, [{ position: 14, deleteText: '', insertText: ' ' }], layout)).toEqual([
      { position: 13, deleteText: '', insertText: ' ' },
    ])
  })

  test('a deletion moves along repeated text off a tracked deletion, but never past another edit', () => {
    const layout = createRangeLayout([4], [])
    // Deleting the space at 3 reaches the point at 4; the spaces at 1 and 2 are the same text.
    expect(placeEdits('a   b', [{ position: 3, deleteText: ' ', insertText: '' }], layout)).toEqual([
      { position: 2, deleteText: ' ', insertText: '' },
    ])
    // When an edit ends at 3, the deletion cannot move and stays touching.
    const edits = [
      { position: 0, deleteText: 'x  ', insertText: 'y  ' },
      { position: 3, deleteText: ' ', insertText: '' },
    ]
    expect(placeEdits('x   b', edits, layout)).toEqual(edits)
  })

  test('ranges given out of order are sorted', () => {
    const layout = createRangeLayout(
      [9, 3],
      [
        { start: 6, end: 8 },
        { start: 1, end: 2 },
      ]
    )
    expect(layout.deletions).toEqual([3, 9])
    expect(layout.spans).toEqual([
      { start: 1, end: 2 },
      { start: 6, end: 8 },
    ])
  })

  test('the chosen edits produce the target and are either the span or clear of every range', () => {
    for (let seed = 1; seed <= 400; seed += 1) {
      const next = random(seed)
      const before = text(next, 1 + Math.floor(next() * 14))
      let after = before
      for (let change = 0; change < 1 + Math.floor(next() * 3); change += 1) {
        let at = Math.floor(next() * (after.length + 1))
        if (splitsPair(after, at)) at += 1
        let end = Math.min(after.length, at + Math.floor(next() * 4))
        if (splitsPair(after, end)) end += 1
        after = after.slice(0, at) + text(next, Math.floor(next() * 3)) + after.slice(end)
      }
      const point = (): number => {
        const at = Math.floor(next() * (before.length + 1))
        return splitsPair(before, at) ? at + 1 : at
      }
      const deletions = Array.from({ length: Math.floor(next() * 3) }, point)
      const spans = Array.from({ length: Math.floor(next() * 4) }, () => {
        const start = point()
        return { start, end: Math.min(before.length, start + Math.floor(next() * 5)) }
      })
      {
        const layout = createRangeLayout(deletions, spans)
        const chosen = chooseEdits(before, after, layout)
        const context = JSON.stringify({ seed, before, after, deletions, spans })
        expect(applyTextEdits(before, chosen), context).toBe(after)
        // The span as every write sent it, split around a character outside the BMP.
        const span = before === after ? [] : outsideBmpSafeEdits(before, after, [createMinimalTextEdit(before, after)!])
        if (JSON.stringify(chosen) !== JSON.stringify(span)) {
          expect(editsTouch(chosen, layout), context).toBe(false)
        }
      }
    }
  })
})
