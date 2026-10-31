import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'

import { describe, expect, test, vi } from 'vitest'

import { createRevision } from '../../src/core/revision.js'
import { CommentsApi } from '../../src/overleaf/comments.js'
import { ProjectConnection } from '../../src/protocol/project-connection.js'
import { parseSocketPacket } from '../../src/protocol/socketio09-codec.js'

interface ShareJsFixture {
  joinDocAck: string
  rangesIndex: unknown
}

interface WireState {
  lines: string[]
  version: number
  ranges: { comments: Array<Record<string, unknown>>; changes: unknown[] }
}

const latin1 = (text: string): string => Buffer.from(text, 'utf8').toString('latin1')

/**
 * Answers joinDoc as Overleaf does with `encodeRanges`, comment text included, and stores each
 * comment an update attaches in the same encoded form.
 */
class FakeDocumentPeer extends EventEmitter {
  readonly close = vi.fn()
  readonly updates: unknown[] = []

  constructor(readonly state: WireState) {
    super()
  }

  readonly call = vi.fn(async (name: string, args: unknown[]): Promise<unknown[]> => {
    if (name === 'joinDoc') {
      const { lines, version, ranges } = structuredClone(this.state)
      return [null, lines, version, [], ranges, 'sharejs-text-ot', { canSkipLeaveDoc: true }]
    }
    if (name === 'leaveDoc') return [null]
    if (name === 'applyOtUpdate') {
      const update = args[1] as { doc: string; v: number; op: Array<{ p: number; c?: string; t?: string }> }
      this.updates.push(structuredClone(update))
      for (const component of update.op) {
        if (component.c === undefined || component.t === undefined) throw new Error('only comments are expected')
        this.state.ranges.comments.push({
          id: component.t,
          op: { c: latin1(component.c), p: component.p, t: component.t },
          metadata: METADATA,
        })
      }
      this.state.version += 1
      setImmediate(() => this.emit('otUpdateApplied', { doc: update.doc, v: update.v }))
      return [null]
    }
    throw new Error(`unexpected call ${name}`)
  })
}

async function fixtureWire(): Promise<{ state: WireState; rangesIndex: unknown }> {
  const share = JSON.parse(
    await readFile(new URL('../fixtures/protocol/sharejs-tracked-changes.json', import.meta.url), 'utf8')
  ) as ShareJsFixture
  const packet = parseSocketPacket(share.joinDocAck)
  if (packet.type !== 'ack') throw new Error('expected an ack frame')
  const [, lines, version, , ranges] = packet.args as [null, string[], number, unknown[], WireState['ranges']]
  return { state: { lines, version, ranges }, rangesIndex: share.rangesIndex }
}

const METADATA = { user_id: 'USER', ts: '2026-01-01T00:00:00.000Z' }
const ASTRAL_CONTENT = 'Head\na😀 b😀c end\n'

/** A hand-built document with an astral character before a tracked insert and a comment. */
function astralWire(): { state: WireState; rangesIndex: unknown } {
  const ranges = (encode: (text: string) => string) => ({
    comments: [{ id: 'thread-1', op: { c: encode('😀 b'), p: 6, t: 'thread-1' }, metadata: METADATA }],
    changes: [{ id: 'change-1', op: { p: 9, i: encode('b😀') }, metadata: METADATA }],
  })
  return {
    state: { lines: ['Head', 'a😀 b😀c end', ''].map(latin1), version: 3, ranges: ranges(latin1) },
    rangesIndex: [{ id: 'DOC', ranges: ranges(text => text) }],
  }
}

async function harness(wire?: { state: WireState; rangesIndex: unknown }) {
  const { state, rangesIndex } = wire ?? (await fixtureWire())
  const peer = new FakeDocumentPeer(state)
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
    callTimeoutMs: 1_000,
    applyTimeoutMs: 1_000,
  })
  const connections = {
    withConnection: async <T>(_projectId: string, operation: (value: ProjectConnection) => Promise<T>) =>
      await operation(connection),
    invalidate: vi.fn(async () => undefined),
  }
  const message = (content: string) => ({
    messages: [{ id: `m-${content}`, content, timestamp: Date.UTC(2026, 0, 1), user_id: 'USER' }],
  })
  const http = {
    getJson: vi.fn(async (path: string) => {
      if (path.endsWith('/threads')) {
        return {
          'thread-1': message('first'),
          ...(http.postJson.mock.calls.length > 0 ? { 'thread-2': message('second') } : {}),
        }
      }
      if (path.endsWith('/ranges')) return rangesIndex
      throw new Error(`unexpected GET ${path}`)
    }),
    postJson: vi.fn(async () => ({})),
    deleteJson: vi.fn(async () => ({})),
  }
  const api = new CommentsApi(http, connections, {
    threadIdFactory: () => 'thread-2',
    recoveryTimeoutMs: 50,
    recoveryPollIntervalMs: 0,
  })
  return { api, peer, http, connections }
}

describe('comment ranges over non-ASCII text', () => {
  test('list_comments reads the end and quote of a joined comment from its decoded text', async () => {
    const { api } = await harness()

    const result = await api.listComments('project', { filePath: 'main.tex' })

    expect(result.threads).toEqual([
      expect.objectContaining({
        id: 'thread-1',
        filePath: 'main.tex',
        start: { line: 4, column: 1 },
        end: { line: 4, column: 11 },
        quotedText: 'Naïve café',
      }),
    ])
  })

  test('the plain UTF-8 ranges index selects the same range without being decoded again', async () => {
    const { api, peer } = await harness()

    const result = await api.listComments('project')

    expect(result.positionsUnavailable).toBe(false)
    expect(result.threads).toEqual([
      expect.objectContaining({
        id: 'thread-1',
        start: { line: 4, column: 1 },
        end: { line: 4, column: 11 },
        quotedText: 'Naïve café',
      }),
    ])
    expect(peer.call.mock.calls.filter(([name]) => name === 'joinDoc')).toHaveLength(1)
  })

  test('add_comment verifies an attachment on non-ASCII text', async () => {
    const { api, peer, connections } = await harness()
    const before = await api.listComments('project', { filePath: 'main.tex' })
    expect(before.threads).toHaveLength(1)
    const content = 'Alpha beta INSERTED gamma.\nRemove now.\nReplace new here.\nNaïve café über text.\n'
    const revision = createRevision({
      projectId: 'project',
      docId: 'DOC',
      protocol: 'sharejs',
      otVersion: 6,
      content,
    })

    const result = await api.addComment({
      projectId: 'project',
      filePath: 'main.tex',
      revision,
      start: { line: 4, column: 7 },
      end: { line: 4, column: 16 },
      expectedText: 'café über',
      content: 'second',
    })

    expect(result).toMatchObject({ threadId: 'thread-2', protocol: 'sharejs' })
    expect(result).not.toHaveProperty('recoveredAfterTimeout')
    expect(peer.updates).toEqual([{ doc: 'DOC', v: 6, op: [{ p: 63, c: 'café über', t: 'thread-2' }] }])
    expect(connections.invalidate).not.toHaveBeenCalled()

    const after = await api.listComments('project', { filePath: 'main.tex' })
    expect(after.threads).toEqual([
      expect.objectContaining({ id: 'thread-1', end: { line: 4, column: 11 }, quotedText: 'Naïve café' }),
      expect.objectContaining({
        id: 'thread-2',
        start: { line: 4, column: 7 },
        end: { line: 4, column: 16 },
        quotedText: 'café über',
      }),
    ])
  })

  test('list_comments and add_comment count an astral character as two UTF-16 units', async () => {
    const { api, peer } = await harness(astralWire())
    const listed = expect.objectContaining({
      id: 'thread-1',
      filePath: 'main.tex',
      start: { line: 2, column: 2 },
      end: { line: 2, column: 6 },
      quotedText: '😀 b',
    })

    expect((await api.listComments('project', { filePath: 'main.tex' })).threads).toEqual([listed])
    expect((await api.listComments('project')).threads).toEqual([listed])

    const result = await api.addComment({
      projectId: 'project',
      filePath: 'main.tex',
      revision: createRevision({
        projectId: 'project',
        docId: 'DOC',
        protocol: 'sharejs',
        otVersion: 3,
        content: ASTRAL_CONTENT,
      }),
      start: { line: 2, column: 5 },
      end: { line: 2, column: 9 },
      expectedText: 'b😀c',
      content: 'second',
    })

    expect(result).toMatchObject({ threadId: 'thread-2', protocol: 'sharejs' })
    expect(peer.updates).toEqual([{ doc: 'DOC', v: 3, op: [{ p: 9, c: 'b😀c', t: 'thread-2' }] }])
    expect(peer.state.ranges.comments.at(-1)).toMatchObject({ op: { c: latin1('b😀c'), p: 9 } })
    expect((await api.listComments('project', { filePath: 'main.tex' })).threads).toEqual([
      listed,
      expect.objectContaining({
        id: 'thread-2',
        start: { line: 2, column: 5 },
        end: { line: 2, column: 9 },
        quotedText: 'b😀c',
      }),
    ])
  })
})
