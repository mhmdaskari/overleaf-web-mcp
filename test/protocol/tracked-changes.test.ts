import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'

import { describe, expect, test, vi } from 'vitest'

import { normalizeLf, offsetToLineColumn } from '../../src/core/text.js'
import { historyVisibleContent, type HistorySnapshot } from '../../src/protocol/ot.js'
import { ProjectConnection, type JoinedDocument } from '../../src/protocol/project-connection.js'
import { parseSocketPacket } from '../../src/protocol/socketio09-codec.js'
import {
  canonicalHistorySnapshot,
  createLocator,
  excerpt,
  expectedAfterDecision,
  missingChangeIds,
  overlappingChanges,
  parseHistoryOtChanges,
  parseShareJsChanges,
  planHistoryOtDecision,
  planShareJsReject,
  visibleEnd,
  type HistoryOtTrackedChange,
  type TrackedChange,
} from '../../src/protocol/tracked-changes.js'
import { applyShareJs } from '../helpers/overleaf-socket.js'

interface HistoryDecisionFixture {
  name: string
  action: 'accept' | 'reject'
  changes: number[]
  textOperation: unknown[]
  expectedSnapshot: HistorySnapshot
  expectedVisibleContent: string
}

interface HistoryFixture {
  joinDocAck: string
  rawLength: number
  visibleContent: string
  decisions: HistoryDecisionFixture[]
}

async function fixture<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(new URL(`../fixtures/protocol/${name}`, import.meta.url), 'utf8')) as T
}

function ackArgs(frame: string): unknown[] {
  const packet = parseSocketPacket(frame)
  if (packet.type !== 'ack') throw new Error('expected an ack frame')
  return packet.args
}

class FakePeer extends EventEmitter {
  readonly call = vi.fn()
  readonly close = vi.fn()
}

/** Joins the fixture's document through a real ProjectConnection, so the wire decoding is exercised. */
async function joinFixture(args: unknown[]): Promise<JoinedDocument> {
  const peer = new FakePeer()
  peer.call.mockResolvedValueOnce(args)
  const connection = new ProjectConnection({
    projectId: 'project',
    peer,
    join: {
      publicId: 'P.client',
      project: {
        _id: 'project',
        rootFolder: [{ _id: 'root', name: 'rootFolder', docs: [{ _id: 'DOC', name: 'main.tex' }] }],
      },
      permissionsLevel: 'owner',
      protocolVersion: 2,
    },
    supportedProtocolVersions: [2],
  })
  return await connection.joinDocument('DOC')
}

async function shareJsDocument(): Promise<{ document: JoinedDocument; args: unknown[] }> {
  const { joinDocAck } = await fixture<{ joinDocAck: string }>('sharejs-tracked-changes.json')
  const args = ackArgs(joinDocAck)
  return { document: await joinFixture(args), args }
}

async function historyDocument(): Promise<{
  document: JoinedDocument
  snapshot: HistorySnapshot
  fixture: HistoryFixture
}> {
  const history = await fixture<HistoryFixture>('history-ot-tracked-changes.json')
  const document = await joinFixture(ackArgs(history.joinDocAck))
  return { document, snapshot: document.rawSnapshot as HistorySnapshot, fixture: history }
}

const SHAREJS_CONTENT = 'Alpha beta INSERTED gamma.\nRemove now.\nReplace new here.\nNaïve café über text.\n'
const TS = '2026-01-01T00:00:00.000Z'

function ids(changes: readonly TrackedChange[]): string[] {
  return changes.map(change => change.changeId ?? '')
}

describe('ShareJS range decoding on join', () => {
  test('decodes change and comment text into a copy and leaves the frame as received', async () => {
    const { document, args } = await shareJsDocument()

    expect(document.content).toBe(SHAREJS_CONTENT)
    const ranges = document.ranges as {
      changes: Array<{ op: { i?: string; d?: string } }>
      comments: Array<{ op: { c: string; p: number; t: string }; id: string }>
    }
    expect(ranges.changes[4]?.op).toEqual({ p: 68, i: 'über ' })
    expect(ranges.comments[0]).toMatchObject({ id: 'thread-1', op: { c: 'Naïve café', p: 57, t: 'thread-1' } })
    const frame = args[4] as typeof ranges
    expect(frame.changes[4]?.op.i).toBe(Buffer.from('über ', 'utf8').toString('latin1'))
    expect(frame.comments[0]?.op.c).toBe(Buffer.from('Naïve café', 'utf8').toString('latin1'))
  })

  test('decodes astral range text and keeps positions in UTF-16 units after an astral character', async () => {
    const latin1 = (text: string): string => Buffer.from(text, 'utf8').toString('latin1')
    const metadata = { user_id: 'USER', ts: TS }
    const document = await joinFixture([
      null,
      ['Head', 'a😀 b😀c end', ''].map(latin1),
      3,
      [],
      {
        changes: [
          { id: 'astral-insert', op: { p: 9, i: latin1('b😀') }, metadata },
          { id: 'astral-delete', op: { p: 13, d: latin1('😀 ') }, metadata },
        ],
        comments: [{ id: 'thread-1', op: { c: latin1('😀 b'), p: 6, t: 'thread-1' }, metadata }],
      },
      'sharejs-text-ot',
      { canSkipLeaveDoc: true },
    ])

    expect(document.content).toBe('Head\na😀 b😀c end\n')
    const ranges = document.ranges as { comments: Array<{ op: { c: string; p: number } }> }
    expect(ranges.comments[0]?.op).toEqual({ c: '😀 b', p: 6, t: 'thread-1' })
    expect(document.content.slice(6, 10)).toBe('😀 b')

    const changes = parseShareJsChanges(document.ranges)
    expect(changes).toEqual([
      {
        changeId: 'astral-insert',
        type: 'insert',
        position: 9,
        length: 3,
        text: 'b😀',
        authorId: 'USER',
        timestamp: TS,
      },
      {
        changeId: 'astral-delete',
        type: 'delete',
        position: 13,
        length: 3,
        text: '😀 ',
        authorId: 'USER',
        timestamp: TS,
      },
    ])
    expect(document.content.slice(9, visibleEnd(changes[0]!))).toBe('b😀')

    const locate = createLocator(document.content)
    // On the second line, 'a' is column 1 and the emoji takes columns 2 and 3.
    expect(locate(9)).toEqual({ line: 2, column: 5 })
    expect(locate(12)).toEqual({ line: 2, column: 8 })
    expect(locate(13)).toEqual({ line: 2, column: 9 })
    for (const offset of [6, 9, 12, 13]) expect(locate(offset)).toEqual(offsetToLineColumn(document.content, offset))
  })

  test('passes history-ot ranges through untouched', async () => {
    const history = await fixture<HistoryFixture>('history-ot-tracked-changes.json')
    const args = ackArgs(history.joinDocAck)
    const document = await joinFixture(args)

    expect(document.protocol).toBe('history-ot')
    expect(document.ranges).toBe(args[4])
    expect(document.content).toBe(history.visibleContent)
  })
})

describe('parseShareJsChanges', () => {
  test('reads the live fixture in document order, with decoded text and the replacement paired', async () => {
    const { document } = await shareJsDocument()

    expect(parseShareJsChanges(document.ranges)).toEqual([
      {
        changeId: 'change-1',
        type: 'insert',
        position: 11,
        length: 9,
        text: 'INSERTED ',
        authorId: 'USER',
        timestamp: TS,
      },
      {
        changeId: 'change-2',
        type: 'delete',
        position: 33,
        length: 12,
        text: ' this phrase',
        authorId: 'USER',
        timestamp: TS,
      },
      {
        changeId: 'change-3',
        type: 'insert',
        position: 47,
        length: 3,
        text: 'new',
        authorId: 'USER',
        timestamp: TS,
        pairedChangeId: 'change-4',
      },
      {
        changeId: 'change-4',
        type: 'delete',
        position: 50,
        length: 3,
        text: 'old',
        authorId: 'USER',
        timestamp: TS,
        pairedChangeId: 'change-3',
      },
      { changeId: 'change-5', type: 'insert', position: 68, length: 5, text: 'über ', authorId: 'USER', timestamp: TS },
    ])
  })

  test('every inserted text sits at its position in the visible content', async () => {
    const { document } = await shareJsDocument()

    for (const change of parseShareJsChanges(document.ranges).filter(change => change.type === 'insert')) {
      expect(document.content.slice(change.position, visibleEnd(change))).toBe(change.text)
    }
  })

  test('tolerates a missing id, a null or anonymous author, unknown keys, and an unreadable timestamp', () => {
    const changes = parseShareJsChanges({
      changes: [
        { op: { p: 4, i: 'restored' }, metadata: { user_id: 'USER', ts: TS } },
        { id: 'a', op: { p: 0, i: 'x', u: true, fixedRemoveChange: true }, metadata: { user_id: null, ts: 'later' } },
        { id: 'b', op: { p: 1, d: 'y' }, metadata: { user_id: 'anonymous-user' } },
        { id: 'c', op: { i: 'no position' }, metadata: {} },
        { id: 'd', op: { p: 2 }, metadata: {} },
        { id: 'e', op: { p: 3, i: '' }, metadata: {} },
        'not an entry',
      ],
      comments: [{ id: 'thread', op: { p: 0, c: 'x', t: 'thread' } }],
    })

    expect(changes).toEqual([
      { changeId: 'a', type: 'insert', position: 0, length: 1, text: 'x', authorId: null },
      { changeId: 'b', type: 'delete', position: 1, length: 1, text: 'y', authorId: 'anonymous-user' },
      { type: 'insert', position: 4, length: 8, text: 'restored', authorId: 'USER', timestamp: TS },
    ])
  })

  test('reads no changes from empty, missing, or malformed ranges', () => {
    expect(parseShareJsChanges({})).toEqual([])
    expect(parseShareJsChanges(null)).toEqual([])
    expect(parseShareJsChanges({ changes: 'nope' })).toEqual([])
  })

  test('pairs only an insert followed by a delete of the same author, both with ids', () => {
    const changes = parseShareJsChanges({
      changes: [
        { id: 'i1', op: { p: 0, i: 'ab' }, metadata: { user_id: 'A' } },
        { id: 'd1', op: { p: 2, d: 'x' }, metadata: { user_id: 'B' } },
        { id: 'i2', op: { p: 5, i: 'cd' }, metadata: { user_id: 'A' } },
        { op: { p: 7, d: 'y' }, metadata: { user_id: 'A' } },
      ],
    })

    expect(changes.every(change => change.pairedChangeId === undefined)).toBe(true)
  })

  test('pairs a delete with one insert at most', () => {
    const changes = parseShareJsChanges({
      changes: [
        { id: 'first', op: { p: 0, i: 'abc' }, metadata: { user_id: 'A' } },
        { id: 'second', op: { p: 1, i: 'bc' }, metadata: { user_id: 'A' } },
        { id: 'deletion', op: { p: 3, d: 'x' }, metadata: { user_id: 'A' } },
      ],
    })
    const paired = Object.fromEntries(changes.map(change => [change.changeId, change.pairedChangeId]))

    expect(paired).toEqual({ first: 'deletion', second: undefined, deletion: 'first' })
  })
})

describe('parseHistoryOtChanges', () => {
  test('reads the source-derived fixture with visible positions, raw ranges, and synthesized ids', async () => {
    const { document, snapshot } = await historyDocument()
    const changes = parseHistoryOtChanges(snapshot, 'DOC')

    const withoutIds = changes.map(change => {
      const rest: Partial<HistoryOtTrackedChange> = { ...change }
      delete rest.changeId
      delete rest.pairedChangeId
      return rest
    })
    expect(withoutIds).toEqual([
      {
        type: 'insert',
        position: 11,
        length: 9,
        text: 'INSERTED ',
        authorId: 'USER',
        timestamp: TS,
        rawPos: 11,
        rawLength: 9,
      },
      {
        type: 'delete',
        position: 33,
        length: 12,
        text: ' this phrase',
        authorId: 'USER',
        timestamp: TS,
        rawPos: 33,
        rawLength: 12,
      },
      {
        type: 'insert',
        position: 47,
        length: 3,
        text: 'new',
        authorId: 'USER',
        timestamp: TS,
        rawPos: 59,
        rawLength: 3,
      },
      {
        type: 'delete',
        position: 50,
        length: 3,
        text: 'old',
        authorId: 'USER',
        timestamp: TS,
        rawPos: 62,
        rawLength: 3,
      },
      {
        type: 'insert',
        position: 68,
        length: 5,
        text: 'über ',
        authorId: 'USER2',
        timestamp: TS,
        rawPos: 83,
        rawLength: 5,
      },
      {
        type: 'delete',
        position: 78,
        length: 3,
        text: '😀 ',
        authorId: 'USER',
        timestamp: TS,
        rawPos: 93,
        rawLength: 3,
      },
    ])
    for (const change of changes) {
      expect(change.changeId).toMatch(/^ht_[A-Za-z0-9_-]{22}$/u)
      if (change.type === 'insert')
        expect(document.content.slice(change.position, visibleEnd(change))).toBe(change.text)
    }
    expect(new Set(ids(changes)).size).toBe(changes.length)
    expect(changes[2]?.pairedChangeId).toBe(changes[3]?.changeId)
    expect(changes[3]?.pairedChangeId).toBe(changes[2]?.changeId)
    expect(changes.filter(change => change.pairedChangeId !== undefined)).toHaveLength(2)
  })

  test('ids are stable for one document and differ between documents', async () => {
    const { snapshot } = await historyDocument()

    expect(ids(parseHistoryOtChanges(snapshot, 'DOC'))).toEqual(ids(parseHistoryOtChanges(snapshot, 'DOC')))
    expect(ids(parseHistoryOtChanges(snapshot, 'OTHER'))).not.toEqual(ids(parseHistoryOtChanges(snapshot, 'DOC')))
  })

  test('an id changes with the author or timestamp of a change at the same range, so a stale id is refused', () => {
    const tracked = (userId: string, ts: string): HistorySnapshot => ({
      content: 'abcdef',
      trackedChanges: [{ range: { pos: 1, length: 3 }, tracking: { type: 'insert', userId, ts } }],
    })
    const [stale] = parseHistoryOtChanges(tracked('U', TS), 'DOC')

    for (const retracked of [tracked('V', TS), tracked('U', '2026-01-02T00:00:00.000Z')]) {
      const changes = parseHistoryOtChanges(retracked, 'DOC')
      expect(changes).toEqual([expect.objectContaining({ type: 'insert', rawPos: 1, rawLength: 3 })])
      expect(changes[0]!.changeId).not.toBe(stale!.changeId)
      expect(() => planHistoryOtDecision(retracked, changes, [stale!.changeId], 'accept')).toThrowError(
        expect.objectContaining({ code: 'NOT_FOUND', details: { missingChangeIds: [stale!.changeId] } })
      )
    }
  })

  test('pairs a replacement by adjacency in the raw snapshot, not in the visible content', () => {
    // A's delete starts where A's insert ends in the visible content, but B's delete lies between them.
    const snapshot: HistorySnapshot = {
      content: 'NEWxold!',
      trackedChanges: [
        { range: { pos: 0, length: 3 }, tracking: { type: 'insert', userId: 'A', ts: TS } },
        { range: { pos: 3, length: 1 }, tracking: { type: 'delete', userId: 'B', ts: TS } },
        { range: { pos: 4, length: 3 }, tracking: { type: 'delete', userId: 'A', ts: TS } },
      ],
    }
    const changes = parseHistoryOtChanges(snapshot, 'DOC')

    expect(changes.map(change => [change.type, change.authorId, change.position, change.rawPos])).toEqual([
      ['insert', 'A', 0, 0],
      ['delete', 'B', 3, 3],
      ['delete', 'A', 3, 4],
    ])
    expect(changes.every(change => change.pairedChangeId === undefined)).toBe(true)
  })

  test('merges touching ranges of one type and user before hashing, keeping the earliest timestamp', () => {
    const tracking = (userId: string, ts: string) => ({ type: 'delete' as const, userId, ts })
    const split: HistorySnapshot = {
      content: 'abcdefgh',
      trackedChanges: [
        { range: { pos: 3, length: 2 }, tracking: tracking('U', '2026-01-01T00:00:00.000Z') },
        { range: { pos: 1, length: 2 }, tracking: tracking('U', '2026-01-02T00:00:00.000Z') },
        { range: { pos: 5, length: 1 }, tracking: tracking('V', '2026-01-01T00:00:00.000Z') },
      ],
    }
    const merged: HistorySnapshot = {
      content: 'abcdefgh',
      trackedChanges: [
        { range: { pos: 1, length: 4 }, tracking: tracking('U', '2026-01-01T00:00:00.000Z') },
        { range: { pos: 5, length: 1 }, tracking: tracking('V', '2026-01-01T00:00:00.000Z') },
      ],
    }

    const changes = parseHistoryOtChanges(split, 'DOC')
    expect(changes).toHaveLength(2)
    expect(changes[0]).toMatchObject({ rawPos: 1, rawLength: 4, text: 'bcde', timestamp: '2026-01-01T00:00:00.000Z' })
    expect(ids(changes)).toEqual(ids(parseHistoryOtChanges(merged, 'DOC')))
    expect(canonicalHistorySnapshot(split)).toEqual(canonicalHistorySnapshot(merged))
  })

  test('reads no changes from a snapshot without tracked changes, and skips malformed ranges', () => {
    expect(parseHistoryOtChanges({ content: 'text' }, 'DOC')).toEqual([])
    const snapshot = {
      content: 'text',
      trackedChanges: [
        { range: { pos: 0, length: 0 }, tracking: { type: 'insert', userId: 'U', ts: TS } },
        { range: { pos: 2, length: 9 }, tracking: { type: 'insert', userId: 'U', ts: TS } },
        { range: { pos: 1, length: 1 }, tracking: { type: 'none', userId: 'U', ts: TS } },
        { range: { pos: 1, length: 1 }, tracking: { type: 'insert', ts: TS } },
      ],
    } as unknown as HistorySnapshot

    expect(parseHistoryOtChanges(snapshot, 'DOC')).toEqual([
      expect.objectContaining({ type: 'insert', rawPos: 1, rawLength: 1, text: 'e', authorId: null }),
    ])
  })
})

describe('locations and excerpts', () => {
  test('the locator agrees with offsetToLineColumn on every change boundary of both fixtures', async () => {
    const share = await shareJsDocument()
    const history = await historyDocument()
    for (const [document, changes] of [
      [share.document, parseShareJsChanges(share.document.ranges)],
      [history.document, parseHistoryOtChanges(history.snapshot, 'DOC')],
    ] as const) {
      const locate = createLocator(document.content)
      for (const change of changes) {
        for (const offset of [change.position, visibleEnd(change)]) {
          expect(locate(offset)).toEqual(offsetToLineColumn(document.content, offset))
        }
      }
      expect(locate(0)).toEqual({ line: 1, column: 1 })
      expect(locate(document.content.length)).toEqual(offsetToLineColumn(document.content, document.content.length))
    }
  })

  test('the locator reports a change on the fourth line of the ShareJS fixture', async () => {
    const { document } = await shareJsDocument()
    const locate = createLocator(document.content)

    expect(locate(68)).toEqual({ line: 4, column: 12 })
    expect(locate(73)).toEqual({ line: 4, column: 17 })
  })

  test('the locator refuses an offset outside the document as a protocol error', () => {
    const locate = createLocator('ab\ncd')

    expect(() => locate(6)).toThrowError(expect.objectContaining({ code: 'PROTOCOL_UNSUPPORTED' }))
    expect(() => locate(-1)).toThrowError(expect.objectContaining({ code: 'PROTOCOL_UNSUPPORTED' }))
  })

  test('excerpts stay within the limit and never split a surrogate pair', () => {
    expect(excerpt('ab😀', 3)).toEqual({ excerpt: 'ab', truncated: true })
    expect(excerpt('ab😀', 4)).toEqual({ excerpt: 'ab😀', truncated: false })
    expect(excerpt('ab😀cd', 4)).toEqual({ excerpt: 'ab😀', truncated: true })
    expect(excerpt('😀', 1)).toEqual({ excerpt: '', truncated: true })
    expect(excerpt('text', 0)).toEqual({ excerpt: '', truncated: true })
    expect(excerpt('', 0)).toEqual({ excerpt: '', truncated: false })
    const text = 'é😀'.repeat(50)
    for (let limit = 0; limit <= 160; limit += 1) {
      const { excerpt: value } = excerpt(text, limit)
      expect(value.length).toBeLessThanOrEqual(limit)
      expect(value).toBe(text.slice(0, value.length))
      expect(/[\uD800-\uDBFF]$/u.test(value)).toBe(false)
    }
  })
})

describe('id checks and overlap', () => {
  const changes = parseShareJsChanges({
    changes: [
      { id: 'outer', op: { p: 5, i: 'hello' }, metadata: { user_id: 'A' } },
      { id: 'inner', op: { p: 7, d: 'zz' }, metadata: { user_id: 'B' } },
      { id: 'edge', op: { p: 10, d: 'yy' }, metadata: { user_id: 'B' } },
      { id: 'next', op: { p: 10, i: 'x' }, metadata: { user_id: 'B' } },
      { op: { p: 20, i: 'unnamed' }, metadata: { user_id: 'B' } },
      { id: 'covered', op: { p: 22, d: 'q' }, metadata: { user_id: 'B' } },
    ],
  })

  test('names the requested ids no change carries, each once', () => {
    expect(missingChangeIds(changes, ['outer', 'gone', 'gone', 'other'])).toEqual(['gone', 'other'])
    expect(missingChangeIds(changes, ['outer', 'inner'])).toEqual([])
  })

  test('a delete strictly inside an insert overlaps it; touching changes do not', () => {
    expect(ids(overlappingChanges(changes, ['outer']))).toEqual(['inner'])
    expect(ids(overlappingChanges(changes, ['inner']))).toEqual(['outer'])
    expect(overlappingChanges(changes, ['outer', 'inner'])).toEqual([])
    expect(overlappingChanges(changes, ['edge'])).toEqual([])
    expect(overlappingChanges(changes, ['next'])).toEqual([])
  })

  test('two inserts overlap only when their texts strictly intersect', () => {
    const nested = parseShareJsChanges({
      changes: [
        { id: 'wide', op: { p: 0, i: 'abcd' }, metadata: { user_id: 'A' } },
        { id: 'within', op: { p: 2, i: 'xy' }, metadata: { user_id: 'B' } },
      ],
    })
    const touching = parseShareJsChanges({
      changes: [
        { id: 'left', op: { p: 0, i: 'ab' }, metadata: { user_id: 'A' } },
        { id: 'right', op: { p: 2, i: 'cd' }, metadata: { user_id: 'B' } },
      ],
    })

    expect(ids(overlappingChanges(nested, ['wide']))).toEqual(['within'])
    expect(ids(overlappingChanges(nested, ['within']))).toEqual(['wide'])
    expect(overlappingChanges(touching, ['left'])).toEqual([])
    expect(overlappingChanges(touching, ['right'])).toEqual([])
  })

  test('a change without an id that overlaps a chosen one is reported', () => {
    expect(overlappingChanges(changes, ['covered'])).toEqual([expect.objectContaining({ text: 'unnamed' })])
  })

  test('choosing one half of the fixture replacement overlaps nothing', async () => {
    const { document } = await shareJsDocument()
    const parsed = parseShareJsChanges(document.ranges)

    expect(overlappingChanges(parsed, ['change-3'])).toEqual([])
    expect(overlappingChanges(parsed, ['change-4'])).toEqual([])
  })
})

describe('planShareJsReject', () => {
  test('rejects the replacement pair as the live-verified update', async () => {
    const { document } = await shareJsDocument()

    expect(planShareJsReject(parseShareJsChanges(document.ranges), ['change-4', 'change-3'])).toEqual([
      { p: 47, d: 'new', u: true },
      { p: 47, i: 'old', u: true },
    ])
  })

  test('rejects every change in one ascending update with cumulative shifts', async () => {
    const { document } = await shareJsDocument()
    const changes = parseShareJsChanges(document.ranges)
    const components = planShareJsReject(changes, ['change-5', 'change-1', 'change-2', 'change-3', 'change-4'])

    expect(components).toEqual([
      { p: 11, d: 'INSERTED ', u: true },
      { p: 24, i: ' this phrase', u: true },
      { p: 50, d: 'new', u: true },
      { p: 50, i: 'old', u: true },
      { p: 71, d: 'über ', u: true },
    ])
    const original = 'Alpha beta gamma.\nRemove this phrase now.\nReplace old here.\nNaïve café text.\n'
    expect(applyShareJs(document.content, components)).toBe(original)
    expect(
      expectedAfterDecision({
        protocol: 'sharejs',
        content: document.content,
        changes,
        changeIds: ids(changes),
        action: 'reject',
      })
    ).toEqual({ content: original })
  })

  test('rejects a single insert or delete with the undo flag and nothing else', async () => {
    const { document } = await shareJsDocument()
    const changes = parseShareJsChanges(document.ranges)

    expect(planShareJsReject(changes, ['change-1'])).toEqual([{ p: 11, d: 'INSERTED ', u: true }])
    expect(planShareJsReject(changes, ['change-2'])).toEqual([{ p: 33, i: ' this phrase', u: true }])
    expect(planShareJsReject(changes, ['change-5'])).toEqual([{ p: 68, d: 'über ', u: true }])
  })

  test('restores a delete before removing an insert that starts at the same offset', () => {
    const changes = parseShareJsChanges({
      changes: [
        { id: 'ins', op: { p: 2, i: 'ab' }, metadata: { user_id: 'A' } },
        { id: 'del', op: { p: 2, d: 'XY' }, metadata: { user_id: 'A' } },
      ],
    })
    const components = planShareJsReject(changes, ['ins', 'del'])

    expect(components).toEqual([
      { p: 2, i: 'XY', u: true },
      { p: 4, d: 'ab', u: true },
    ])
    expect(applyShareJs('01ab23', components)).toBe('01XY23')
  })

  test('refuses an id that is not a change in the document', async () => {
    const { document } = await shareJsDocument()
    const changes = parseShareJsChanges(document.ranges)

    expect(() => planShareJsReject(changes, ['change-1', 'gone'])).toThrowError(
      expect.objectContaining({ code: 'NOT_FOUND', details: { missingChangeIds: ['gone'] } })
    )
  })

  test('an accept is expected to leave the content as it was', async () => {
    const { document } = await shareJsDocument()

    expect(
      expectedAfterDecision({
        protocol: 'sharejs',
        content: document.content,
        changes: parseShareJsChanges(document.ranges),
        changeIds: ['change-1', 'change-2'],
        action: 'accept',
      })
    ).toEqual({ content: document.content })
  })
})

describe('planHistoryOtDecision', () => {
  function chosen(snapshot: HistorySnapshot, changes: HistoryOtTrackedChange[], indexes: number[]): string[] {
    return indexes.map(index => {
      const pos = snapshot.trackedChanges?.[index]?.range.pos
      const change = changes.find(candidate => candidate.rawPos === pos)
      if (!change) throw new Error(`no parsed change at fixture index ${index}`)
      return change.changeId
    })
  }

  test('builds every fixture decision exactly and predicts the snapshot it leaves', async () => {
    const { snapshot, fixture: history } = await historyDocument()
    const changes = parseHistoryOtChanges(snapshot, 'DOC')
    expect(snapshot.content).toHaveLength(history.rawLength)

    for (const decision of history.decisions) {
      const changeIds = chosen(snapshot, changes, decision.changes)
      const operation = planHistoryOtDecision(snapshot, changes, changeIds, decision.action)

      expect(operation, decision.name).toEqual({ textOperation: decision.textOperation })
      const baseLength = (operation.textOperation as Array<number | { r: number }>).reduce<number>(
        (total, component) => total + (typeof component === 'number' ? Math.abs(component) : component.r),
        0
      )
      expect(baseLength, decision.name).toBe(history.rawLength)
      expect(JSON.stringify(operation)).not.toMatch(/"(userId|ts|meta)"/u)

      const expected = expectedAfterDecision({
        protocol: 'history-ot',
        snapshot,
        changes,
        changeIds,
        action: decision.action,
      })
      expect(expected.snapshot, decision.name).toEqual(canonicalHistorySnapshot(decision.expectedSnapshot))
      expect(expected.content, decision.name).toBe(decision.expectedVisibleContent)
      expect(normalizeLf(historyVisibleContent(decision.expectedSnapshot))).toBe(decision.expectedVisibleContent)
    }
  })

  test('orders the chosen changes by raw position whatever order the ids come in', async () => {
    const { snapshot } = await historyDocument()
    const changes = parseHistoryOtChanges(snapshot, 'DOC')
    const [insert, deletion] = [changes[0]!, changes[1]!]

    expect(planHistoryOtDecision(snapshot, changes, [deletion.changeId, insert.changeId], 'accept')).toEqual({
      textOperation: [11, { r: 9, tracking: { type: 'none' } }, 13, -12, 56],
    })
  })

  test('re-merges deletes that a rejected insert between them leaves touching', () => {
    const snapshot: HistorySnapshot = {
      content: 'aDDIIEEz',
      trackedChanges: [
        { range: { pos: 1, length: 2 }, tracking: { type: 'delete', userId: 'U', ts: '2026-01-02T00:00:00.000Z' } },
        { range: { pos: 3, length: 2 }, tracking: { type: 'insert', userId: 'U', ts: TS } },
        { range: { pos: 5, length: 2 }, tracking: { type: 'delete', userId: 'U', ts: TS } },
      ],
    }
    const changes = parseHistoryOtChanges(snapshot, 'DOC')
    const insert = changes.find(change => change.type === 'insert')!

    expect(planHistoryOtDecision(snapshot, changes, [insert.changeId], 'reject')).toEqual({
      textOperation: [3, -2, 3],
    })
    expect(
      expectedAfterDecision({
        protocol: 'history-ot',
        snapshot,
        changes,
        changeIds: [insert.changeId],
        action: 'reject',
      })
    ).toEqual({
      content: 'az',
      snapshot: {
        content: 'aDDEEz',
        trackedChanges: [{ range: { pos: 1, length: 4 }, tracking: { type: 'delete', userId: 'U', ts: TS } }],
      },
    })
  })

  test('one id for merge-equivalent ranges decides both raw ranges', () => {
    const snapshot: HistorySnapshot = {
      content: 'abcdef',
      trackedChanges: [
        { range: { pos: 1, length: 2 }, tracking: { type: 'insert', userId: 'U', ts: TS } },
        { range: { pos: 3, length: 1 }, tracking: { type: 'insert', userId: 'U', ts: TS } },
      ],
    }
    const changes = parseHistoryOtChanges(snapshot, 'DOC')
    expect(changes).toHaveLength(1)

    expect(planHistoryOtDecision(snapshot, changes, [changes[0]!.changeId], 'reject')).toEqual({
      textOperation: [1, -3, 2],
    })
    expect(
      expectedAfterDecision({
        protocol: 'history-ot',
        snapshot,
        changes,
        changeIds: [changes[0]!.changeId],
        action: 'accept',
      })
    ).toEqual({ content: 'abcdef', snapshot: { content: 'abcdef', trackedChanges: [] } })
  })

  test('refuses an id that is not a change in the document', async () => {
    const { snapshot } = await historyDocument()
    const changes = parseHistoryOtChanges(snapshot, 'DOC')

    expect(() => planHistoryOtDecision(snapshot, changes, ['ht_gone'], 'accept')).toThrowError(
      expect.objectContaining({ code: 'NOT_FOUND', details: { missingChangeIds: ['ht_gone'] } })
    )
  })
})
