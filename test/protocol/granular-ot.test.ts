import { describe, expect, test } from 'vitest'

import { createGranularEdits, type TextEdit } from '../../src/core/diff.js'
import {
  buildHistoryTextOperation,
  buildShareJsOperation,
  historyVisibleContent,
  type HistoryTrackingContext,
} from '../../src/protocol/ot.js'
import {
  applyTextOperation,
  snapshotOf,
  visibleText,
  type ServerDocument,
  type TextComponent,
} from '../helpers/fake-overleaf.js'
import { applyShareJs } from '../helpers/overleaf-socket.js'

// The operations a granular write sends: several components, one per changed group of words,
// for ShareJS and for history-OT, where tracked deletions stay in the raw snapshot.

const TRACKING: HistoryTrackingContext = { userId: 'user', timestamp: '2026-01-01T00:00:00.000Z' }
const outsideBmp = /[\u{10000}-\u{10FFFF}\uD800-\uDFFF]/u

/** The text every insertion of a history-OT operation sends, tracked or not. */
function insertions(operation: Array<Record<string, unknown>>): string[] {
  return operation.flatMap(step =>
    (step.textOperation as TextComponent[]).flatMap(component =>
      typeof component === 'string'
        ? [component]
        : typeof component === 'object' && 'i' in component
          ? [component.i]
          : []
    )
  )
}

/** A history-OT document whose `[`…`]` spans are tracked deletions; the brackets are not content. */
function historyDocument(marked: string): ServerDocument {
  let content = ''
  const marks: ServerDocument['marks'] = []
  let deleting = false
  for (const character of marked) {
    if (character === '[' || character === ']') {
      deleting = character === '['
      continue
    }
    content += character
    for (let unit = 0; unit < character.length; unit += 1) marks.push(deleting ? 'delete' : undefined)
  }
  return { protocol: 'history-ot', version: 1, content, marks }
}

/** Builds the operation for `target`, applies it as the fake Overleaf would, and returns it. */
function historyWrite(marked: string, target: string, tracking?: HistoryTrackingContext, edits?: TextEdit[]) {
  const document = historyDocument(marked)
  const operation = buildHistoryTextOperation(snapshotOf(document), target, tracking, edits)
  for (const step of operation) applyTextOperation(document, step.textOperation as TextComponent[])
  return { operation, document }
}

const inserted = (text: string) => ({ i: text, tracking: { type: 'insert', userId: 'user', ts: TRACKING.timestamp } })
const deleted = (length: number) => ({
  r: length,
  tracking: { type: 'delete', userId: 'user', ts: TRACKING.timestamp },
})

describe('ShareJS operations with several edits', () => {
  test('one deletion and one insertion per changed word, each at a position the previous ones left', () => {
    const before = 'The quick brown fox jumps.\n'
    const after = 'The slow brown fox leaps.\n'
    const op = buildShareJsOperation(before, after)
    expect(op).toEqual([
      { p: 4, d: 'quick' },
      { p: 4, i: 'slow' },
      { p: 19, d: 'jumps' },
      { p: 19, i: 'leaps' },
    ])
    expect(applyShareJs(before, op)).toBe(after)
  })

  test('takes the edits it is given', () => {
    const before = 'one two\nkept\nthree four\n'
    const after = 'one 2\nkept\nthree 4\n'
    expect(buildShareJsOperation(before, after, createGranularEdits(before, after, { granularity: 'span' }))).toEqual([
      { p: 4, d: 'two\nkept\nthree four' },
      { p: 4, i: '2\nkept\nthree 4' },
    ])
    expect(buildShareJsOperation(before, after, [])).toEqual([])
  })

  test('splits an edit around a character outside the BMP it would only send again', () => {
    const before = 'a \u{1F600} b\n'
    const after = 'x \u{1F600} y\n'
    const op = buildShareJsOperation(before, after, createGranularEdits(before, after, { granularity: 'hunks' }))
    expect(op).toEqual([
      { p: 0, d: 'a' },
      { p: 0, i: 'x' },
      { p: 5, d: 'b' },
      { p: 5, i: 'y' },
    ])
    expect(applyShareJs(before, op)).toBe(after)
  })

  test('falls back to the whole-document plan when the edits pair such characters differently', () => {
    const before = '\u{1F600} x'
    const after = 'x \u{1F600}'
    // The word diff keeps "x" and would delete the emoji in one edit and send it again in another.
    expect(createGranularEdits(before, after).some(edit => outsideBmp.test(edit.insertText))).toBe(true)
    const op = buildShareJsOperation(before, after)
    expect(op).toEqual([
      { p: 0, i: 'x ' },
      { p: 4, d: ' x' },
    ])
    expect(op.some(component => outsideBmp.test(component.i ?? ''))).toBe(false)
    expect(applyShareJs(before, op)).toBe(after)
  })
})

describe('history-OT operations with several edits', () => {
  test('retains a tracked deletion between two edits', () => {
    const marked = 'one two [GONE ]three four\n'
    const target = 'one 2 three 4\n'
    const untracked = historyWrite(marked, target)
    expect(untracked.operation).toEqual([{ textOperation: [4, '2', -3, 12, '4', -4, 1] }])
    expect(visibleText(untracked.document)).toBe(target)
    expect(untracked.document.content).toBe('one 2 GONE three 4\n')

    const tracked = historyWrite(marked, target, TRACKING)
    expect(tracked.operation).toEqual([
      { textOperation: [4, inserted('2'), deleted(3), 12, inserted('4'), deleted(4), 1] },
    ])
    expect(visibleText(tracked.document)).toBe(target)
  })

  test('takes in a tracked deletion inside a deleted span that every character of it changes', () => {
    const marked = 'alpha be[GONE]ta gamma\n'
    const target = 'alpha xyz gamma\n'
    const untracked = historyWrite(marked, target)
    expect(untracked.operation).toEqual([{ textOperation: [6, 'xyz', -8, 7] }])
    expect(untracked.document.content).toBe(target)

    const tracked = historyWrite(marked, target, TRACKING)
    expect(tracked.operation).toEqual([{ textOperation: [6, inserted('xyz'), deleted(8), 7] }])
    expect(visibleText(tracked.document)).toBe(target)
    expect(tracked.document.content).toBe('alpha xyzbeGONEta gamma\n')
  })

  test('cuts a word edit down to the characters that differ around a tracked deletion inside it', () => {
    const marked = 'alpha be[GONE]ta gamma\n'
    const target = 'alpha delta gamma\n'
    const untracked = historyWrite(marked, target)
    expect(untracked.operation).toEqual([{ textOperation: [6, 'del', -2, 13] }])
    expect(untracked.document.content).toBe('alpha delGONEta gamma\n')
    expect(visibleText(untracked.document)).toBe(target)

    const tracked = historyWrite(marked, target, TRACKING)
    expect(tracked.operation).toEqual([{ textOperation: [6, inserted('del'), deleted(2), 13] }])
    expect(visibleText(tracked.document)).toBe(target)
    expect(tracked.document.content).toBe('alpha delbeGONEta gamma\n')

    // Another author's deletion of the "u" of "colour" stays where it was.
    const colour = historyWrite('The colo[u]r is red.\n', 'The colors is red.\n')
    expect(colour.operation).toEqual([{ textOperation: [10, 's', 9] }])
    expect(colour.document.content).toBe('The colours is red.\n')
    expect(visibleText(colour.document)).toBe('The colors is red.\n')
  })

  // These send the word edits as given: planned around the tracked deletions they touch, a write
  // would send the single span instead.
  const wordEdits = (marked: string, target: string) =>
    createGranularEdits(visibleText(historyDocument(marked)), target)

  test('retains a tracked deletion at the end of a deleted span and takes in one at its start', () => {
    const atEnd = historyWrite(
      'alpha beta[GONE] gamma\n',
      'alpha delta gamma\n',
      undefined,
      wordEdits('alpha beta[GONE] gamma\n', 'alpha delta gamma\n')
    )
    expect(atEnd.operation).toEqual([{ textOperation: [6, 'delta', -4, 11] }])
    expect(atEnd.document.content).toBe('alpha deltaGONE gamma\n')
    expect(visibleText(atEnd.document)).toBe('alpha delta gamma\n')

    const atStart = historyWrite(
      'alpha [GONE]beta gamma\n',
      'alpha delta gamma\n',
      undefined,
      wordEdits('alpha [GONE]beta gamma\n', 'alpha delta gamma\n')
    )
    // As every write always mapped it, the edit starts before a tracked deletion at its start.
    expect(atStart.operation).toEqual([{ textOperation: [6, 'delta', -8, 7] }])
    expect(atStart.document.content).toBe('alpha delta gamma\n')
    expect(visibleText(atStart.document)).toBe('alpha delta gamma\n')

    // A deleted word and its space, then an edit to the next word, which starts at that deletion
    // and so takes it in. Planned edits never start at one; this one is given directly.
    const next = historyWrite('foo [bar ]baz\n', 'foo bat\n', TRACKING, wordEdits('foo [bar ]baz\n', 'foo bat\n'))
    expect(next.operation).toEqual([{ textOperation: [4, inserted('bat'), deleted(7), 1] }])
    expect(next.document.content).toBe('foo batbar baz\n')
    expect(visibleText(next.document)).toBe('foo bat\n')
  })

  test('inserts before a tracked deletion at the insertion point', () => {
    const { operation, document } = historyWrite('alpha [GONE ]gamma\n', 'alpha beta gamma\n', TRACKING, [
      { position: 6, deleteText: '', insertText: 'beta ' },
    ])
    expect(operation).toEqual([{ textOperation: [6, inserted('beta '), 11] }])
    expect(document.content).toBe('alpha beta GONE gamma\n')
    expect(visibleText(document)).toBe('alpha beta gamma\n')
  })

  test('maps every edit across several tracked deletions, with characters outside the BMP', () => {
    const marked = '\u{1F600} un [x]deux [yy]trois\nquatre [z]cinq \u{1F601}\n'
    const target = '\u{1F600} one deux three\nquatre five \u{1F601}\n'
    for (const tracking of [undefined, TRACKING]) {
      const { operation, document } = historyWrite(marked, target, tracking, wordEdits(marked, target))
      expect(visibleText(document)).toBe(target)
      expect((operation[0]!.textOperation as unknown[]).length).toBeGreaterThan(6)
      expect(insertions(operation).some(text => outsideBmp.test(text))).toBe(false)
    }
  })

  test('never sends again a character outside the BMP that a changed word holds', () => {
    for (const [before, after] of [
      ['Let \u{1D465} be \u{1D465}\u{1D466}z.\n', 'Let \u{1D465} be \u{1D465}\u{1D466}w.\n'],
      [
        '\u{20BB7}\u91CE\u5BB6\u306E\u725B\u4E3C\u3067\u3059\u3002\n',
        '\u{20BB7}\u91CE\u5BB6\u306E\u8C5A\u4E3C\u3067\u3059\u3002\n',
      ],
    ]) {
      // The word diff alone would delete the whole word and insert it again.
      expect(createGranularEdits(before!, after!).some(edit => outsideBmp.test(edit.insertText))).toBe(true)
      for (const tracking of [undefined, TRACKING]) {
        const { operation, document } = historyWrite(before!, after!, tracking)
        expect(visibleText(document)).toBe(after)
        expect(insertions(operation).some(text => outsideBmp.test(text))).toBe(false)
      }
    }
  })

  test('joins adjacent retains and adjacent removals', () => {
    const { operation, document } = historyWrite('abcdef\n', 'af\n', undefined, [
      { position: 1, deleteText: 'b', insertText: '' },
      { position: 1, deleteText: 'cd', insertText: '' },
      { position: 1, deleteText: 'e', insertText: '' },
    ])
    expect(operation).toEqual([{ textOperation: [1, -4, 2] }])
    expect(document.content).toBe('af\n')
  })

  test('folds to the target for random edits over random tracked deletions', () => {
    let seed = 0x51ed_c0de
    const random = (limit: number): number => {
      seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0
      return seed % limit
    }
    const pieces = ['a', 'bc', 'word', ' ', '\n', '.', '\u{1F600}', 'é']
    const text = (length: number) => Array.from({ length }, () => pieces[random(pieces.length)]!).join('')
    for (let round = 0; round < 300; round += 1) {
      let marked = ''
      for (let part = random(6); part >= 0; part -= 1)
        marked += random(3) === 0 ? `[${text(1 + random(3))}]` : text(random(6))
      const visibleBefore = historyVisibleContent(snapshotOf(historyDocument(marked)))
      const characters = [...visibleBefore]
      for (let count = random(4); count >= 0; count -= 1) {
        characters.splice(random(characters.length + 1), random(3), ...[...text(random(4))])
      }
      const target = characters.join('')
      for (const tracking of [undefined, TRACKING]) {
        const { document } = historyWrite(marked, target, tracking)
        expect(visibleText(document), JSON.stringify({ marked, target })).toBe(target)
      }
    }
  })
})
