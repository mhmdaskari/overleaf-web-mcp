import { describe, expect, test } from 'vitest'

import {
  applyTextEdit,
  applyTextEdits,
  createGranularEdits,
  createMinimalTextEdit,
  createOutsideBmpPreservingEdits,
  granularEditPlans,
  MAX_TOKEN_WALK,
  outsideBmpSafeEdits,
  preserveOutsideBmp,
} from '../../src/core/diff.js'

const applyInOrder = applyTextEdits

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
    expect(createOutsideBmpPreservingEdits('x\n\u{1F600}\u{1F601}', 'x\n\u{1F601}\u{1F600}')).toEqual({ insertedAt: 4 })
  })
})

describe('granular edits', () => {
  test('one edit per changed group of words, never part of a word', () => {
    expect(createGranularEdits('Alpha beta.\n', 'Alpha, new, beta.\n')).toEqual([
      { position: 5, deleteText: '', insertText: ', new,' },
    ])
    expect(createGranularEdits('Old wording here.\n', 'New wording here.\n')).toEqual([
      { position: 0, deleteText: 'Old', insertText: 'New' },
    ])
    expect(createGranularEdits('Un résumé naïf.\n', 'Un aperçu naïf.\n')).toEqual([
      { position: 3, deleteText: 'résumé', insertText: 'aperçu' },
    ])
    expect(createGranularEdits('colour\n', 'color\n')).toEqual([
      { position: 0, deleteText: 'colour', insertText: 'color' },
    ])
  })

  test('separated words are separate edits, each counted after the previous ones', () => {
    const before = 'The quick brown fox jumps over the dog.\n'
    const after = 'The slow brown fox leaps over the lazy dog.\n'
    const edits = createGranularEdits(before, after)
    expect(edits).toEqual([
      { position: 4, deleteText: 'quick', insertText: 'slow' },
      { position: 19, deleteText: 'jumps', insertText: 'leaps' },
      { position: 33, deleteText: '', insertText: ' lazy' },
    ])
    expect(applyTextEdits(before, edits)).toBe(after)
  })

  test('edits one horizontal space apart merge into one, and a chain of them too', () => {
    expect(createGranularEdits('a b c d\n', 'x y z d\n')).toEqual([
      { position: 0, deleteText: 'a b c', insertText: 'x y z' },
    ])
    // Two spaces are one token, so they still join; a newline or a word between keeps edits apart.
    expect(createGranularEdits('a  b\n', 'x  y\n')).toEqual([{ position: 0, deleteText: 'a  b', insertText: 'x  y' }])
    expect(createGranularEdits('a\nb\n', 'x\ny\n')).toHaveLength(2)
    expect(createGranularEdits('a b c\n', 'x b z\n')).toHaveLength(2)
  })

  test('edits on separate lines stay separate, and lines added or removed are whole', () => {
    const before = 'first line\nsecond line\nthird line\n'
    const after = 'first row\nsecond line\nthird line\nfourth line\n'
    const edits = createGranularEdits(before, after)
    expect(edits).toEqual([
      { position: 6, deleteText: 'line', insertText: 'row' },
      { position: 33, deleteText: '', insertText: 'fourth line\n' },
    ])
    expect(applyTextEdits(before, edits)).toBe(after)
    expect(createGranularEdits('a\nb\nc', 'a\nc')).toEqual([{ position: 2, deleteText: 'b\n', insertText: '' }])
  })

  test('no edit for unchanged text, and whole-text edits from and to empty', () => {
    expect(createGranularEdits('same\n', 'same\n')).toEqual([])
    expect(createGranularEdits('', 'new\n')).toEqual([{ position: 0, deleteText: '', insertText: 'new\n' }])
    expect(createGranularEdits('old\n', '')).toEqual([{ position: 0, deleteText: 'old\n', insertText: '' }])
  })

  test('a character outside the BMP is one token, never split', () => {
    const edits = createGranularEdits('A \u{1F600} B\n', 'A \u{1F60E} B\n')
    expect(edits).toEqual([{ position: 2, deleteText: '\u{1F600}', insertText: '\u{1F60E}' }])
  })

  test('granularity hunks gives one edit per changed run of lines, and span one edit', () => {
    const before = 'one two three\nkept\nfour five six\n'
    const after = 'one 2 three\nkept\nfour 5 six\n'
    expect(createGranularEdits(before, after)).toHaveLength(2)
    const hunks = createGranularEdits('one two three four\n', 'one 2 three 4\n', { granularity: 'hunks' })
    expect(hunks).toEqual([{ position: 4, deleteText: 'two three four', insertText: '2 three 4' }])
    expect(createGranularEdits('a two b\nkept\nc six d\n', 'a 2 b\nkept\nc 6 d\n', { granularity: 'hunks' })).toEqual([
      { position: 2, deleteText: 'two', insertText: '2' },
      { position: 13, deleteText: 'six', insertText: '6' },
    ])
    expect(createGranularEdits(before, after, { granularity: 'span' })).toEqual([createMinimalTextEdit(before, after)])
  })

  test('a line search past its edit distance limit falls back to one span', () => {
    const before = 'a x\nkept\nb x\nkept\nc x\n'
    const after = 'a y\nkept\nb y\nkept\nc y\n'
    expect(createGranularEdits(before, after)).toHaveLength(3)
    // Three changed lines are an edit distance of six.
    expect(createGranularEdits(before, after, { maxLineDistance: 6 })).toHaveLength(3)
    expect(createGranularEdits(before, after, { maxLineDistance: 5 })).toEqual([createMinimalTextEdit(before, after)])
  })

  test('a word search past its limit leaves only that run of lines one span', () => {
    const before = 'keep a b c d\nkept\nalpha one\n'
    const after = 'keep w b x d\nkept\nalpha two\n'
    expect(createGranularEdits(before, after)).toHaveLength(3)
    // The first run needs a word edit distance of four, the second two.
    expect(createGranularEdits(before, after, { maxTokenDistance: 3 })).toEqual([
      { position: 5, deleteText: 'a b c', insertText: 'w b x' },
      { position: 24, deleteText: 'one', insertText: 'two' },
    ])
  })

  test('a diff past its work budget falls back to one span', () => {
    const before = 'a x\nkept\nb x\n'
    const after = 'a y\nkept\nb y\n'
    expect(createGranularEdits(before, after, { workBudget: 0 })).toEqual([createMinimalTextEdit(before, after)])
  })

  test('a word longer than the walk to its start leaves its run of lines one span', () => {
    const word = '\u0436'.repeat(MAX_TOKEN_WALK + 10)
    const before = `kept\n${word}a${word}\nkept\n`
    const after = `kept\n${word}b${word}\nkept\n`
    expect(createGranularEdits(before, after)).toEqual([createMinimalTextEdit(before, after)])
    const short = '\u0436'.repeat(10)
    expect(createGranularEdits(`${short}a${short}\n`, `${short}b${short}\n`)).toEqual([
      { position: 0, deleteText: `${short}a${short}`, insertText: `${short}b${short}` },
    ])
  })

  test('the walk limit holds for each end of a word on its own', () => {
    // 600 steps back to the word's start and 600 on to its end: each under the limit, so the
    // whole word is one edit although the two together pass it.
    const before = `${'x'.repeat(600)}a${'y'.repeat(600)}\n`
    const after = `${'x'.repeat(600)}b${'y'.repeat(600)}\n`
    expect(600 * 2).toBeGreaterThan(MAX_TOKEN_WALK)
    expect(createGranularEdits(before, after)).toEqual([
      { position: 0, deleteText: before.slice(0, -1), insertText: after.slice(0, -1) },
    ])
  })

  test('the walk back to the start of a word is charged to the work budget', () => {
    // The word search alone fits either budget; with its 900 steps back charged it does not, so
    // the run of lines falls back to its minimal edit rather than replacing the whole word.
    const before = `${'x'.repeat(900)}a\n`
    const after = `${'x'.repeat(900)}b\n`
    expect(createGranularEdits(before, after)).toEqual([
      { position: 0, deleteText: before.slice(0, -1), insertText: after.slice(0, -1) },
    ])
    for (const workBudget of [100_000, 130_000]) {
      expect(createGranularEdits(before, after, { workBudget })).toEqual([
        { position: 900, deleteText: 'a', insertText: 'b' },
      ])
    }
  })

  test('one line search gives the word, line, and span plans, finest first', () => {
    const before = 'a two b\nkept\nc six d\n'
    const after = 'a 2 b\nkept\nc 6 d\n'
    expect([...granularEditPlans(before, after)]).toEqual([
      createGranularEdits(before, after),
      createGranularEdits(before, after, { granularity: 'hunks' }),
      [createMinimalTextEdit(before, after)],
    ])
    // A line search that gives up gives the span alone, and no change gives no edits.
    expect([...granularEditPlans(before, after, { maxLineDistance: 1 })]).toEqual([
      [createMinimalTextEdit(before, after)],
    ])
    expect([...granularEditPlans(before, before)]).toEqual([[]])
  })

  test('falls back on a large document quickly', () => {
    const lines = Array.from({ length: 50_000 }, (_, index) => `line ${index} of the document\n`)
    const before = lines.join('')
    const after = lines.map(line => line.replace('line', 'row')).join('')
    const started = performance.now()
    expect(createGranularEdits(before, after)).toHaveLength(1)
    expect(performance.now() - started).toBeLessThan(2_000)
  })

  test('folding the edits over the text gives the target, for random text with astral characters', () => {
    // A seeded generator, so a failure is reproducible.
    let seed = 0x2f6b_1d3a
    const random = (limit: number): number => {
      seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0
      return seed % limit
    }
    const pieces = ['a', 'b', 'word', 'mot', 'é', 'é', ' ', '  ', '\t', '\n', '\n', '.', ',', '\\', '{', '}', '_', '7']
    const astral = ['\u{1F600}', '\u{1F601}', '\u{1D400}', '\u{20000}']
    const text = (length: number): string =>
      Array.from({ length }, () =>
        random(8) === 0 ? astral[random(astral.length)]! : pieces[random(pieces.length)]!
      ).join('')
    const mutate = (source: string): string => {
      const characters = [...source]
      for (let count = random(6); count >= 0; count -= 1) {
        const at = random(characters.length + 1)
        const removed = random(4)
        characters.splice(at, removed, ...[...text(random(5))])
      }
      return characters.join('')
    }
    const outsideBmpHalf = /[\uD800-\uDFFF]/u
    for (let round = 0; round < 1_500; round += 1) {
      const before = text(random(60))
      const after = random(10) === 0 ? text(random(60)) : mutate(before)
      for (const options of [
        {},
        { granularity: 'hunks' as const },
        { granularity: 'span' as const },
        { maxLineDistance: 2 },
        { maxTokenDistance: 1 },
        { workBudget: 3_000 },
      ]) {
        const edits = createGranularEdits(before, after, options)
        expect(applyTextEdits(before, edits), JSON.stringify({ before, after, options })).toBe(after)
        for (const edit of edits) {
          expect(edit.deleteText !== '' || edit.insertText !== '').toBe(true)
          // No edit starts or ends inside a surrogate pair: its text is whole code points.
          expect(outsideBmpHalf.test(edit.deleteText + edit.insertText)).toBe(false)
        }
      }
      const kept = preserveOutsideBmp(createGranularEdits(before, after))
      if (kept !== undefined) expect(applyTextEdits(before, kept)).toBe(after)
    }
  })
})

describe('granular edits around characters outside the BMP', () => {
  const outsideBmp = /[\u{10000}-\u{10FFFF}\uD800-\uDFFF]/u

  test('an edit that would send one again is split around it', () => {
    const edits = [{ position: 0, deleteText: 'a \u{1F600} b', insertText: 'x \u{1F600} y' }]
    const kept = preserveOutsideBmp(edits)
    expect(kept).toEqual([
      { position: 0, deleteText: 'a', insertText: 'x' },
      { position: 5, deleteText: 'b', insertText: 'y' },
    ])
    expect(applyTextEdits('a \u{1F600} b', kept!)).toBe('x \u{1F600} y')
  })

  test('is undefined when an edit inserts one it does not delete', () => {
    const edits = createGranularEdits('\u{1F600} x', 'x \u{1F600}')
    expect(edits.some(edit => outsideBmp.test(edit.insertText))).toBe(true)
    expect(preserveOutsideBmp(edits)).toBeUndefined()
  })
})

describe('edits planned for Overleaf', () => {
  test('outsideBmpSafeEdits splits the edits, or plans the whole change when they cannot be split', () => {
    const before = 'a \u{1F600} b\n'
    const after = 'x \u{1F600} y\n'
    expect(outsideBmpSafeEdits(before, after, [createMinimalTextEdit(before, after)!])).toEqual([
      { position: 0, deleteText: 'a', insertText: 'x' },
      { position: 5, deleteText: 'b', insertText: 'y' },
    ])
    const moved = createGranularEdits('\u{1F600} x', 'x \u{1F600}')
    expect(outsideBmpSafeEdits('\u{1F600} x', 'x \u{1F600}', moved)).toEqual([
      { position: 0, deleteText: '', insertText: 'x ' },
      { position: 4, deleteText: ' x', insertText: '' },
    ])
    // A character the target adds has to be sent: the one minimal edit, as before.
    expect(outsideBmpSafeEdits('a', 'a \u{1F600}', createGranularEdits('a', 'a \u{1F600}'))).toEqual([
      createMinimalTextEdit('a', 'a \u{1F600}'),
    ])
  })
})
