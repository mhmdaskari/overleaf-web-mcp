import { EventEmitter } from 'node:events'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, test } from 'vitest'

import { readConfig } from '../../src/config.js'
import { createRevision } from '../../src/core/revision.js'
import type { HistorySnapshot } from '../../src/protocol/ot.js'
import { ProjectConnection, type SocketPeerLike } from '../../src/protocol/project-connection.js'
import { parseSocketPacket } from '../../src/protocol/socketio09-codec.js'
import { parseHistoryOtChanges } from '../../src/protocol/tracked-changes.js'
import { OverleafRuntime } from '../../src/runtime.js'
import { createOverleafService } from '../../src/service/operations.js'
import { expectGolden } from '../helpers/golden.js'
import { applyShareJs } from '../helpers/overleaf-socket.js'
import { BOOTSTRAP_PAGE, cookieJar } from '../helpers/runtime.js'

// Tracked-change results through the real domain classes, over a fake Overleaf seeded from the two
// tracked-change fixtures. It encodes ShareJS lines and range text as Overleaf does, applies the
// reject components it receives, and takes a history-OT decision only as the fixture's operation.

const PROJECT = 'project'
const SHAREJS_DOC = 'DOC'
const HISTORY_DOC = 'HDOC'

interface ShareJsChange {
  id?: string
  op: { p: number; i?: string; d?: string }
  metadata: unknown
}

interface HistoryDecision {
  name: string
  action: 'accept' | 'reject'
  changes: number[]
  textOperation: unknown[]
  expectedSnapshot: HistorySnapshot
}

interface ServerState {
  sharejs: { version: number; content: string; changes: ShareJsChange[] }
  history: { version: number; snapshot: HistorySnapshot }
  decisions: HistoryDecision[]
  /** The first accept request waits for its timeout, after Overleaf applied it. */
  acceptTimesOut: boolean
  rangesStatus: 200 | 404
  rangesIndex: unknown
  /** Each request after the bootstrap, as `METHOD /path`. */
  requests: string[]
  /** Each OT update received. */
  updates: unknown[]
}

const latin1 = (text: string): string => Buffer.from(text, 'utf8').toString('latin1')

function ackArgs(frame: string): unknown[] {
  const packet = parseSocketPacket(frame)
  if (packet.type !== 'ack') throw new Error('expected an ack frame')
  return packet.args
}

const decode = (text: string): string => Buffer.from(text, 'latin1').toString('utf8')

async function server(): Promise<ServerState> {
  const read = async <T>(name: string): Promise<T> =>
    JSON.parse(await readFile(new URL(`../fixtures/protocol/${name}`, import.meta.url), 'utf8')) as T
  const sharejs = await read<{ joinDocAck: string; rangesIndex: Array<{ id: string; ranges: unknown }> }>(
    'sharejs-tracked-changes.json'
  )
  const history = await read<{ joinDocAck: string; decisions: HistoryDecision[] }>('history-ot-tracked-changes.json')
  const [, lines, version, , ranges] = ackArgs(sharejs.joinDocAck) as [
    null,
    string[],
    number,
    unknown,
    { changes: ShareJsChange[] },
  ]
  const [, snapshot, historyVersion] = ackArgs(history.joinDocAck) as [null, HistorySnapshot, number]
  return {
    sharejs: {
      version,
      content: lines.map(decode).join('\n'),
      changes: ranges.changes.map(change => ({
        ...change,
        op: {
          p: change.op.p,
          ...(change.op.i === undefined ? {} : { i: decode(change.op.i) }),
          ...(change.op.d === undefined ? {} : { d: decode(change.op.d) }),
        },
      })),
    },
    history: { version: historyVersion, snapshot },
    decisions: history.decisions,
    acceptTimesOut: false,
    rangesStatus: 200,
    // The fixture's index, with the history-OT document listed too, as Overleaf may list it.
    rangesIndex: [...sharejs.rangesIndex, { id: HISTORY_DOC, ranges: { changes: [{ id: 'random' }] } }],
    requests: [],
    updates: [],
  }
}

/** Applies ShareJS reject components: each removes the change it undoes and shifts the others. */
function applyReject(state: ServerState['sharejs'], op: Array<{ p: number; i?: string; d?: string }>): void {
  state.content = applyShareJs(state.content, op)
  for (const component of op) {
    const text = component.d ?? component.i ?? ''
    const undone = state.changes.findIndex(change =>
      component.d !== undefined
        ? change.op.p === component.p && change.op.i === component.d
        : change.op.p === component.p && change.op.d === component.i
    )
    if (undone < 0) throw new Error('a reject component that undoes no change')
    state.changes.splice(undone, 1)
    for (const change of state.changes) {
      if (change.op.p > component.p) change.op.p += component.d !== undefined ? -text.length : text.length
    }
  }
}

class FakePeer extends EventEmitter implements SocketPeerLike {
  closed = false

  constructor(readonly state: ServerState) {
    super()
  }

  async call(name: string, args: unknown[]): Promise<unknown[]> {
    await Promise.resolve()
    if (name === 'leaveDoc') return [null]
    if (name === 'joinDoc') {
      const [docId] = args as [string]
      if (docId === HISTORY_DOC) {
        const { version, snapshot } = this.state.history
        return [null, structuredClone(snapshot), version, [], {}, 'history-ot', { canSkipLeaveDoc: true }]
      }
      const { version, content, changes } = this.state.sharejs
      const ranges = {
        changes: changes.map(change => ({
          ...change,
          op: {
            p: change.op.p,
            ...(change.op.i === undefined ? {} : { i: latin1(change.op.i) }),
            ...(change.op.d === undefined ? {} : { d: latin1(change.op.d) }),
          },
        })),
        comments: [],
      }
      return [null, content.split('\n').map(latin1), version, [], ranges, 'sharejs-text-ot', { canSkipLeaveDoc: true }]
    }
    if (name === 'applyOtUpdate') {
      const [docId, update] = args as [string, { v: number; op: unknown[]; meta?: unknown }]
      this.state.updates.push(structuredClone(update))
      if (update.meta !== undefined) return ['a decision carries no tracking metadata']
      if (docId === HISTORY_DOC) {
        if (update.v !== this.state.history.version) return ['version mismatch']
        const [{ textOperation }] = update.op as [{ textOperation: unknown[] }]
        const decision = this.state.decisions.find(
          entry => JSON.stringify(entry.textOperation) === JSON.stringify(textOperation)
        )
        if (decision === undefined) return ['not a fixture operation']
        this.state.history = { version: update.v + 1, snapshot: structuredClone(decision.expectedSnapshot) }
      } else {
        if (update.v !== this.state.sharejs.version) return ['version mismatch']
        applyReject(this.state.sharejs, update.op as Array<{ p: number; i?: string; d?: string }>)
        this.state.sharejs.version += 1
      }
      setImmediate(() => this.emit('otUpdateApplied', { doc: docId, v: update.v }))
      return [null]
    }
    throw new Error(`unexpected socket call ${name}`)
  }

  close(): void {
    this.closed = true
  }
}

async function abortion(signal: AbortSignal | null | undefined): Promise<never> {
  return await new Promise<never>((_, reject) => {
    signal?.addEventListener('abort', () => reject(signal.reason as Error), { once: true })
  })
}

async function withService(
  state: ServerState,
  run: (service: ReturnType<typeof createOverleafService>) => Promise<void>
): Promise<void> {
  const { cookiePath, directory } = await cookieJar()
  const runtime = await OverleafRuntime.create(
    readConfig({
      OVERLEAF_COOKIE_JAR_FILE: cookiePath,
      OVERLEAF_BASE_URL: 'https://overleaf.test',
      OVERLEAF_BROWSER_PROFILE_DIR: join(directory, 'profile'),
      OVERLEAF_RECOVERY_TIMEOUT_MS: '5000',
      OVERLEAF_REQUEST_TIMEOUT_MS: state.acceptTimesOut ? '100' : '5000',
    }),
    {
      fetcher: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input))
        const method = init?.method ?? 'GET'
        if (method === 'GET' && url.pathname === '/project') return new Response(BOOTSTRAP_PAGE)
        state.requests.push(`${method} ${url.pathname}`)
        if (method === 'GET' && url.pathname === `/project/${PROJECT}/ranges`) {
          if (state.rangesStatus === 404) return new Response('Not Found', { status: 404 })
          return new Response(JSON.stringify(state.rangesIndex), { headers: { 'content-type': 'application/json' } })
        }
        if (method === 'POST' && url.pathname === `/project/${PROJECT}/doc/${SHAREJS_DOC}/changes/accept`) {
          expect(new Headers(init?.headers).get('x-csrf-token')).toBe('csrf')
          const { change_ids: ids } = JSON.parse(String(init?.body)) as { change_ids: string[] }
          state.sharejs.changes = state.sharejs.changes.filter(change => !ids.includes(change.id ?? ''))
          if (state.acceptTimesOut) {
            state.acceptTimesOut = false
            return await abortion(init?.signal)
          }
          return new Response(null, { status: 204 })
        }
        throw new Error(`unexpected ${method} ${url.pathname}`)
      },
      connectionFactory: async projectId =>
        new ProjectConnection({
          projectId,
          peer: new FakePeer(state),
          join: {
            publicId: 'public-a',
            project: {
              _id: projectId,
              rootFolder: [
                {
                  _id: 'root',
                  name: 'rootFolder',
                  docs: [
                    { _id: SHAREJS_DOC, name: 'main.tex' },
                    { _id: HISTORY_DOC, name: 'history.tex' },
                  ],
                  fileRefs: [],
                  folders: [],
                },
              ],
              trackChangesState: true,
              features: { trackChanges: true, trackChangesVisible: true },
            },
            permissionsLevel: 'owner',
            protocolVersion: 2,
          },
          supportedProtocolVersions: [2],
          callTimeoutMs: 5_000,
          applyTimeoutMs: 5_000,
        }),
    }
  )
  try {
    await run(createOverleafService(runtime))
  } finally {
    await runtime.close()
    await rm(directory, { recursive: true, force: true })
  }
}

function shareRevision(state: ServerState): string {
  return createRevision({
    projectId: PROJECT,
    docId: SHAREJS_DOC,
    protocol: 'sharejs',
    otVersion: state.sharejs.version,
    content: state.sharejs.content,
  })
}

describe('list_tracked_changes golden results', () => {
  test('one ShareJS document by filePath', async () => {
    const state = await server()
    await withService(state, async service => {
      const result = await service.list_tracked_changes({ projectId: PROJECT, filePath: 'main.tex' })
      expectGolden('list_tracked_changes', result)
      expect(JSON.stringify(result)).not.toMatch(/email/iu)
    })
    expect(state.requests).toEqual([])
  })

  test('every document the range index lists, with a type filter, a limit, and short excerpts', async () => {
    const state = await server()
    await withService(state, async service => {
      const result = await service.list_tracked_changes({
        projectId: PROJECT,
        type: 'insert',
        limit: 4,
        excerptChars: 4,
      })
      expectGolden('list_tracked_changes', result)
      expect(result).toMatchObject({ truncated: true })
    })
    expect(state.requests).toEqual([`GET /project/${PROJECT}/ranges`])
  })

  test('a history-OT document by filePath, its ids made up from the changes', async () => {
    const state = await server()
    await withService(state, async service => {
      expectGolden(
        'list_tracked_changes',
        await service.list_tracked_changes({ projectId: PROJECT, filePath: 'history.tex' })
      )
    })
  })

  test('no range index: indexUnavailable and no document read', async () => {
    const state = await server()
    state.rangesStatus = 404
    await withService(state, async service => {
      expectGolden('list_tracked_changes', await service.list_tracked_changes({ projectId: PROJECT }))
    })
  })
})

describe('manage_tracked_changes golden results', () => {
  test('accepts a ShareJS replacement through the accept route', async () => {
    const state = await server()
    const revision = shareRevision(state)
    await withService(state, async service => {
      const result = await service.manage_tracked_changes({
        projectId: PROJECT,
        filePath: 'main.tex',
        revision,
        action: 'accept',
        changeIds: ['change-3', 'change-4'],
        confirmCount: 2,
      })
      expectGolden('manage_tracked_changes', result)
      // An accept leaves the text and the version, so the revision is unchanged.
      expect(result.revision).toBe(revision)
    })
    expect(state.requests).toEqual([`POST /project/${PROJECT}/doc/${SHAREJS_DOC}/changes/accept`])
    expect(state.updates).toEqual([])
  })

  test('rejects ShareJS changes, non-ASCII included, in one untracked update', async () => {
    const state = await server()
    await withService(state, async service => {
      expectGolden(
        'manage_tracked_changes',
        await service.manage_tracked_changes({
          projectId: PROJECT,
          filePath: 'main.tex',
          revision: shareRevision(state),
          action: 'reject',
          changeIds: ['change-5', 'change-3', 'change-4', 'change-1'],
          confirmCount: 4,
        })
      )
    })
    expect(state.updates).toEqual([
      {
        doc: SHAREJS_DOC,
        v: 6,
        op: [
          { p: 11, d: 'INSERTED ', u: true },
          { p: 38, d: 'new', u: true },
          { p: 38, i: 'old', u: true },
          { p: 59, d: 'über ', u: true },
        ],
      },
    ])
    expect(state.sharejs.content).toBe('Alpha beta gamma.\nRemove now.\nReplace old here.\nNaïve café text.\n')
    expect(state.sharejs.changes.map(change => change.id)).toEqual(['change-2'])
    expect(state.requests).toEqual([])
  })

  test('a ShareJS accept that timed out after Overleaf applied it is recovered, never resent', async () => {
    const state = await server()
    state.acceptTimesOut = true
    await withService(state, async service => {
      const result = await service.manage_tracked_changes({
        projectId: PROJECT,
        filePath: 'main.tex',
        revision: shareRevision(state),
        action: 'accept',
        changeIds: ['change-1'],
        confirmCount: 1,
      })
      expectGolden('manage_tracked_changes', result)
      expect(result.recoveredAfterTimeout).toBe(true)
    })
    expect(state.requests).toEqual([`POST /project/${PROJECT}/doc/${SHAREJS_DOC}/changes/accept`])
  })

  for (const name of ['accept-replacement-pair', 'reject-non-ascii-and-astral']) {
    test(`decides history-OT changes with the fixture operation: ${name}`, async () => {
      const state = await server()
      const decision = state.decisions.find(entry => entry.name === name)!
      const parsed = parseHistoryOtChanges(state.history.snapshot, HISTORY_DOC)
      const changeIds = decision.changes.map(
        index =>
          parsed.find(change => change.rawPos === state.history.snapshot.trackedChanges![index]!.range.pos)!.changeId
      )
      // The revision is the one listing returns, as a caller would take it.
      let revision = ''
      await withService(state, async service => {
        const listed = await service.list_tracked_changes({ projectId: PROJECT, filePath: 'history.tex' })
        revision = listed.documents[0]!.revision
      })
      await withService(state, async service => {
        expectGolden(
          'manage_tracked_changes',
          await service.manage_tracked_changes({
            projectId: PROJECT,
            filePath: 'history.tex',
            revision,
            action: decision.action,
            changeIds,
            confirmCount: changeIds.length,
          })
        )
      })
      expect(state.updates).toEqual([{ doc: HISTORY_DOC, v: 12, op: [{ textOperation: decision.textOperation }] }])
      expect(state.history.snapshot).toEqual(decision.expectedSnapshot)
    })
  }
})
