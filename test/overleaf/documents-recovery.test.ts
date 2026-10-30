import { afterEach, describe, expect, test, vi } from 'vitest'

import { McpError } from '../../src/core/errors.js'
import { FifoQueue } from '../../src/core/queue.js'
import { createRevision } from '../../src/core/revision.js'
import { DocumentsApi } from '../../src/overleaf/documents.js'
import type { JoinedDocument } from '../../src/protocol/project-connection.js'

// The outcomes of a document write whose submission was unconfirmed, as writeFile reports them.

const entity = {
  id: 'doc',
  name: 'main.tex',
  path: 'main.tex',
  type: 'doc' as const,
  parentFolderId: 'root',
}

function shareDocument(content: string, version: number): JoinedDocument {
  return {
    docId: 'doc',
    protocol: 'sharejs',
    version,
    content,
    ranges: { comments: [], changes: [] },
    rawSnapshot: content,
  }
}

// A fixture that is an Error is thrown by that join instead of returned.
function createHarness(
  documents: Array<JoinedDocument | Error>,
  submitError: McpError,
  options: ConstructorParameters<typeof DocumentsApi>[1] = {}
) {
  const connection = {
    queue: new FifoQueue(),
    getTree: () => [entity],
    joinDocument: vi.fn(async (): Promise<JoinedDocument> => {
      const next = documents.shift()
      if (!next) throw new Error('no document fixture')
      if (next instanceof Error) throw next
      return next
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
  return { api: new DocumentsApi(connections, options), connection, connections }
}

const revision = createRevision({
  projectId: 'project',
  docId: 'doc',
  protocol: 'sharejs',
  otVersion: 3,
  content: 'old',
})

async function rejection(promise: Promise<unknown>): Promise<McpError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught
  )
  expect(error).toBeInstanceOf(McpError)
  return error as McpError
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('document write recovery', () => {
  test.each<[string, McpError, string, string]>([
    [
      'timed out',
      new McpError('TIMEOUT', 'ack timeout'),
      'TIMEOUT',
      'The write timed out and the original revision is still live.',
    ],
    [
      'lost its socket',
      new McpError('OUTCOME_UNKNOWN', 'socket closed'),
      'REMOTE_ERROR',
      'The write lost its socket and the original revision is still live.',
    ],
  ])(
    'reports a write that %s as not applied when the original revision stays live',
    async (_, submitError, code, message) => {
      const { api, connection, connections } = createHarness(
        [shareDocument('old', 3), shareDocument('old', 3)],
        submitError,
        { recoveryTimeoutMs: 0, recoveryPollIntervalMs: 0 }
      )

      const error = await rejection(api.writeFile('project', 'main.tex', revision, 'new'))

      expect(error).toMatchObject({ code, message, retryable: false })
      expect(error.details).toEqual({ outcome: 'not_applied' })
      expect(connections.invalidate).toHaveBeenCalledWith('project')
      expect(connection.joinDocument).toHaveBeenCalledTimes(2)
      expect(connection.submitUpdate).toHaveBeenCalledOnce()
    }
  )

  test('reports an original sighting followed by failed reads to the end of the window as unknown', async () => {
    let clock = 0
    vi.spyOn(Date, 'now').mockImplementation(() => clock)
    const lost = new McpError('REMOTE_ERROR', 'socket closed', {
      retryable: true,
      details: { event: 'joinDoc', reason: 'disconnected' },
    })
    const { api, connection } = createHarness(
      [shareDocument('old', 3), shareDocument('old', 3)],
      new McpError('TIMEOUT', 'ack timeout'),
      { recoveryTimeoutMs: 50, recoveryPollIntervalMs: 0 }
    )
    connection.joinDocument
      .mockImplementationOnce(async () => shareDocument('old', 3))
      .mockImplementationOnce(async () => shareDocument('old', 3))
      .mockImplementation(async () => {
        // The window ends while this read fails, so the write could have applied after the sighting.
        clock = 100
        throw lost
      })

    const error = await rejection(api.writeFile('project', 'main.tex', revision, 'new'))

    expect(error).toMatchObject({
      code: 'OUTCOME_UNKNOWN',
      message: 'Could not observe live content after the write timed out.',
    })
    expect(error.details).toBeUndefined()
    expect(error.cause).toBe(lost)
    expect(connection.joinDocument).toHaveBeenCalledTimes(3)
    expect(connection.submitUpdate).toHaveBeenCalledOnce()
  })

  test('reports a third live state as a conflict carrying its revision', async () => {
    const { api, connection } = createHarness(
      [shareDocument('old', 3), shareDocument('collaborator', 4)],
      new McpError('OUTCOME_UNKNOWN', 'socket closed'),
      { recoveryTimeoutMs: 1_000, recoveryPollIntervalMs: 0 }
    )

    const error = await rejection(api.writeFile('project', 'main.tex', revision, 'new'))

    expect(error).toMatchObject({
      code: 'REVISION_CONFLICT',
      message: 'Live content changed after the write lost its socket.',
      retryable: false,
    })
    expect(error.details).toEqual({
      outcome: 'unknown',
      liveRevision: createRevision({
        projectId: 'project',
        docId: 'doc',
        protocol: 'sharejs',
        otVersion: 4,
        content: 'collaborator',
      }),
    })
    expect(connection.submitUpdate).toHaveBeenCalledOnce()
  })
})
