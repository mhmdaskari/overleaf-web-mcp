import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'

import { describe, expect, test, vi } from 'vitest'

import { McpError } from '../../src/core/errors.js'
import { AccessPolicy } from '../../src/core/policy.js'
import { FifoQueue } from '../../src/core/queue.js'
import { createRevision } from '../../src/core/revision.js'
import { TrackedChangesApi } from '../../src/overleaf/tracked-changes.js'
import type { HistorySnapshot } from '../../src/protocol/ot.js'
import { ProjectConnection, type JoinedDocument } from '../../src/protocol/project-connection.js'
import { parseSocketPacket } from '../../src/protocol/socketio09-codec.js'
import { parseHistoryOtChanges, parseShareJsChanges } from '../../src/protocol/tracked-changes.js'

// TrackedChangesApi over the two tracked-change fixtures: every check before a decision is sent,
// the exact operation or request sent, the verification, and the recovery of an unconfirmed one.

const PROJECT = 'project'
const DOC = 'DOC'
const TS = '2026-01-01T00:00:00.000Z'
const META = { user_id: 'USER', ts: TS }

interface HistoryDecisionFixture {
  name: string
  action: 'accept' | 'reject'
  changes: number[]
  textOperation: unknown[]
  expectedSnapshot: HistorySnapshot
  expectedVisibleContent: string
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

/** Joins a fixture frame through a real ProjectConnection, so its range text is decoded as Overleaf sends it. */
async function joinFrame(frame: string): Promise<JoinedDocument> {
  const peer = new FakePeer()
  peer.call.mockResolvedValueOnce(ackArgs(frame))
  const connection = new ProjectConnection({
    projectId: PROJECT,
    peer,
    join: {
      publicId: 'P.client',
      project: {
        _id: PROJECT,
        rootFolder: [{ _id: 'root', name: 'rootFolder', docs: [{ _id: DOC, name: 'main.tex' }] }],
      },
      permissionsLevel: 'owner',
      protocolVersion: 2,
    },
    supportedProtocolVersions: [2],
  })
  return await connection.joinDocument(DOC)
}

async function shareFixture(): Promise<{ document: JoinedDocument; rangesIndex: unknown }> {
  const raw = await fixture<{ joinDocAck: string; rangesIndex: unknown }>('sharejs-tracked-changes.json')
  return { document: await joinFrame(raw.joinDocAck), rangesIndex: raw.rangesIndex }
}

async function historyFixture(): Promise<{ document: JoinedDocument; decisions: HistoryDecisionFixture[] }> {
  const raw = await fixture<{ joinDocAck: string; decisions: HistoryDecisionFixture[] }>(
    'history-ot-tracked-changes.json'
  )
  return { document: await joinFrame(raw.joinDocAck), decisions: raw.decisions }
}

/** A decoded ShareJS document as a join returns it. */
function shareDocument(content: string, version: number, changes: unknown[]): JoinedDocument {
  return { docId: DOC, protocol: 'sharejs', version, content, ranges: { changes, comments: [] }, rawSnapshot: content }
}

/** The same ShareJS document with the given change ids gone, as an accept leaves it. */
function withoutChanges(document: JoinedDocument, ids: readonly string[]): JoinedDocument {
  const ranges = document.ranges as { changes: Array<{ id?: string }> }
  return shareDocument(
    document.content,
    document.version,
    ranges.changes.filter(change => change.id === undefined || !ids.includes(change.id))
  )
}

function historyDocument(snapshot: HistorySnapshot, version: number, content: string): JoinedDocument {
  return { docId: DOC, protocol: 'history-ot', version, content, ranges: {}, rawSnapshot: snapshot }
}

function revisionOf(document: JoinedDocument): string {
  return createRevision({
    projectId: PROJECT,
    docId: DOC,
    protocol: document.protocol,
    otVersion: document.version,
    content: document.content,
  })
}

const TREE = [
  { id: DOC, name: 'main.tex', path: 'main.tex', type: 'doc' as const, parentFolderId: 'root' },
  { id: 'OTHER', name: 'other.tex', path: 'other.tex', type: 'doc' as const, parentFolderId: 'root' },
]

interface HarnessOptions {
  permissionsLevel?: string
  features?: unknown
  /** What each join returns, in order; an Error is thrown by that join instead. */
  joins?: Array<JoinedDocument | Error>
  submitUpdate?: () => Promise<void>
  request?: () => Promise<Response>
  getJson?: () => Promise<unknown>
  maxDocLength?: number
  maxUpdateChars?: number
  recoveryTimeoutMs?: number
}

function harness(options: HarnessOptions = {}) {
  const joins = [...(options.joins ?? [])]
  const connection = {
    queue: new FifoQueue(),
    getTree: () => TREE,
    joinDocument: vi.fn<(docId: string) => Promise<JoinedDocument>>(async () => {
      const value = joins.shift()
      if (value === undefined) throw new McpError('REMOTE_ERROR', 'no document fixture left')
      if (value instanceof Error) throw value
      return structuredClone(value)
    }),
    leaveDocument: vi.fn<(docId: string) => Promise<void>>(async () => undefined),
    submitUpdate: vi.fn<(docId: string, update: Record<string, unknown>) => Promise<void>>(async () => {
      await options.submitUpdate?.()
    }),
    trackChangesActive: true,
    permissionsLevel: options.permissionsLevel ?? 'owner',
    project: options.features === undefined ? {} : { features: options.features },
  }
  type Connection = typeof connection
  const withConnection = vi.fn<
    (projectId: string, operation: (value: Connection) => Promise<unknown>) => Promise<unknown>
  >(async (_projectId, operation) => await operation(connection))
  const connections = {
    withConnection: withConnection as unknown as <T>(
      projectId: string,
      operation: (value: Connection) => Promise<T>
    ) => Promise<T>,
    invalidate: vi.fn<(projectId: string) => Promise<void>>(async () => undefined),
  }
  const http = {
    getJson: vi.fn<(path: string) => Promise<unknown>>(async () => (options.getJson ? await options.getJson() : [])),
    request: vi.fn<(method: string, path: string, body?: unknown) => Promise<Response>>(async () =>
      options.request ? await options.request() : new Response(null, { status: 204 })
    ),
  }
  const api = new TrackedChangesApi(http, connections, {
    recoveryTimeoutMs: options.recoveryTimeoutMs ?? 50,
    recoveryPollIntervalMs: 0,
    ...(options.maxDocLength === undefined ? {} : { maxDocLength: options.maxDocLength }),
    ...(options.maxUpdateChars === undefined ? {} : { maxUpdateChars: options.maxUpdateChars }),
  })
  return { api, connection, connections, withConnection, http }
}

async function rejection(promise: Promise<unknown>): Promise<McpError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught
  )
  expect(error).toBeInstanceOf(McpError)
  return error as McpError
}

/** Nothing was read from the document and nothing was sent. */
function expectNothingSent(h: ReturnType<typeof harness>): void {
  expect(h.connection.submitUpdate).not.toHaveBeenCalled()
  expect(h.http.request).not.toHaveBeenCalled()
}

function decide(document: JoinedDocument, action: 'accept' | 'reject', changeIds: string[], confirmCount?: number) {
  return {
    projectId: PROJECT,
    filePath: 'main.tex',
    revision: revisionOf(document),
    action,
    changeIds,
    ...(confirmCount === undefined ? {} : { confirmCount }),
  }
}

describe('list_tracked_changes', () => {
  test('lists a named ShareJS document with decoded text, 1-based positions, and replacement pairs', async () => {
    const { document } = await shareFixture()
    const h = harness({ joins: [document] })

    const result = await h.api.listTrackedChanges(PROJECT, { filePath: 'main.tex' })

    expect(h.http.getJson).not.toHaveBeenCalled()
    expect(result).toEqual({
      documents: [
        {
          filePath: 'main.tex',
          revision: revisionOf(document),
          protocol: 'sharejs',
          totalChanges: 5,
          changes: [
            {
              changeId: 'change-1',
              type: 'insert',
              start: { line: 1, column: 12 },
              end: { line: 1, column: 21 },
              length: 9,
              excerpt: 'INSERTED ',
              excerptTruncated: false,
              authorId: 'USER',
              timestamp: TS,
            },
            {
              changeId: 'change-2',
              type: 'delete',
              start: { line: 2, column: 7 },
              end: { line: 2, column: 7 },
              length: 12,
              excerpt: ' this phrase',
              excerptTruncated: false,
              authorId: 'USER',
              timestamp: TS,
            },
            {
              changeId: 'change-3',
              type: 'insert',
              start: { line: 3, column: 9 },
              end: { line: 3, column: 12 },
              length: 3,
              excerpt: 'new',
              excerptTruncated: false,
              authorId: 'USER',
              timestamp: TS,
              pairedChangeId: 'change-4',
            },
            {
              changeId: 'change-4',
              type: 'delete',
              start: { line: 3, column: 12 },
              end: { line: 3, column: 12 },
              length: 3,
              excerpt: 'old',
              excerptTruncated: false,
              authorId: 'USER',
              timestamp: TS,
              pairedChangeId: 'change-3',
            },
            {
              changeId: 'change-5',
              type: 'insert',
              start: { line: 4, column: 12 },
              end: { line: 4, column: 17 },
              length: 5,
              excerpt: 'über ',
              excerptTruncated: false,
              authorId: 'USER',
              timestamp: TS,
            },
          ],
        },
      ],
      totalMatched: 5,
      truncated: false,
      trackChangesActive: true,
    })
    // The inserted text is where the listing says it is.
    const lines = document.content.split('\n')
    expect(lines[3]!.slice(11, 16)).toBe('über ')
    expect(JSON.stringify(result)).not.toMatch(/email/iu)
    expect(h.connection.leaveDocument).toHaveBeenCalledWith(DOC)
  })

  test('without filePath reads the range index and joins only the documents it lists with changes', async () => {
    const { document, rangesIndex } = await shareFixture()
    const index = [...(rangesIndex as unknown[]), { id: 'OTHER', ranges: { comments: [] } }, { id: 'GONE' }]
    const h = harness({ joins: [document], getJson: async () => index })

    const result = await h.api.listTrackedChanges(PROJECT)

    expect(h.http.getJson).toHaveBeenCalledExactlyOnceWith(`/project/${PROJECT}/ranges`)
    expect(h.connection.joinDocument).toHaveBeenCalledExactlyOnceWith(DOC)
    expect(result.documents.map(entry => entry.filePath)).toEqual(['main.tex'])
    expect(result.totalMatched).toBe(5)
    expect(result).not.toHaveProperty('indexUnavailable')
  })

  test('without filePath and without a range index, reports indexUnavailable and joins nothing', async () => {
    for (const failure of [
      new McpError('NOT_FOUND', 'Overleaf resource was not found'),
      new McpError('PROTOCOL_UNSUPPORTED', 'Overleaf returned a response that is not JSON.'),
    ]) {
      const h = harness({
        getJson: async () => {
          throw failure
        },
      })
      const result = await h.api.listTrackedChanges(PROJECT)
      expect(result).toEqual({
        documents: [],
        totalMatched: 0,
        truncated: false,
        trackChangesActive: true,
        indexUnavailable: true,
      })
      expect(h.connection.joinDocument).not.toHaveBeenCalled()
    }
    // An index in a shape this release does not know is no index either.
    const odd = harness({ getJson: async () => ({ changes: [] }) })
    expect(await odd.api.listTrackedChanges(PROJECT)).toMatchObject({ indexUnavailable: true })
    expect(odd.connection.joinDocument).not.toHaveBeenCalled()
  })

  test('a transient index failure is an error, not an empty listing', async () => {
    const h = harness({
      getJson: async () => {
        throw new McpError('REMOTE_ERROR', 'Overleaf returned HTTP 500.', { details: { status: 500 } })
      },
    })
    expect((await rejection(h.api.listTrackedChanges(PROJECT))).code).toBe('REMOTE_ERROR')
    expect(h.connection.joinDocument).not.toHaveBeenCalled()
  })

  test('filters by type and author, and limit caps the changes across documents', async () => {
    const { document } = await shareFixture()

    const deletes = await harness({ joins: [document] }).api.listTrackedChanges(PROJECT, {
      filePath: 'main.tex',
      type: 'delete',
    })
    expect(deletes.documents[0]!.changes.map(change => change.changeId)).toEqual(['change-2', 'change-4'])
    expect(deletes).toMatchObject({ totalMatched: 2, truncated: false })
    expect(deletes.documents[0]!.totalChanges).toBe(5)

    const nobody = await harness({ joins: [document] }).api.listTrackedChanges(PROJECT, {
      filePath: 'main.tex',
      authorId: 'SOMEONE',
    })
    expect(nobody).toMatchObject({ totalMatched: 0, truncated: false })
    expect(nobody.documents[0]!.changes).toEqual([])

    const capped = await harness({ joins: [document] }).api.listTrackedChanges(PROJECT, {
      filePath: 'main.tex',
      limit: 2,
    })
    expect(capped.documents[0]!.changes.map(change => change.changeId)).toEqual(['change-1', 'change-2'])
    expect(capped).toMatchObject({ totalMatched: 5, truncated: true })

    // A limit equal to the number of matches leaves nothing out.
    const exact = await harness({ joins: [document] }).api.listTrackedChanges(PROJECT, {
      filePath: 'main.tex',
      limit: 5,
    })
    expect(exact.documents[0]!.changes).toHaveLength(5)
    expect(exact).toMatchObject({ totalMatched: 5, truncated: false })
  })

  test('excerpts never exceed excerptChars or split a surrogate pair, and 0 leaves them out', async () => {
    // A cut after 2 or 4 UTF-16 units would land inside a surrogate pair.
    const astral = shareDocument('x😀😀y\n', 2, [{ id: 'astral', op: { p: 0, i: 'x😀😀y' }, metadata: META }])
    const { document: history } = await historyFixture()
    for (const document of [astral, history]) {
      for (let excerptChars = 0; excerptChars <= 8; excerptChars += 1) {
        const result = await harness({ joins: [document] }).api.listTrackedChanges(PROJECT, {
          filePath: 'main.tex',
          excerptChars,
        })
        for (const change of result.documents[0]!.changes) {
          if (excerptChars === 0) {
            expect(change).not.toHaveProperty('excerpt')
            expect(change.excerptTruncated).toBe(true)
            continue
          }
          const text = change.excerpt!
          expect(text.length).toBeLessThanOrEqual(excerptChars)
          expect(text.length === 0 ? false : /[\uD800-\uDBFF]$/u.test(text)).toBe(false)
          expect(change.excerptTruncated).toBe(text.length < change.length)
        }
      }
    }
  })

  test('lists a history-OT document by filePath with synthesized ids', async () => {
    const { document } = await historyFixture()
    const result = await harness({ joins: [document] }).api.listTrackedChanges(PROJECT, { filePath: 'main.tex' })
    const listed = result.documents[0]!
    expect(listed).toMatchObject({ protocol: 'history-ot', totalChanges: 6, revision: revisionOf(document) })
    expect(listed.changes.map(change => change.changeId)).toEqual(
      parseHistoryOtChanges(document.rawSnapshot as HistorySnapshot, DOC).map(change => change.changeId)
    )
    for (const change of listed.changes) expect(change.changeId).toMatch(/^ht_[A-Za-z0-9_-]{22}$/u)
    expect(listed.changes.find(change => change.authorId === 'USER2')).toMatchObject({
      type: 'insert',
      excerpt: 'über ',
    })
  })

  test('counts changes Overleaf stored without an id as undecidable and leaves them out', async () => {
    const document = shareDocument('abc def\n', 1, [
      { id: 'kept', op: { p: 0, i: 'abc' }, metadata: META },
      { op: { p: 4, i: 'def' }, metadata: META },
    ])
    const result = await harness({ joins: [document] }).api.listTrackedChanges(PROJECT, { filePath: 'main.tex' })
    expect(result.documents[0]).toMatchObject({ totalChanges: 2, undecidableChanges: 1 })
    expect(result.documents[0]!.changes.map(change => change.changeId)).toEqual(['kept'])
    expect(result.totalMatched).toBe(1)
  })

  test('checks the access policy before any request', async () => {
    const policy = await AccessPolicy.create({ allowedProjects: ['elsewhere'] })
    const h = harness()
    const api = new TrackedChangesApi(h.http, h.connections, { policy })
    expect((await rejection(api.listTrackedChanges(PROJECT))).code).toBe('POLICY_DENIED')
    const readOnly = await AccessPolicy.create({ allowedEffects: ['overleaf-read'] })
    const refused = new TrackedChangesApi(h.http, h.connections, { policy: readOnly })
    const { document } = await shareFixture()
    expect((await rejection(refused.manageTrackedChanges(decide(document, 'accept', ['change-1'], 1)))).code).toBe(
      'POLICY_DENIED'
    )
    expect(h.http.getJson).not.toHaveBeenCalled()
    expect(h.withConnection).not.toHaveBeenCalled()
  })
})

describe('manage_tracked_changes checks before anything is sent', () => {
  test('a missing or wrong confirmCount is CONFIRMATION_MISMATCH with no join, update, or request', async () => {
    const { document } = await shareFixture()
    for (const confirmCount of [undefined, 0, 2]) {
      const h = harness({ joins: [document] })
      const error = await rejection(h.api.manageTrackedChanges(decide(document, 'accept', ['change-1'], confirmCount)))
      expect(error.code).toBe('CONFIRMATION_MISMATCH')
      if (confirmCount === undefined) expect(error.details).toEqual({ missing: 'confirmCount' })
      expect(h.withConnection).not.toHaveBeenCalled()
      expect(h.connection.joinDocument).not.toHaveBeenCalled()
      expectNothingSent(h)
    }
  })

  test('duplicate or empty changeIds are refused before the project is opened', async () => {
    const { document } = await shareFixture()
    const duplicated = harness({ joins: [document] })
    const error = await rejection(
      duplicated.api.manageTrackedChanges(decide(document, 'reject', ['change-1', 'change-1'], 2))
    )
    expect(error).toMatchObject({ code: 'INVALID_ARGUMENT', details: { duplicateChangeIds: ['change-1'] } })
    const empty = harness({ joins: [document] })
    expect((await rejection(empty.api.manageTrackedChanges(decide(document, 'reject', [], 0)))).code).toBe(
      'INVALID_ARGUMENT'
    )
    for (const h of [duplicated, empty]) {
      expect(h.withConnection).not.toHaveBeenCalled()
      expectNothingSent(h)
    }
  })

  test('review and read-only access is PERMISSION_DENIED before the document is read', async () => {
    const { document } = await shareFixture()
    for (const permissionsLevel of ['review', 'readOnly', 'somethingNew']) {
      const h = harness({ permissionsLevel, joins: [document] })
      const error = await rejection(h.api.manageTrackedChanges(decide(document, 'reject', ['change-1'], 1)))
      expect(error).toMatchObject({
        code: 'PERMISSION_DENIED',
        details: { accessLevel: permissionsLevel === 'somethingNew' ? 'unrecognized' : permissionsLevel },
      })
      expect(h.connection.joinDocument).not.toHaveBeenCalled()
      expectNothingSent(h)
    }
    for (const permissionsLevel of ['owner', 'readAndWrite']) {
      const h = harness({ permissionsLevel, joins: [document, withoutChanges(document, ['change-1'])] })
      await h.api.manageTrackedChanges(decide(document, 'accept', ['change-1'], 1))
      expect(h.http.request).toHaveBeenCalledOnce()
    }
  })

  test('track changes switched off for the project is REVIEW_UNSUPPORTED before the document is read', async () => {
    const { document } = await shareFixture()
    for (const features of [{ trackChanges: false }, { trackChanges: true, trackChangesVisible: false }]) {
      const h = harness({ features, joins: [document] })
      const error = await rejection(h.api.manageTrackedChanges(decide(document, 'accept', ['change-1'], 1)))
      expect(error).toMatchObject({ code: 'REVIEW_UNSUPPORTED', details: { kind: 'feature_disabled' } })
      expect(h.connection.joinDocument).not.toHaveBeenCalled()
      expectNothingSent(h)
    }
    // Features Overleaf leaves out, or a shape it never sent, do not refuse anything.
    for (const features of [{}, { trackChanges: true }, 'odd']) {
      const h = harness({ features, joins: [document, withoutChanges(document, ['change-1'])] })
      await h.api.manageTrackedChanges(decide(document, 'accept', ['change-1'], 1))
    }
  })

  test('a stale revision is REVISION_CONFLICT with nothing sent', async () => {
    const { document } = await shareFixture()
    const h = harness({ joins: [document] })
    const stale = { ...decide(document, 'reject', ['change-1'], 1), revision: revisionOf({ ...document, version: 1 }) }
    expect((await rejection(h.api.manageTrackedChanges(stale))).code).toBe('REVISION_CONFLICT')
    expectNothingSent(h)
    expect(h.connection.leaveDocument).toHaveBeenCalledWith(DOC)
  })

  test('an id that is not a live change is NOT_FOUND naming it, with nothing sent', async () => {
    const { document } = await shareFixture()
    for (const action of ['accept', 'reject'] as const) {
      const h = harness({ joins: [document] })
      const error = await rejection(h.api.manageTrackedChanges(decide(document, action, ['change-1', 'gone'], 2)))
      expect(error).toMatchObject({ code: 'NOT_FOUND', details: { missingChangeIds: ['gone'] } })
      expectNothingSent(h)
    }
  })

  test('a change left out that overlaps a chosen one is INVALID_ARGUMENT naming it', async () => {
    // Another author deleted text inside the inserted text.
    const document = shareDocument('abcdef\n', 4, [
      { id: 'insert', op: { p: 0, i: 'abcdef' }, metadata: META },
      { id: 'inner', op: { p: 3, d: 'xyz' }, metadata: { user_id: 'OTHER', ts: TS } },
      { op: { p: 2, d: 'q' }, metadata: { user_id: 'OTHER', ts: TS } },
    ])
    const h = harness({ joins: [document] })
    const error = await rejection(h.api.manageTrackedChanges(decide(document, 'reject', ['insert'], 1)))
    expect(error).toMatchObject({
      code: 'INVALID_ARGUMENT',
      details: { overlappingChangeIds: ['inner'], undecidableOverlaps: 1 },
    })
    expectNothingSent(h)
  })

  test('an update over the size limit is refused before it is sent', async () => {
    const { document } = await shareFixture()
    const h = harness({ joins: [document], maxUpdateChars: 10 })
    expect((await rejection(h.api.manageTrackedChanges(decide(document, 'reject', ['change-1'], 1)))).code).toBe(
      'UPDATE_TOO_LARGE'
    )
    expectNothingSent(h)
  })

  test('a reject that would make the document too large is refused before it is sent', async () => {
    const { document } = await shareFixture()
    // Rejecting change-2 restores ' this phrase', 12 UTF-16 units.
    const h = harness({ joins: [document], maxDocLength: document.content.length + 5 })
    const error = await rejection(h.api.manageTrackedChanges(decide(document, 'reject', ['change-2'], 1)))
    expect(error).toMatchObject({ code: 'DOC_TOO_LARGE', details: { actual: document.content.length + 12 } })
    expectNothingSent(h)
  })

  test('a reject whose ranges disagree with the text is PROTOCOL_UNSUPPORTED with nothing sent', async () => {
    for (const change of [
      // The inserted text is not where the range says it is.
      { id: 'x', op: { p: 0, i: 'QQQ' }, metadata: META },
      // The delete point lies past the end of the document.
      { id: 'x', op: { p: 50, d: 'zzz' }, metadata: META },
    ]) {
      const document = shareDocument('abc\n', 3, [change])
      const h = harness({ joins: [document] })
      const error = await rejection(h.api.manageTrackedChanges(decide(document, 'reject', ['x'], 1)))
      expect(error.code).toBe('PROTOCOL_UNSUPPORTED')
      expectNothingSent(h)
      expect(h.connection.leaveDocument).toHaveBeenCalledWith(DOC)
    }
  })
})

describe('manage_tracked_changes on a ShareJS document', () => {
  test('accept posts once to the accept route with exactly the given ids and verifies them gone', async () => {
    const { document } = await shareFixture()
    const after = withoutChanges(document, ['change-3', 'change-4'])
    const h = harness({ joins: [document, after] })

    const result = await h.api.manageTrackedChanges(decide(document, 'accept', ['change-4', 'change-3'], 2))

    expect(h.http.request).toHaveBeenCalledExactlyOnceWith('POST', `/project/${PROJECT}/doc/${DOC}/changes/accept`, {
      change_ids: ['change-4', 'change-3'],
    })
    expect(h.connection.submitUpdate).not.toHaveBeenCalled()
    expect(h.connection.joinDocument).toHaveBeenCalledTimes(2)
    expect(result).toEqual({
      action: 'accept',
      filePath: 'main.tex',
      changeIds: ['change-4', 'change-3'],
      // An accept changes neither the text nor the version.
      revision: revisionOf(document),
      protocol: 'sharejs',
      remainingChangeCount: 3,
      trackChangesActive: true,
    })
  })

  test('accept refusals map to their codes, each after one request and with no recovery', async () => {
    const { document } = await shareFixture()
    const cases: Array<[McpError, Record<string, unknown>]> = [
      [
        new McpError('NOT_FOUND', 'Overleaf resource was not found'),
        { code: 'REVIEW_UNSUPPORTED', details: { kind: 'route_unavailable' } },
      ],
      [
        new McpError('REMOTE_ERROR', 'Overleaf returned HTTP 422.', { details: { status: 422 } }),
        { code: 'REVIEW_UNSUPPORTED', details: { kind: 'document_protocol' } },
      ],
      [
        new McpError('REMOTE_ERROR', 'Overleaf returned HTTP 400.', { details: { status: 400 } }),
        { code: 'INVALID_ARGUMENT', details: { status: 400 } },
      ],
      [new McpError('PERMISSION_DENIED', 'Overleaf denied this operation.'), { code: 'PERMISSION_DENIED' }],
      [new McpError('RATE_LIMITED', 'Overleaf rate-limited this request.'), { code: 'RATE_LIMITED' }],
    ]
    for (const [failure, expected] of cases) {
      const h = harness({
        joins: [document],
        request: async () => {
          throw failure
        },
      })
      const error = await rejection(h.api.manageTrackedChanges(decide(document, 'accept', ['change-1'], 1)))
      expect(error).toMatchObject(expected)
      expect(h.http.request).toHaveBeenCalledOnce()
      expect(h.connection.joinDocument).toHaveBeenCalledOnce()
      expect(h.connections.invalidate).not.toHaveBeenCalled()
    }
  })

  test('reject sends one untracked update that restores the text, with no tracking metadata', async () => {
    const { document } = await shareFixture()
    const after = shareDocument(
      document.content.replace('Replace new here.', 'Replace old here.'),
      document.version + 1,
      (document.ranges as { changes: Array<{ id: string }> }).changes.filter(
        change => !['change-3', 'change-4'].includes(change.id)
      )
    )
    const h = harness({ joins: [document, after] })

    const result = await h.api.manageTrackedChanges(decide(document, 'reject', ['change-3', 'change-4'], 2))

    expect(h.connection.submitUpdate).toHaveBeenCalledExactlyOnceWith(DOC, {
      doc: DOC,
      v: document.version,
      op: [
        { p: 47, d: 'new', u: true },
        { p: 47, i: 'old', u: true },
      ],
    })
    expect(h.http.request).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      action: 'reject',
      revision: revisionOf(after),
      protocol: 'sharejs',
      remainingChangeCount: 3,
    })
    expect(result).not.toHaveProperty('recoveredAfterTimeout')
  })

  test('a fresh join that misses the expected state is REVISION_CONFLICT with outcome unknown', async () => {
    const { document } = await shareFixture()
    // The accept was answered 204 and yet the change is still there.
    const accepted = harness({ joins: [document, document] })
    const error = await rejection(accepted.api.manageTrackedChanges(decide(document, 'accept', ['change-1'], 1)))
    expect(error).toMatchObject({
      code: 'REVISION_CONFLICT',
      retryable: false,
      details: { outcome: 'unknown', liveRevision: revisionOf(document) },
    })
    expect(accepted.http.request).toHaveBeenCalledOnce()

    // The reject was acknowledged and someone else's edit is live instead.
    const edited = shareDocument(`${document.content}more`, document.version + 2, [])
    const rejected = harness({ joins: [document, edited] })
    const conflict = await rejection(rejected.api.manageTrackedChanges(decide(document, 'reject', ['change-1'], 1)))
    expect(conflict).toMatchObject({ code: 'REVISION_CONFLICT', details: { outcome: 'unknown' } })
    expect(rejected.connection.submitUpdate).toHaveBeenCalledOnce()
  })

  test('an accept whose ids are gone but whose text changed is REVISION_CONFLICT with outcome unknown', async () => {
    const { document } = await shareFixture()
    const changes = (document.ranges as { changes: unknown[] }).changes
    const edited = withoutChanges(shareDocument(`${document.content}x`, document.version, changes), ['change-1'])
    const h = harness({ joins: [document, edited] })
    const error = await rejection(h.api.manageTrackedChanges(decide(document, 'accept', ['change-1'], 1)))
    expect(error).toMatchObject({ code: 'REVISION_CONFLICT', retryable: false, details: { outcome: 'unknown' } })
    expect(h.http.request).toHaveBeenCalledOnce()
    expect(h.connection.submitUpdate).not.toHaveBeenCalled()
  })

  test('a reject whose text came back but whose change is still tracked is REVISION_CONFLICT', async () => {
    const { document } = await shareFixture()
    const rejected = parseShareJsChanges(document.ranges).find(change => change.changeId === 'change-2')!
    const restored = `${document.content.slice(0, rejected.position)}${rejected.text}${document.content.slice(rejected.position)}`
    const changes = (document.ranges as { changes: Array<{ id: string }> }).changes

    // The expected text with change-2 gone is the target, so the text alone is right.
    const applied = harness({
      joins: [
        document,
        shareDocument(
          restored,
          document.version + 1,
          changes.filter(c => c.id !== 'change-2')
        ),
      ],
    })
    await applied.api.manageTrackedChanges(decide(document, 'reject', ['change-2'], 1))

    // The same text with change-2 still tracked: the reject's untracked flag was not honoured.
    const h = harness({ joins: [document, shareDocument(restored, document.version + 1, changes)] })
    const error = await rejection(h.api.manageTrackedChanges(decide(document, 'reject', ['change-2'], 1)))
    expect(error).toMatchObject({ code: 'REVISION_CONFLICT', retryable: false, details: { outcome: 'unknown' } })
    expect(h.connection.submitUpdate).toHaveBeenCalledOnce()
  })
})

describe('manage_tracked_changes on a history-OT document', () => {
  test('sends exactly the fixture operation for every decision, with no tracking metadata', async () => {
    const { document, decisions } = await historyFixture()
    const snapshot = document.rawSnapshot as HistorySnapshot
    const parsed = parseHistoryOtChanges(snapshot, DOC)
    for (const decision of decisions) {
      const changeIds = decision.changes.map(
        index => parsed.find(change => change.rawPos === snapshot.trackedChanges![index]!.range.pos)!.changeId
      )
      const after = historyDocument(decision.expectedSnapshot, document.version + 1, decision.expectedVisibleContent)
      const h = harness({ joins: [document, after] })

      const result = await h.api.manageTrackedChanges(decide(document, decision.action, changeIds, changeIds.length))

      expect(h.connection.submitUpdate, decision.name).toHaveBeenCalledExactlyOnceWith(DOC, {
        doc: DOC,
        v: document.version,
        op: [{ textOperation: decision.textOperation }],
      })
      expect(h.http.request, decision.name).not.toHaveBeenCalled()
      expect(result, decision.name).toEqual({
        action: decision.action,
        filePath: 'main.tex',
        changeIds,
        revision: revisionOf(after),
        protocol: 'history-ot',
        remainingChangeCount: 6 - decision.changes.length,
        trackChangesActive: true,
      })
    }
  })

  test('a snapshot that does not match the expected one is REVISION_CONFLICT with outcome unknown', async () => {
    const { document, decisions } = await historyFixture()
    const decision = decisions.find(entry => entry.name === 'accept-insert')!
    const parsed = parseHistoryOtChanges(document.rawSnapshot as HistorySnapshot, DOC)
    // The text is as expected, but the insert is still tracked.
    const after = historyDocument(document.rawSnapshot as HistorySnapshot, document.version + 1, document.content)
    const h = harness({ joins: [document, after] })
    const error = await rejection(h.api.manageTrackedChanges(decide(document, 'accept', [parsed[0]!.changeId], 1)))
    expect(error).toMatchObject({ code: 'REVISION_CONFLICT', details: { outcome: 'unknown' } })
    expect(decision.expectedVisibleContent).toBe(document.content)
  })
})

describe('an unconfirmed decision is observed, never resent', () => {
  const timeout = (): McpError => new McpError('TIMEOUT', 'Timed out.', { retryable: true })

  interface Scenario {
    name: string
    /** The document as read before the decision. */
    document: JoinedDocument
    action: 'accept' | 'reject'
    ids: string[]
    /** Fails the submission as given. */
    fail: Partial<HarnessOptions>
    target: (document: JoinedDocument) => JoinedDocument
    other: (document: JoinedDocument) => JoinedDocument
    sent: (h: ReturnType<typeof harness>) => unknown
  }

  async function scenarios(): Promise<Scenario[]> {
    const { document: share } = await shareFixture()
    const rest = {
      document: share,
      action: 'accept' as const,
      ids: ['change-1', 'change-2'],
      target: (document: JoinedDocument) => withoutChanges(document, ['change-1', 'change-2']),
      // One accepted and one not: neither state.
      other: (document: JoinedDocument) => withoutChanges(document, ['change-1']),
      sent: (h: ReturnType<typeof harness>) => h.http.request,
    }
    const ot = {
      document: share,
      action: 'reject' as const,
      ids: ['change-1'],
      target: (document: JoinedDocument) =>
        shareDocument(document.content.replace('INSERTED ', ''), document.version + 1, []),
      other: (document: JoinedDocument) => shareDocument(`${document.content}x`, document.version + 1, []),
      sent: (h: ReturnType<typeof harness>) => h.connection.submitUpdate,
    }
    // History-OT decisions are told apart by their canonical snapshot. An accepted insert leaves
    // the visible text as it was, so only the snapshot shows it applied.
    const history = await historyFixture()
    const snapshot = history.document.rawSnapshot as HistorySnapshot
    const parsed = parseHistoryOtChanges(snapshot, DOC)
    const historyOt = (name: string) => {
      const decision = history.decisions.find(entry => entry.name === name)!
      return {
        document: history.document,
        action: decision.action,
        ids: decision.changes.map(
          index => parsed.find(change => change.rawPos === snapshot.trackedChanges![index]!.range.pos)!.changeId
        ),
        target: (document: JoinedDocument) =>
          historyDocument(decision.expectedSnapshot, document.version + 1, decision.expectedVisibleContent),
        other: (document: JoinedDocument) =>
          historyDocument(
            { ...decision.expectedSnapshot, content: `${decision.expectedSnapshot.content}x` },
            document.version + 1,
            `${decision.expectedVisibleContent}x`
          ),
        sent: (h: ReturnType<typeof harness>) => h.connection.submitUpdate,
      }
    }
    return [
      {
        ...rest,
        name: 'REST accept that timed out',
        fail: {
          request: async () => {
            throw timeout()
          },
        },
      },
      {
        ...rest,
        name: 'REST accept answered with a server error',
        fail: {
          request: async () => {
            throw new McpError('REMOTE_ERROR', 'Overleaf returned HTTP 502.', { details: { status: 502 } })
          },
        },
      },
      {
        ...rest,
        name: 'REST accept whose connection failed',
        fail: {
          request: async () => {
            throw new McpError('REMOTE_ERROR', 'Overleaf request failed: POST', { retryable: true })
          },
        },
      },
      {
        ...ot,
        name: 'OT reject that timed out',
        fail: {
          submitUpdate: async () => {
            throw timeout()
          },
        },
      },
      {
        ...ot,
        name: 'OT reject whose socket was lost',
        fail: {
          submitUpdate: async () => {
            throw new McpError('OUTCOME_UNKNOWN', 'The Overleaf socket failed after the OT update was sent.')
          },
        },
      },
      {
        ...historyOt('accept-insert'),
        name: 'history-OT accept that timed out',
        fail: {
          submitUpdate: async () => {
            throw timeout()
          },
        },
      },
      {
        ...historyOt('reject-delete'),
        name: 'history-OT reject whose socket was lost',
        fail: {
          submitUpdate: async () => {
            throw new McpError('OUTCOME_UNKNOWN', 'The Overleaf socket failed after the OT update was sent.')
          },
        },
      },
    ]
  }

  test('the target state seen returns the result with recoveredAfterTimeout', async () => {
    for (const scenario of await scenarios()) {
      const { document } = scenario
      // The first observation still shows the original state, the second the decision.
      const h = harness({ ...scenario.fail, joins: [document, document, scenario.target(document)] })
      const result = await h.api.manageTrackedChanges(
        decide(document, scenario.action, scenario.ids, scenario.ids.length)
      )
      expect(result, scenario.name).toMatchObject({ recoveredAfterTimeout: true, changeIds: scenario.ids })
      expect(scenario.sent(h), scenario.name).toHaveBeenCalledOnce()
      expect(h.connections.invalidate, scenario.name).toHaveBeenCalledOnce()
    }
  })

  test('the original state live through the window is not_applied', async () => {
    for (const scenario of await scenarios()) {
      const { document } = scenario
      const h = harness({ ...scenario.fail, joins: [document, ...Array.from({ length: 500 }, () => document)] })
      const error = await rejection(
        h.api.manageTrackedChanges(decide(document, scenario.action, scenario.ids, scenario.ids.length))
      )
      const timedOut = scenario.name.includes('timed out')
      expect(error, scenario.name).toMatchObject({
        code: timedOut ? 'TIMEOUT' : 'REMOTE_ERROR',
        retryable: false,
        details: { outcome: 'not_applied' },
      })
      expect(scenario.sent(h), scenario.name).toHaveBeenCalledOnce()
    }
  })

  test('a third state is REVISION_CONFLICT with outcome unknown', async () => {
    for (const scenario of await scenarios()) {
      const { document } = scenario
      const h = harness({ ...scenario.fail, joins: [document, scenario.other(document)] })
      const error = await rejection(
        h.api.manageTrackedChanges(decide(document, scenario.action, scenario.ids, scenario.ids.length))
      )
      expect(error, scenario.name).toMatchObject({
        code: 'REVISION_CONFLICT',
        retryable: false,
        details: { outcome: 'unknown' },
      })
      expect(scenario.sent(h), scenario.name).toHaveBeenCalledOnce()
    }
  })

  test('nothing observed is OUTCOME_UNKNOWN', async () => {
    for (const scenario of await scenarios()) {
      const { document } = scenario
      // Every observation fails: the join queue holds only the first read.
      const h = harness({ ...scenario.fail, joins: [document] })
      const error = await rejection(
        h.api.manageTrackedChanges(decide(document, scenario.action, scenario.ids, scenario.ids.length))
      )
      expect(error.code, scenario.name).toBe('OUTCOME_UNKNOWN')
      expect(scenario.sent(h), scenario.name).toHaveBeenCalledOnce()
    }
  })

  test('an acknowledged decision whose verification read failed is never reported not applied', async () => {
    const { document } = await shareFixture()
    const failedRead = new McpError('REMOTE_ERROR', 'Overleaf refused to open the document.')
    // Acknowledged, then the original state is seen for the whole window.
    const stuck = harness({ joins: [document, failedRead, ...Array.from({ length: 500 }, () => document)] })
    const error = await rejection(stuck.api.manageTrackedChanges(decide(document, 'accept', ['change-1'], 1)))
    expect(error).toMatchObject({ code: 'OUTCOME_UNKNOWN', retryable: false })
    expect(stuck.http.request).toHaveBeenCalledOnce()

    // Acknowledged, and the decision is seen on observation.
    const seen = harness({ joins: [document, failedRead, withoutChanges(document, ['change-1'])] })
    const result = await seen.api.manageTrackedChanges(decide(document, 'accept', ['change-1'], 1))
    expect(result).toMatchObject({ recoveredAfterTimeout: true, remainingChangeCount: 4 })
  })

  test('a definite OT refusal is reported as it is, without observing', async () => {
    const { document } = await shareFixture()
    const h = harness({
      joins: [document],
      submitUpdate: async () => {
        throw new McpError('REMOTE_ERROR', 'Overleaf refused the OT update.', { details: { reason: 'unrecognized' } })
      },
    })
    const error = await rejection(h.api.manageTrackedChanges(decide(document, 'reject', ['change-1'], 1)))
    expect(error).toMatchObject({ code: 'REMOTE_ERROR', details: { reason: 'unrecognized' } })
    expect(h.connections.invalidate).not.toHaveBeenCalled()
  })
})
