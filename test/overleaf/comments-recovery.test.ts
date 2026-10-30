import { describe, expect, test, vi } from 'vitest'

import { McpError } from '../../src/core/errors.js'
import { FifoQueue } from '../../src/core/queue.js'
import { createRevision } from '../../src/core/revision.js'
import { CommentsApi } from '../../src/overleaf/comments.js'
import type { JoinedDocument } from '../../src/protocol/project-connection.js'

// The errors of a comment write whose submission was unconfirmed, as the comment API reports them.

const tree = [{ id: 'doc1', name: 'main.tex', path: 'main.tex', type: 'doc' as const, parentFolderId: 'root' }]

function shareDocument(content: string, version: number, comments: unknown[] = []): JoinedDocument {
  return {
    docId: 'doc1',
    protocol: 'sharejs',
    version,
    content,
    ranges: { comments, changes: [] },
    rawSnapshot: content,
  }
}

function historyDocument(resolved: boolean, version: number): JoinedDocument {
  return {
    docId: 'doc1',
    protocol: 'history-ot',
    version,
    content: 'hello',
    ranges: null,
    rawSnapshot: {
      content: 'hello',
      comments: [{ id: 'open', ranges: [{ pos: 1, length: 2 }], resolved }],
      trackedChanges: [],
    },
  }
}

// A fixture that is an Error is thrown by that join instead of returned.
function connectionHarness(documents: Array<JoinedDocument | Error>, submitError: McpError) {
  const connection = {
    queue: new FifoQueue(),
    getTree: () => tree,
    joinDocument: vi.fn(async (): Promise<JoinedDocument> => {
      const value = documents.shift()
      if (!value) throw new Error('no document fixture')
      if (value instanceof Error) throw value
      return value
    }),
    leaveDocument: vi.fn(async () => undefined),
    submitUpdate: vi.fn(async () => {
      throw submitError
    }),
    trackChangesActive: false,
  }
  const connections = {
    withConnection: async <T>(_projectId: string, operation: (value: typeof connection) => Promise<T>) =>
      await operation(connection),
    invalidate: vi.fn(async () => undefined),
  }
  return { connection, connections }
}

function httpHarness() {
  return {
    getJson: vi.fn(async () => ({ open: { messages: [] } })),
    postJson: vi.fn(async () => ({ id: 'message' })),
    deleteJson: vi.fn(async () => ({})),
  }
}

async function rejection(promise: Promise<unknown>): Promise<McpError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught
  )
  expect(error).toBeInstanceOf(McpError)
  return error as McpError
}

const timeout = () => new McpError('TIMEOUT', 'apply timeout')

describe('comment status recovery', () => {
  const input = {
    projectId: 'project',
    filePath: 'main.tex',
    revision: createRevision({
      projectId: 'project',
      docId: 'doc1',
      protocol: 'history-ot',
      otVersion: 1,
      content: 'hello',
    }),
    threadId: 'open',
    status: 'resolved' as const,
  }

  test('refuses a document whose protocol changed during recovery without reading its status', async () => {
    const { connection, connections } = connectionHarness(
      [historyDocument(false, 1), shareDocument('hello', 2), historyDocument(true, 3)],
      timeout()
    )
    const http = httpHarness()
    const api = new CommentsApi(http, connections, { recoveryTimeoutMs: 1_000, recoveryPollIntervalMs: 0 })

    const error = await rejection(api.setCommentStatus(input))

    expect(error).toMatchObject({
      code: 'PROTOCOL_UNSUPPORTED',
      message: 'Document protocol changed during comment-status recovery.',
    })
    expect(error.details).toBeUndefined()
    expect(connection.joinDocument).toHaveBeenCalledTimes(2)
    expect(connection.submitUpdate).toHaveBeenCalledOnce()
    expect(http.getJson).not.toHaveBeenCalled()
  })

  test('ends recovery at once when a read meets a protocol it does not support', async () => {
    const unsupported = new McpError('PROTOCOL_UNSUPPORTED', 'Invalid ShareJS snapshot.')
    const { connection, connections } = connectionHarness(
      [historyDocument(false, 1), unsupported, historyDocument(true, 2)],
      timeout()
    )
    const api = new CommentsApi(httpHarness(), connections, { recoveryTimeoutMs: 1_000, recoveryPollIntervalMs: 0 })

    await expect(api.setCommentStatus(input)).rejects.toBe(unsupported)
    expect(connection.joinDocument).toHaveBeenCalledTimes(2)
    expect(connection.submitUpdate).toHaveBeenCalledOnce()
  })

  test('reports a status change it could not observe as unknown, naming the thread', async () => {
    const lost = new McpError('REMOTE_ERROR', 'socket closed', {
      retryable: true,
      details: { event: 'joinDoc', reason: 'disconnected' },
    })
    const { connection, connections } = connectionHarness([historyDocument(false, 1), lost], timeout())
    const api = new CommentsApi(httpHarness(), connections, { recoveryTimeoutMs: 0, recoveryPollIntervalMs: 0 })

    const error = await rejection(api.setCommentStatus(input))

    expect(error).toMatchObject({
      code: 'OUTCOME_UNKNOWN',
      message: 'Could not observe the unconfirmed comment status.',
    })
    expect(error.details).toEqual({ threadId: 'open' })
    expect(error.cause).toBe(lost)
    expect(connection.submitUpdate).toHaveBeenCalledOnce()
  })
})

describe('comment attachment recovery', () => {
  const input = {
    projectId: 'project',
    filePath: 'main.tex',
    revision: createRevision({
      projectId: 'project',
      docId: 'doc1',
      protocol: 'sharejs',
      otVersion: 1,
      content: 'hello',
    }),
    start: { line: 1, column: 2 },
    end: { line: 1, column: 4 },
    expectedText: 'el',
    content: 'Review this',
  }

  test('reports a document that changed without the attachment as unknown, and keeps the thread', async () => {
    const { connection, connections } = connectionHarness(
      [shareDocument('hello', 1), shareDocument('hello there', 2), shareDocument('hello', 3)],
      timeout()
    )
    const http = httpHarness()
    const api = new CommentsApi(http, connections, {
      threadIdFactory: () => 'thread',
      recoveryTimeoutMs: 1_000,
      recoveryPollIntervalMs: 0,
    })

    const error = await rejection(api.addComment(input))

    expect(error).toMatchObject({
      code: 'OUTCOME_UNKNOWN',
      message: 'The document changed while the comment attachment remained unconfirmed.',
    })
    expect(error.details).toEqual({ threadId: 'thread' })
    expect(connection.joinDocument).toHaveBeenCalledTimes(2)
    expect(connection.submitUpdate).toHaveBeenCalledOnce()
    expect(http.deleteJson).not.toHaveBeenCalled()
  })
})
