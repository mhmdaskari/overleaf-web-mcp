import { EventEmitter } from 'node:events'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, test } from 'vitest'

import { readConfig } from '../../src/config.js'
import { createRevision, type OtProtocol } from '../../src/core/revision.js'
import type { HistorySnapshot } from '../../src/protocol/ot.js'
import { ProjectConnection, type SocketPeerLike } from '../../src/protocol/project-connection.js'
import { OverleafRuntime } from '../../src/runtime.js'
import { createOverleafService } from '../../src/service/operations.js'
import { expectGolden } from '../helpers/golden.js'
import { BOOTSTRAP_PAGE, cookieJar } from '../helpers/runtime.js'

const PROJECT = 'project-a'
const DOC = 'doc-a'
const THREAD = 'thread-a'
const CONTENT = 'First line.\nSecond line.'
// "Second", the text the comment is anchored to.
const ANCHOR = { pos: 12, length: 6 }

/**
 * How the fake server answers the status change. `unacknowledged` acks applyOtUpdate but never
 * sends otUpdateApplied; `socket-lost` applies the update and then fails the call, as a socket
 * that closes after sending does; `verification-read-fails` applies and acknowledges the OT update
 * or ShareJS REST action, then refuses the next joinDoc; `request-timeout` applies a ShareJS REST
 * action and lets the request time out.
 */
type Outcome = 'acknowledged' | 'unacknowledged' | 'socket-lost' | 'verification-read-fails' | 'request-timeout'

interface ServerState {
  protocol: OtProtocol
  version: number
  resolved: boolean
  /** False once the anchored text was deleted: history-OT keeps the comment with no range. */
  anchored: boolean
  trackChanges: boolean
  outcome: Outcome
  failNextJoin: boolean
  /** Each ShareJS REST status action Overleaf received, in order. */
  restActions: string[]
}

function server(protocol: OtProtocol, overrides: Partial<ServerState> = {}): ServerState {
  return {
    protocol,
    version: 4,
    resolved: false,
    anchored: true,
    trackChanges: false,
    outcome: 'acknowledged',
    failNextJoin: false,
    restActions: [],
    ...overrides,
  }
}

function joinReply(state: ServerState): unknown[] {
  if (state.protocol === 'history-ot') {
    // Overleaf writes resolved: true for a resolved comment and leaves the key out for an open one.
    const snapshot: HistorySnapshot = {
      content: CONTENT,
      comments: [{ id: THREAD, ranges: state.anchored ? [ANCHOR] : [], ...(state.resolved ? { resolved: true } : {}) }],
      trackedChanges: [],
    }
    return [null, snapshot, state.version, null, {}, 'history-ot']
  }
  // A ShareJS range carries no status; it is read from the REST thread.
  const comments = state.anchored
    ? [{ id: THREAD, op: { p: ANCHOR.pos, c: CONTENT.slice(ANCHOR.pos, ANCHOR.pos + ANCHOR.length), t: THREAD } }]
    : []
  return [null, CONTENT.split('\n'), state.version, null, { comments, changes: [] }, 'sharejs-text-ot']
}

/** A project socket over the shared server state, applying history-OT comment status updates. */
class FakePeer extends EventEmitter implements SocketPeerLike {
  closed = false

  constructor(readonly state: ServerState) {
    super()
  }

  async call(name: string, args: unknown[]): Promise<unknown[]> {
    await Promise.resolve()
    if (name === 'leaveDoc') return [null]
    if (name === 'joinDoc') {
      if (this.state.failNextJoin) {
        this.state.failNextJoin = false
        return ['refused']
      }
      return joinReply(this.state)
    }
    if (name === 'applyOtUpdate') {
      const [docId, update] = args as [string, { v: number; op: Array<{ commentId: string; resolved: boolean }> }]
      if (docId !== DOC || update.v !== this.state.version) return ['version mismatch']
      for (const component of update.op) {
        if (component.commentId === THREAD) this.state.resolved = component.resolved
      }
      this.state.version += 1
      if (this.state.outcome === 'socket-lost') {
        this.closed = true
        throw new Error('socket closed')
      }
      if (this.state.outcome === 'verification-read-fails') this.state.failNextJoin = true
      if (this.state.outcome !== 'unacknowledged') {
        setImmediate(() => this.emit('otUpdateApplied', { doc: docId, v: update.v }))
      }
      return [null]
    }
    throw new Error(`unexpected socket call ${name}`)
  }

  close(): void {
    this.closed = true
  }
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
}

// The shape Overleaf's /threads route sends, a user's name and email included.
function threadsReply(state: ServerState): unknown {
  const user = { id: 'user-b', first_name: 'Placeholder', last_name: 'Reviewer', email: 'reviewer@example.test' }
  return {
    [THREAD]: {
      messages: [
        { id: 'message-a', content: 'Placeholder comment.', timestamp: Date.UTC(2026, 0, 1), user_id: 'user-b', user },
      ],
      ...(state.resolved
        ? { resolved: true, resolved_at: '2026-01-02T00:00:00.000Z', resolved_by_user_id: 'user-b', resolved_by_user: user }
        : {}),
    },
  }
}

async function abortion(signal: AbortSignal | null | undefined): Promise<never> {
  return await new Promise<never>((_, reject) => {
    signal?.addEventListener('abort', () => reject(signal.reason as Error), { once: true })
  })
}

async function withRuntime(
  state: ServerState,
  run: (service: ReturnType<typeof createOverleafService>) => Promise<void>
): Promise<void> {
  const { cookiePath, directory } = await cookieJar()
  const statusPath = new RegExp(`^/project/${PROJECT}/doc/${DOC}/thread/${THREAD}/(resolve|reopen)$`, 'u')
  const runtime = await OverleafRuntime.create(
    readConfig({
      OVERLEAF_COOKIE_JAR_FILE: cookiePath,
      OVERLEAF_BASE_URL: 'https://overleaf.test',
      OVERLEAF_BROWSER_PROFILE_DIR: join(directory, 'profile'),
      OVERLEAF_RECOVERY_TIMEOUT_MS: '5000',
      OVERLEAF_REQUEST_TIMEOUT_MS: state.outcome === 'request-timeout' ? '100' : '5000',
    }),
    {
      fetcher: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input))
        const method = init?.method ?? 'GET'
        if (method === 'GET' && url.pathname === '/project') return new Response(BOOTSTRAP_PAGE)
        if (method === 'GET' && url.pathname === `/project/${PROJECT}/threads`) return json(threadsReply(state))
        const action = statusPath.exec(url.pathname)?.[1]
        if (method === 'POST' && action !== undefined && state.protocol === 'sharejs') {
          state.restActions.push(action)
          state.resolved = action === 'resolve'
          if (state.outcome === 'request-timeout') return await abortion(init?.signal)
          if (state.outcome === 'verification-read-fails') state.failNextJoin = true
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
              rootFolder: [{ _id: 'root', name: 'rootFolder', docs: [{ _id: DOC, name: 'main.tex' }], fileRefs: [], folders: [] }],
              trackChangesState: state.trackChanges,
            },
            permissionsLevel: 'owner',
            protocolVersion: 2,
          },
          supportedProtocolVersions: [2],
          callTimeoutMs: 5_000,
          applyTimeoutMs: state.outcome === 'unacknowledged' ? 50 : 5_000,
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

async function setStatus(state: ServerState, status: 'open' | 'resolved'): Promise<unknown> {
  let result: unknown
  await withRuntime(state, async service => {
    result = await service.set_comment_status({
      projectId: PROJECT,
      filePath: 'main.tex',
      revision: createRevision({
        projectId: PROJECT,
        docId: DOC,
        protocol: state.protocol,
        otVersion: state.version,
        content: CONTENT,
      }),
      threadId: THREAD,
      status,
    })
  })
  // The thread's authors, emails included, never reach the result.
  expect(JSON.stringify(result)).not.toContain('example.test')
  return result
}

describe('set_comment_status golden results', () => {
  test('resolves a history-OT comment through an OT update', async () => {
    const state = server('history-ot')
    expectGolden('set_comment_status', await setStatus(state, 'resolved'))
    expect(state).toMatchObject({ resolved: true, version: 5 })
  })

  test('reopens a resolved history-OT comment', async () => {
    const state = server('history-ot', { resolved: true })
    expectGolden('set_comment_status', await setStatus(state, 'open'))
    expect(state).toMatchObject({ resolved: false, version: 5 })
  })

  test('resolves a history-OT comment whose anchored text was deleted', async () => {
    const state = server('history-ot', { anchored: false })
    expectGolden('set_comment_status', await setStatus(state, 'resolved'))
    expect(state.resolved).toBe(true)
  })

  test('reports trackChangesActive from the project while the status change stays untracked', async () => {
    const state = server('history-ot', { trackChanges: true })
    expectGolden('set_comment_status', await setStatus(state, 'resolved'))
  })

  test('resolves a ShareJS comment through the REST action', async () => {
    const state = server('sharejs')
    expectGolden('set_comment_status', await setStatus(state, 'resolved'))
    expect(state).toMatchObject({ resolved: true, version: 4 })
  })

  test('reopens a resolved ShareJS comment through the REST action', async () => {
    const state = server('sharejs', { resolved: true })
    expectGolden('set_comment_status', await setStatus(state, 'open'))
    expect(state.resolved).toBe(false)
  })

  // Asking for the status a thread already has still sends the change and verifies the result.
  test('resolves a history-OT comment that is already resolved', async () => {
    const state = server('history-ot', { resolved: true })
    const result = await setStatus(state, 'resolved')
    expect(result).toMatchObject({ status: 'resolved' })
    expect(result).not.toHaveProperty('recoveredAfterTimeout')
    expectGolden('set_comment_status', result)
    // The OT update was applied, so the returned revision is one version on.
    expect(state).toMatchObject({ resolved: true, version: 5 })
  })

  test('reopens a ShareJS comment that is already open', async () => {
    const state = server('sharejs')
    const result = await setStatus(state, 'open')
    expect(result).toMatchObject({ status: 'open' })
    expect(result).not.toHaveProperty('recoveredAfterTimeout')
    expectGolden('set_comment_status', result)
    expect(state).toMatchObject({ resolved: false, version: 4, restActions: ['reopen'] })
  })

  test('recovers a history-OT update whose otUpdateApplied never came', async () => {
    const state = server('history-ot', { outcome: 'unacknowledged' })
    expectGolden('set_comment_status', await setStatus(state, 'resolved'))
  })

  test('recovers a history-OT update whose socket closed after it was sent', async () => {
    const state = server('history-ot', { outcome: 'socket-lost' })
    expectGolden('set_comment_status', await setStatus(state, 'resolved'))
  })

  test('recovers an acknowledged history-OT update whose verification read failed', async () => {
    const state = server('history-ot', { outcome: 'verification-read-fails' })
    expectGolden('set_comment_status', await setStatus(state, 'resolved'))
  })

  test('recovers a ShareJS REST action that timed out', async () => {
    const state = server('sharejs', { outcome: 'request-timeout' })
    expectGolden('set_comment_status', await setStatus(state, 'resolved'))
  })

  test('recovers an acknowledged ShareJS REST action whose verification read failed', async () => {
    const state = server('sharejs', { outcome: 'verification-read-fails' })
    expectGolden('set_comment_status', await setStatus(state, 'resolved'))
    expect(state.failNextJoin).toBe(false)
  })
})
