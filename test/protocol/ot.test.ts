import { describe, expect, test } from 'vitest'

import {
  buildCommentOperation,
  buildHistoryTextOperation,
  buildShareJsOperation,
  buildStatusOperation,
  historyVisibleContent,
  makeUpdate,
  visibleToSnapshotOffset,
} from '../../src/protocol/ot.js'

describe('OT operation adapters', () => {
  test('builds an untracked ShareJS replacement', () => {
    expect(buildShareJsOperation('alpha old omega', 'alpha new omega')).toEqual([
      { p: 6, d: 'old' },
      { p: 6, i: 'new' },
    ])
  })

  test('builds a ShareJS operation that edits around an unchanged character outside the BMP', () => {
    expect(buildShareJsOperation('a \u{1F600} old', 'b \u{1F600} new')).toEqual([
      { p: 0, d: 'a' },
      { p: 0, i: 'b' },
      { p: 5, d: 'old' },
      { p: 5, i: 'new' },
    ])
  })

  test('maps visible offsets across history-OT tracked deletes', () => {
    const snapshot = {
      content: 'abcDELETEdef',
      trackedChanges: [
        {
          range: { pos: 3, length: 6 },
          tracking: { type: 'delete' as const, userId: 'u', ts: 'now' },
        },
      ],
    }

    expect(historyVisibleContent(snapshot)).toBe('abcdef')
    expect(visibleToSnapshotOffset(snapshot, 3)).toBe(3)
    expect(visibleToSnapshotOffset(snapshot, 4)).toBe(10)
    expect(buildHistoryTextOperation(snapshot, 'abcXdef')).toEqual([
      { textOperation: [3, 'X', 9] },
    ])
  })

  test('builds tracked history-OT replacements with one author and timestamp', () => {
    expect(
      buildHistoryTextOperation(
        { content: 'alpha old omega' },
        'alpha new omega',
        { userId: 'user', timestamp: '2026-07-20T12:00:00.000Z' }
      )
    ).toEqual([
      {
        textOperation: [
          6,
          {
            i: 'new',
            tracking: {
              type: 'insert',
              userId: 'user',
              ts: '2026-07-20T12:00:00.000Z',
            },
          },
          {
            r: 3,
            tracking: {
              type: 'delete',
              userId: 'user',
              ts: '2026-07-20T12:00:00.000Z',
            },
          },
          6,
        ],
      },
    ])
  })

  test('tracks Unicode edits across deletions retained in a history-OT snapshot', () => {
    const snapshot = {
      content: '😀oldHIDDENz',
      trackedChanges: [
        {
          range: { pos: 5, length: 6 },
          tracking: { type: 'delete' as const, userId: 'prior', ts: 'then' },
        },
      ],
    }

    expect(
      buildHistoryTextOperation(snapshot, '😀newz', {
        userId: 'user',
        timestamp: '2026-07-20T12:00:00.000Z',
      })
    ).toEqual([
      {
        textOperation: [
          2,
          {
            i: 'new',
            tracking: {
              type: 'insert',
              userId: 'user',
              ts: '2026-07-20T12:00:00.000Z',
            },
          },
          {
            r: 3,
            tracking: {
              type: 'delete',
              userId: 'user',
              ts: '2026-07-20T12:00:00.000Z',
            },
          },
          7,
        ],
      },
    ])
  })

  test('builds protocol-specific comment and resolution operations', () => {
    expect(buildCommentOperation('sharejs', 'thread', 2, 4, 'text')).toEqual([
      { p: 2, c: 'text', t: 'thread' },
    ])
    expect(buildCommentOperation('history-ot', 'thread', 2, 4, 'text')).toEqual([
      { commentId: 'thread', ranges: [{ pos: 2, length: 2 }] },
    ])
    expect(buildStatusOperation('history-ot', 'thread', true)).toEqual([
      { commentId: 'thread', resolved: true },
    ])
  })

  test('keeps local write disclosure out of the server update envelope', () => {
    expect(makeUpdate('doc', 4, [{ p: 0, i: 'x' }], 'sharejs')).toEqual({
      doc: 'doc',
      v: 4,
      op: [{ p: 0, i: 'x' }],
    })
    expect(
      makeUpdate('doc', 4, [{ p: 0, i: 'x' }], 'sharejs', { tc: 'change-id' })
    ).toEqual({
      doc: 'doc',
      v: 4,
      op: [{ p: 0, i: 'x' }],
      meta: { tc: 'change-id' },
    })
  })
})
