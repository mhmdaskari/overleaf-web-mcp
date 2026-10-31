import { describe, expect, test } from 'vitest'

import { applyTextEdits } from '../../src/core/diff.js'
import { planEdits } from '../../src/overleaf/documents.js'
import { buildHistoryTextOperation, historyVisibleContent, type HistorySnapshot } from '../../src/protocol/ot.js'
import type { JoinedDocument } from '../../src/protocol/project-connection.js'

// Word edits are sent only when none of them touches a comment or a tracked change. An edit that
// would is first cut down to the characters that differ, then moved along equal text, to find a
// place clear of every range; if one still touches a range, the write is the single span, as
// every write was sent before.

function shareJs(content: string, ranges: unknown): JoinedDocument {
  return { docId: 'd1', protocol: 'sharejs', version: 1, content, ranges, rawSnapshot: '' }
}

function historyOt(snapshot: HistorySnapshot): JoinedDocument {
  return {
    docId: 'd1',
    protocol: 'history-ot',
    version: 1,
    content: historyVisibleContent(snapshot),
    ranges: undefined,
    rawSnapshot: snapshot,
  }
}

const comment = (p: number, c: string) => ({ id: 'thread', op: { p, c, t: 'thread' } })

const CASES = [
  {
    name: 'a comment on the misspelt word',
    before: 'We recieve it.\n',
    after: 'We receive it.\n',
    range: { pos: 3, length: 7 },
    edits: [{ position: 6, deleteText: 'ie', insertText: 'ei' }],
  },
  {
    name: 'a comment that starts at the changed word',
    before: 'The cat sat.\n',
    after: 'The cot sat.\n',
    range: { pos: 4, length: 7 },
    edits: [{ position: 5, deleteText: 'a', insertText: 'o' }],
  },
  {
    name: 'a comment that starts inside the changed word',
    before: 'The cat sat.\n',
    after: 'The cot sat.\n',
    range: { pos: 6, length: 5 },
    edits: [{ position: 5, deleteText: 'a', insertText: 'o' }],
  },
  {
    name: 'a comment around the changed word, with room on each side',
    before: 'We recieve it.\n',
    after: 'We receive it.\n',
    range: { pos: 2, length: 9 },
    edits: [{ position: 6, deleteText: 'ie', insertText: 'ei' }],
  },
  {
    name: 'a comment over the whole sentence',
    before: 'The colour is red.\n',
    after: 'The color is red.\n',
    range: { pos: 0, length: 17 },
    edits: [{ position: 8, deleteText: 'u', insertText: '' }],
  },
  {
    name: 'a comment that the changed space starts',
    before: 'One two three four.\n',
    after: 'Uno two three  four.\n',
    range: { pos: 13, length: 5 },
    // The space would go in at the comment's start, and no equal text lets it move off: one span.
    edits: [{ position: 0, deleteText: 'One two three', insertText: 'Uno two three ' }],
  },
] as const

describe('planned edits around comments', () => {
  for (const { name, before, after, range, edits } of CASES) {
    for (const tracked of [undefined, { userId: 'user' }]) {
      const mode = tracked === undefined ? 'untracked' : 'tracked'
      test(`a ShareJS ${mode} write keeps ${name}`, () => {
        const document = shareJs(before, {
          comments: [comment(range.pos, before.slice(range.pos, range.pos + range.length))],
        })
        expect(planEdits(document, before, after, tracked)).toEqual(edits)
      })

      test(`a history-OT ${mode} write keeps ${name}`, () => {
        const document = historyOt({ content: before, comments: [{ id: 'thread', ranges: [range] }] })
        expect(planEdits(document, before, after, tracked)).toEqual(edits)
      })
    }
  }

  test('without a range there, the whole word is replaced', () => {
    const before = 'We recieve it.\n'
    const after = 'We receive it.\n'
    expect(planEdits(shareJs(before, {}), before, after, undefined)).toEqual([
      { position: 3, deleteText: 'recieve', insertText: 'receive' },
    ])
  })

  test('a history-OT comment is placed in the visible text, past a tracked deletion before it', () => {
    // "very old stuff " is tracked as deleted, so the comment on "recieve" starts at 18 in the
    // snapshot and 3 in the visible text, and a comment read at 18 would lie past the edit.
    const snapshot: HistorySnapshot = {
      content: 'We very old stuff recieve it.\n',
      comments: [{ id: 'thread', ranges: [{ pos: 18, length: 7 }] }],
      trackedChanges: [
        {
          range: { pos: 3, length: 15 },
          tracking: { type: 'delete', userId: 'other', ts: '2026-01-01T00:00:00.000Z' },
        },
      ],
    }
    const target = 'We receive it.\n'
    const edits = planEdits(historyOt(snapshot), historyVisibleContent(snapshot), target, undefined)
    expect(edits).toEqual([{ position: 6, deleteText: 'ie', insertText: 'ei' }])
    expect(applyTextEdits(historyVisibleContent(snapshot), edits)).toBe(target)
    // The operation builder places the edit the same way when it plans the edits itself.
    expect(buildHistoryTextOperation(snapshot, target)).toEqual([{ textOperation: [21, 'ei', -2, 7] }])
  })

  test('comments listed out of order are each found', () => {
    // Overleaf lists a comment added later after the others, wherever it sits.
    const before = 'We recieve it. The cat sat.\n'
    const after = 'We receive it. The cat sat.\n'
    const edits = [{ position: 6, deleteText: 'ie', insertText: 'ei' }]
    const document = shareJs(before, { comments: [comment(19, 'cat'), comment(23, 'sat'), comment(3, 'recieve')] })
    expect(planEdits(document, before, after, undefined)).toEqual(edits)
    const snapshot: HistorySnapshot = {
      content: before,
      comments: [
        { id: 'later', ranges: [{ pos: 19, length: 3 }] },
        { id: 'latest', ranges: [{ pos: 23, length: 3 }] },
        { id: 'thread', ranges: [{ pos: 3, length: 7 }] },
      ],
    }
    expect(planEdits(historyOt(snapshot), before, after, undefined)).toEqual(edits)
    expect(buildHistoryTextOperation(snapshot, after)).toEqual([{ textOperation: [6, 'ei', -2, 20] }])
  })

  test('another tracked insertion at the edge of a changed word keeps the edit to what differs', () => {
    const before = 'The cat sat.\n'
    const after = 'The cats sat.\n'
    const document = shareJs(before, {
      changes: [
        { id: 'theirs', op: { p: 4, i: 'cat' }, metadata: { user_id: 'other', ts: '2026-01-01T00:00:00.000Z' } },
      ],
    })
    expect(planEdits(document, before, after, { userId: 'user' })).toEqual([
      { position: 7, deleteText: '', insertText: 's' },
    ])
  })
})

const theirs = (op: { p: number; i?: string; d?: string }) => ({
  id: 'theirs',
  op,
  metadata: { user_id: 'other', ts: '2026-01-01T00:00:00.000Z' },
})

const MODES = [undefined, { userId: 'user' }] as const

describe("planned edits inside another author's tracked insertion", () => {
  for (const tracked of MODES) {
    const mode = tracked === undefined ? 'untracked' : 'tracked'

    test(`a ShareJS ${mode} write edits a word inside it only where its characters differ`, () => {
      // Replacing all of "colour" would cancel those characters of their suggestion and split it
      // around this write's text, where deleting "u" only shortens it.
      const before = 'We use the colour red.\n'
      const document = shareJs(before, { changes: [theirs({ p: 7, i: 'the colour red' })] })
      expect(planEdits(document, before, 'We use the color red.\n', tracked)).toEqual([
        { position: 15, deleteText: 'u', insertText: '' },
      ])
      const tests = 'Run the tests now.\n'
      const theirTests = shareJs(tests, { changes: [theirs({ p: 4, i: 'the tests now' })] })
      expect(planEdits(theirTests, tests, 'Run the Tests now.\n', tracked)).toEqual([
        { position: 8, deleteText: 't', insertText: 'T' },
      ])
    })

    test(`a history-OT ${mode} write edits a word inside it only where its characters differ`, () => {
      const snapshot: HistorySnapshot = {
        content: 'We use the colour red.\n',
        trackedChanges: [
          {
            range: { pos: 7, length: 14 },
            tracking: { type: 'insert', userId: 'other', ts: '2026-01-01T00:00:00.000Z' },
          },
        ],
      }
      expect(planEdits(historyOt(snapshot), snapshot.content, 'We use the color red.\n', tracked)).toEqual([
        { position: 15, deleteText: 'u', insertText: '' },
      ])
    })

    test(`a ShareJS ${mode} write inserting at the start of their insertion is one span`, () => {
      const before = 'One two three four.\n'
      const document = shareJs(before, { changes: [theirs({ p: 13, i: ' four' })] })
      expect(planEdits(document, before, 'Uno two three  four.\n', tracked)).toEqual([
        { position: 0, deleteText: 'One two three', insertText: 'Uno two three ' },
      ])
    })

    test(`a ShareJS ${mode} write deleting the space beside their insertion is one span`, () => {
      // Their insertion is the second space. Deleting either space reaches an end of it.
      const before = 'ab  '
      const document = shareJs(before, { changes: [theirs({ p: 3, i: ' ' })] })
      const edits = planEdits(document, before, 'abab ab ', tracked)
      expect(edits).toEqual([{ position: 2, deleteText: ' ', insertText: 'ab ab' }])
      expect(applyTextEdits(before, edits)).toBe('abab ab ')
    })
  }
})

describe("planned edits beside another author's tracked deletion", () => {
  test('a ShareJS deletion of one of two spaces takes the one away from their deletion', () => {
    // Overleaf folds a tracked deletion that a tracked delete reaches, at either end, into it and
    // makes it this author's. Their "final " sits after the second space, so the first goes.
    const before = 'Now the  results.\n'
    const document = shareJs(before, { changes: [theirs({ p: 9, d: 'final ' })] })
    for (const tracked of MODES) {
      expect(planEdits(document, before, 'the results.\n', tracked)).toEqual([
        { position: 0, deleteText: 'Now ', insertText: '' },
        { position: 3, deleteText: ' ', insertText: '' },
      ])
    }
    const trailing = '\n ab  '
    const atEnd = shareJs(trailing, { changes: [theirs({ p: 6, d: 'Q' })] })
    expect(planEdits(atEnd, trailing, 'ab ', { userId: 'user' })).toEqual([
      { position: 0, deleteText: '\n ', insertText: '' },
      { position: 2, deleteText: ' ', insertText: '' },
    ])
  })

  test('a history-OT deletion that only moves onto the end of their deletion is one span', () => {
    // Visible "ab beta . beta ba", their "et" tracked as deleted between "b" and "a". Deleting " ba"
    // would take it in, and "a b" before it, the only other place, ends at it.
    const snapshot: HistorySnapshot = {
      content: 'ab beta . beta beta \n{ the $ \n',
      trackedChanges: [
        {
          range: { pos: 16, length: 2 },
          tracking: { type: 'delete', userId: 'other', ts: '2026-01-01T00:00:00.000Z' },
        },
      ],
    }
    const target = 'beta .thebeta beta \n{ the $ \n'
    expect(buildHistoryTextOperation(snapshot, target)).toEqual([{ textOperation: ['beta .thebeta bet', -16, 14] }])
    const edits = planEdits(historyOt(snapshot), historyVisibleContent(snapshot), target, undefined)
    expect(applyTextEdits(historyVisibleContent(snapshot), edits)).toBe(target)
  })
})

describe('planned edits that no placement keeps off a range', () => {
  test('fall back to the single span when it does less to a comment', () => {
    // Word by word "cat" is deleted and sent again inside "tcat.", emptying the comment on "c";
    // the single span only inserts ".t" before it.
    const before = 'cat.a\u{1F600}'
    const after = '.tcat.a\u{1F600} '
    const document = shareJs(before, { comments: [comment(0, 'c')] })
    for (const tracked of MODES) {
      expect(planEdits(document, before, after, tracked)).toEqual([
        { position: 0, deleteText: '', insertText: '.t' },
        { position: 9, deleteText: '', insertText: ' ' },
      ])
    }
  })

  test('a history-OT comment on a trailing newline is one span when every deleted newline reaches it', () => {
    // Either newline deleted before the comment's ends at it, so the write is the single span.
    const snapshot: HistorySnapshot = {
      content: 'New  colours  \n( \ngamma \n\n',
      comments: [{ id: 'thread', ranges: [{ pos: 25, length: 1 }] }],
    }
    expect(buildHistoryTextOperation(snapshot, 'New  ab  alpha( \ngamma \n')).toEqual([
      { textOperation: [5, 'ab  alpha( \ngamma ', -20, 1] },
    ])
  })
})

describe('an untracked write changing words inside a tracked insertion', () => {
  // An untracked insertion strictly inside a tracked insertion splits it, which word edits never
  // do: whoever made the insertion, the write is the single span.
  const before = 'A the quick brown fox.\n'
  const after = 'A the slow brown cat.\n'

  for (const author of ['other', 'user']) {
    test(`is one span inside ${author === 'user' ? 'its own' : "another author's"} insertion`, () => {
      const insertion = {
        id: 'theirs',
        op: { p: 2, i: 'the quick brown fox' },
        metadata: { user_id: author, ts: '2026-01-01T00:00:00.000Z' },
      }
      expect(planEdits(shareJs(before, { changes: [insertion] }), before, after, undefined)).toEqual([
        { position: 6, deleteText: 'quick brown fox', insertText: 'slow brown cat' },
      ])
    })
  }
})

describe("planned edits inside another author's range", () => {
  const insertion = (pos: number, length: number) => ({
    range: { pos, length },
    tracking: { type: 'insert' as const, userId: 'other', ts: '2026-01-01T00:00:00.000Z' },
  })

  test('a history-OT untracked write loses no more of a comment than the span, which only splits it', () => {
    // Deleting " a" and sending it again around "aa" would cost the comment three characters; the
    // span costs it two, and its insertion only splits the comment on history-OT.
    const snapshot: HistorySnapshot = {
      content: ' aa a',
      comments: [{ id: 'thread', ranges: [{ pos: 0, length: 5 }] }],
    }
    expect(planEdits(historyOt(snapshot), snapshot.content, ' a aa', undefined)).toEqual([
      { position: 2, deleteText: 'a ', insertText: ' a' },
    ])
  })

  test("a history-OT tracked write deletes no more of another author's insertion than the span", () => {
    const snapshot: HistorySnapshot = { content: 'x a ab', trackedChanges: [insertion(0, 6)] }
    expect(planEdits(historyOt(snapshot), snapshot.content, 'x ab aab', { userId: 'user' })).toEqual([
      { position: 3, deleteText: ' ', insertText: 'b a' },
    ])
  })

  test("a history-OT tracked deletion inside another author's insertion is one span", () => {
    // Their insertion is "  a" after the first "a". Deleting either space touches it.
    const snapshot: HistorySnapshot = { content: 'a  a', trackedChanges: [insertion(1, 3)] }
    expect(planEdits(historyOt(snapshot), snapshot.content, ' a a', { userId: 'user' })).toEqual([
      { position: 0, deleteText: 'a ', insertText: ' a' },
    ])
  })
})

describe('an untracked ShareJS write to a document holding ranges Overleaf merges', () => {
  // After an untracked delete Overleaf merges tracked deletions that share a point, and touching
  // insertions by one author, across the whole document. Only a document converted from history-OT
  // holds them, and an untracked write to it sends the single span.
  const change = (id: string, op: { p: number; i?: string; d?: string }, user_id: string) => ({
    id,
    op,
    metadata: { user_id, ts: '2026-01-01T00:00:00.000Z' },
  })

  test('is the span when two tracked deletions share a point', () => {
    // "foo" to "food" word by word would delete "foo" and merge X and Y under X's author.
    const before = 'abc foo\n'
    const ranges = { changes: [change('x', { p: 0, d: 'X' }, 'a'), change('y', { p: 0, d: 'Y' }, 'b')] }
    expect(planEdits(shareJs(before, ranges), before, 'abc fob\n', undefined)).toEqual([
      { position: 6, deleteText: 'o', insertText: 'b' },
    ])
    expect(planEdits(shareJs(before, ranges), before, 'abc fob\n', { userId: 'user' })).toEqual([
      { position: 4, deleteText: 'foo', insertText: 'fob' },
    ])
  })

  test('is the span when two insertions by one author touch', () => {
    // The word edits stay clear of both insertions, but an untracked delete would merge them.
    const before = 'aaaa b and x\n'
    const after = 'aaaa c and y\n'
    const touching = { changes: [change('one', { p: 2, i: 'a' }, 'user'), change('two', { p: 3, i: 'a' }, 'user')] }
    expect(planEdits(shareJs(before, touching), before, after, undefined)).toEqual([
      { position: 5, deleteText: 'b and x', insertText: 'c and y' },
    ])
    // Touching insertions by different authors are not merged, so the words are edited.
    const apart = { changes: [change('one', { p: 2, i: 'a' }, 'user'), change('two', { p: 3, i: 'a' }, 'other')] }
    expect(planEdits(shareJs(before, apart), before, after, undefined)).toEqual([
      { position: 5, deleteText: 'b', insertText: 'c' },
      { position: 11, deleteText: 'x', insertText: 'y' },
    ])
  })

  test('sends the span when it takes in tracked deletions the words would reach', () => {
    const before = ' b '
    const ranges = {
      changes: [
        change('y', { p: 0, d: 'Y' }, 'other'),
        change('z', { p: 2, d: 'Z' }, 'user'),
        change('x', { p: 3, d: 'X' }, 'other'),
      ],
    }
    expect(planEdits(shareJs(before, ranges), before, 'b', undefined)).toEqual([
      { position: 0, deleteText: ' b ', insertText: 'b' },
    ])
  })
})
