import { describe, expect, test, vi } from 'vitest'

import { McpError } from '../../src/core/errors.js'
import { FifoQueue } from '../../src/core/queue.js'
import { createRevision } from '../../src/core/revision.js'
import { DocumentsApi } from '../../src/overleaf/documents.js'
import type { JoinedDocument } from '../../src/protocol/project-connection.js'

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

function historyDocument(content: string, version: number): JoinedDocument {
  return {
    docId: 'doc',
    protocol: 'history-ot',
    version,
    content,
    ranges: { comments: [], changes: [] },
    rawSnapshot: { content, comments: [], trackedChanges: [] },
  }
}

function createHarness(
  documents: JoinedDocument[],
  submitError?: McpError,
  options: ConstructorParameters<typeof DocumentsApi>[1] = {}
) {
  const joinDocument = vi.fn(async () => {
    const next = documents.shift()
    if (!next) throw new Error('no document fixture')
    return next
  })
  const connection = {
    queue: new FifoQueue(),
    getTree: () => [entity],
    joinDocument,
    leaveDocument: vi.fn(async () => undefined),
    submitUpdate: vi.fn(async (docId: string, update: Record<string, unknown>) => {
      void docId
      void update
      if (submitError) throw submitError
    }),
    trackChangesActive: true,
  }
  const connections = {
    withConnection: async <T>(
      _projectId: string,
      operation: (value: typeof connection) => Promise<T>
    ) => await operation(connection),
  }
  return { api: new DocumentsApi(connections, options), connection }
}

describe('document API', () => {
  test('reads normalized text with an opaque revision', async () => {
    const { api } = createHarness([shareDocument('a\r\nb', 3)])
    const result = await api.readFile('project', 'main.tex')

    expect(result).toMatchObject({
      content: 'a\nb',
      newline: 'LF',
      protocol: 'sharejs',
    })
    expect(result.revision).toEqual(expect.any(String))
  })

  test('submits a minimal untracked update and verifies the live post-state', async () => {
    const before = shareDocument('old', 3)
    const after = shareDocument('new', 4)
    const { api, connection } = createHarness([before, after])
    const revision = createRevision({
      projectId: 'project',
      docId: 'doc',
      protocol: 'sharejs',
      otVersion: 3,
      content: 'old',
    })

    const result = await api.writeFile('project', 'main.tex', revision, 'new')

    expect(connection.submitUpdate).toHaveBeenCalledWith(
      'doc',
      {
        doc: 'doc',
        v: 3,
        op: [{ p: 0, d: 'old' }, { p: 0, i: 'new' }],
      }
    )
    expect(result).toMatchObject({
      trackChangesActive: true,
      writeMode: 'untracked',
      protocol: 'sharejs',
    })
  })

  test('submits a tracked ShareJS update for the authenticated user even when tracking is inactive', async () => {
    const before = shareDocument('old', 3)
    const after = shareDocument('new', 4)
    const { api, connection } = createHarness([before, after], undefined, {
      currentUserId: 'user',
    })
    connection.trackChangesActive = false
    const revision = createRevision({
      projectId: 'project',
      docId: 'doc',
      protocol: 'sharejs',
      otVersion: 3,
      content: 'old',
    })

    const result = await api.writeFile('project', 'main.tex', revision, 'new', 'tracked')

    expect(connection.submitUpdate).toHaveBeenCalledWith('doc', {
      doc: 'doc',
      v: 3,
      op: [{ p: 0, d: 'old' }, { p: 0, i: 'new' }],
      // Overleaf takes the author from the session; tc seeds the tracked-change ids and is
      // refused when longer than 18 characters.
      meta: { tc: expect.stringMatching(/^[0-9a-f]{18}$/u) },
    })
    expect(result).toMatchObject({
      trackChangesActive: false,
      writeMode: 'tracked',
      protocol: 'sharejs',
    })
  })

  test('submits tracked history-OT components with a shared timestamp', async () => {
    const before = historyDocument('old', 3)
    const after = historyDocument('newold', 4)
    after.content = 'new'
    after.rawSnapshot = {
      content: 'newold',
      comments: [],
      trackedChanges: [
        {
          range: { pos: 0, length: 3 },
          tracking: { type: 'insert', userId: 'user', ts: 'after' },
        },
        {
          range: { pos: 3, length: 3 },
          tracking: { type: 'delete', userId: 'user', ts: 'after' },
        },
      ],
    }
    const { api, connection } = createHarness([before, after], undefined, {
      currentUserId: 'user',
    })
    const revision = createRevision({
      projectId: 'project',
      docId: 'doc',
      protocol: 'history-ot',
      otVersion: 3,
      content: 'old',
    })

    const result = await api.writeFile('project', 'main.tex', revision, 'new', 'tracked')

    const update = connection.submitUpdate.mock.calls[0]?.[1] as {
      op: Array<{ textOperation: Array<Record<string, any>> }>
    }
    const components = update.op[0]!.textOperation.filter(
      component => typeof component === 'object'
    )
    expect(components).toEqual([
      {
        i: 'new',
        tracking: { type: 'insert', userId: 'user', ts: expect.any(String) },
      },
      {
        r: 3,
        tracking: { type: 'delete', userId: 'user', ts: expect.any(String) },
      },
    ])
    expect(components[0]!.tracking.ts).toBe(components[1]!.tracking.ts)
    expect(result.writeMode).toBe('tracked')
  })

  test('rejects tracked writes without an authenticated user identity', async () => {
    const before = shareDocument('old', 3)
    const { api, connection } = createHarness([before])
    const revision = createRevision({
      projectId: 'project',
      docId: 'doc',
      protocol: 'sharejs',
      otVersion: 3,
      content: 'old',
    })

    await expect(
      api.writeFile('project', 'main.tex', revision, 'new', 'tracked')
    ).rejects.toMatchObject({ code: 'PROTOCOL_UNSUPPORTED' })
    expect(connection.submitUpdate).not.toHaveBeenCalled()
  })

  test('returns the requested tracked mode without submitting a no-op update', async () => {
    const before = shareDocument('same', 3)
    const { api, connection } = createHarness([before], undefined, {
      currentUserId: 'user',
    })
    const revision = createRevision({
      projectId: 'project',
      docId: 'doc',
      protocol: 'sharejs',
      otVersion: 3,
      content: 'same',
    })

    await expect(
      api.writeFile('project', 'main.tex', revision, 'same', 'tracked')
    ).resolves.toMatchObject({ writeMode: 'tracked', revision })
    expect(connection.submitUpdate).not.toHaveBeenCalled()
  })

  test('refuses characters outside the BMP on a ShareJS document before sending anything', async () => {
    const { api, connection } = createHarness([shareDocument('old\ntext', 3)])
    const revision = createRevision({
      projectId: 'project',
      docId: 'doc',
      protocol: 'sharejs',
      otVersion: 3,
      content: 'old\ntext',
    })

    const error = await api
      .writeFile('project', 'main.tex', revision, 'old\ntext \u{1F600}')
      .catch((caught: unknown) => caught)

    expect(error).toMatchObject({ code: 'INVALID_ARGUMENT', details: { line: 2 } })
    expect((error as Error).message).toContain('Basic Multilingual Plane')
    expect((error as Error).message).not.toContain('\u{1F600}')
    expect(connection.submitUpdate).not.toHaveBeenCalled()
    expect(connection.leaveDocument).toHaveBeenCalledWith('doc')
  })

  test('refuses an unpaired surrogate on a ShareJS document', async () => {
    const { api, connection } = createHarness([shareDocument('old', 3)])
    const revision = createRevision({
      projectId: 'project',
      docId: 'doc',
      protocol: 'sharejs',
      otVersion: 3,
      content: 'old',
    })

    await expect(api.writeFile('project', 'main.tex', revision, 'old \uD83D')).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    })
    expect(connection.submitUpdate).not.toHaveBeenCalled()
  })

  test('allows a character outside the BMP that the ShareJS document already holds', async () => {
    const { api, connection } = createHarness([
      shareDocument('a \u{1F600}', 3),
      shareDocument('b \u{1F600}', 4),
    ])
    const revision = createRevision({
      projectId: 'project',
      docId: 'doc',
      protocol: 'sharejs',
      otVersion: 3,
      content: 'a \u{1F600}',
    })

    await expect(api.writeFile('project', 'main.tex', revision, 'b \u{1F600}')).resolves.toMatchObject({
      protocol: 'sharejs',
    })
    expect(connection.submitUpdate).toHaveBeenCalledOnce()
  })

  test('refuses a new copy of a character outside the BMP that the ShareJS document already holds', async () => {
    const before = '\u{1F600} a'
    const { api, connection } = createHarness([shareDocument(before, 3)])
    const revision = createRevision({
      projectId: 'project',
      docId: 'doc',
      protocol: 'sharejs',
      otVersion: 3,
      content: before,
    })

    await expect(
      api.writeFile('project', 'main.tex', revision, `${before}\n\u{1F600} b`)
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', details: { line: 2 } })
    expect(connection.submitUpdate).not.toHaveBeenCalled()
  })

  test('refuses reordering characters outside the BMP on a ShareJS document, which inserts them again', async () => {
    const before = 'x\n\u{1F600}\u{1F601}'
    const { api, connection } = createHarness([shareDocument(before, 3)])
    const revision = createRevision({
      projectId: 'project',
      docId: 'doc',
      protocol: 'sharejs',
      otVersion: 3,
      content: before,
    })

    await expect(
      api.writeFile('project', 'main.tex', revision, 'x\n\u{1F601}\u{1F600}')
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', details: { line: 2 } })
    expect(connection.submitUpdate).not.toHaveBeenCalled()
  })

  test('leaves characters outside the BMP on a history-OT document to Overleaf', async () => {
    const { api, connection } = createHarness([
      historyDocument('old', 3),
      historyDocument('old \u{1F600}', 4),
    ])
    const revision = createRevision({
      projectId: 'project',
      docId: 'doc',
      protocol: 'history-ot',
      otVersion: 3,
      content: 'old',
    })

    await expect(api.writeFile('project', 'main.tex', revision, 'old \u{1F600}')).resolves.toMatchObject({
      protocol: 'history-ot',
    })
    expect(connection.submitUpdate).toHaveBeenCalledOnce()
  })

  test('recovers a timed-out write when the intended hash is live', async () => {
    const timeout = new McpError('TIMEOUT', 'ack timeout')
    const { api } = createHarness(
      [shareDocument('old', 3), shareDocument('new', 4)],
      timeout
    )
    const revision = createRevision({
      projectId: 'project',
      docId: 'doc',
      protocol: 'sharejs',
      otVersion: 3,
      content: 'old',
    })

    await expect(api.writeFile('project', 'main.tex', revision, 'new')).resolves.toMatchObject({
      recoveredAfterTimeout: true,
    })
  })

  test('polls the bounded recovery window when the original revision is initially live', async () => {
    const timeout = new McpError('TIMEOUT', 'ack timeout')
    const { api, connection } = createHarness(
      [
        shareDocument('old', 3),
        shareDocument('old', 3),
        shareDocument('new', 4),
      ],
      timeout,
      {
        recoveryTimeoutMs: 20,
        recoveryPollIntervalMs: 0,
      }
    )
    const revision = createRevision({
      projectId: 'project',
      docId: 'doc',
      protocol: 'sharejs',
      otVersion: 3,
      content: 'old',
    })

    await expect(api.writeFile('project', 'main.tex', revision, 'new')).resolves.toMatchObject({
      recoveredAfterTimeout: true,
    })
    expect(connection.joinDocument).toHaveBeenCalledTimes(3)
  })

  test('observes a write whose socket closed after sending instead of resubmitting it', async () => {
    const disconnected = new McpError('OUTCOME_UNKNOWN', 'socket closed')
    const { api, connection } = createHarness(
      [shareDocument('old', 3), shareDocument('new', 4)],
      disconnected
    )
    const revision = createRevision({
      projectId: 'project',
      docId: 'doc',
      protocol: 'sharejs',
      otVersion: 3,
      content: 'old',
    })

    await expect(api.writeFile('project', 'main.tex', revision, 'new')).resolves.toMatchObject({
      recoveredAfterTimeout: true,
    })
    expect(connection.submitUpdate).toHaveBeenCalledOnce()
  })

  test('observes a write whose verification read lost its socket', async () => {
    const { api, connection } = createHarness([shareDocument('old', 3), shareDocument('new', 4)])
    connection.joinDocument
      .mockImplementationOnce(async () => shareDocument('old', 3))
      .mockImplementationOnce(async () => {
        throw new McpError('REMOTE_ERROR', 'socket closed', { retryable: true })
      })
    const revision = createRevision({
      projectId: 'project',
      docId: 'doc',
      protocol: 'sharejs',
      otVersion: 3,
      content: 'old',
    })

    await expect(api.writeFile('project', 'main.tex', revision, 'new')).resolves.toMatchObject({
      recoveredAfterTimeout: true,
    })
    expect(connection.submitUpdate).toHaveBeenCalledOnce()
  })

  test('reports a conflict when a third state is live after the socket closed mid-write', async () => {
    const disconnected = new McpError('OUTCOME_UNKNOWN', 'socket closed')
    const { api, connection } = createHarness(
      [shareDocument('old', 3), shareDocument('collaborator', 4)],
      disconnected
    )
    const revision = createRevision({
      projectId: 'project',
      docId: 'doc',
      protocol: 'sharejs',
      otVersion: 3,
      content: 'old',
    })

    await expect(api.writeFile('project', 'main.tex', revision, 'new')).rejects.toMatchObject({
      code: 'REVISION_CONFLICT',
      details: expect.objectContaining({ outcome: 'unknown' }),
    })
    expect(connection.submitUpdate).toHaveBeenCalledOnce()
  })

  test('reports an unknown conflict instead of retrying a timed-out write', async () => {
    const timeout = new McpError('TIMEOUT', 'ack timeout')
    const { api, connection } = createHarness(
      [shareDocument('old', 3), shareDocument('collaborator', 4)],
      timeout
    )
    const revision = createRevision({
      projectId: 'project',
      docId: 'doc',
      protocol: 'sharejs',
      otVersion: 3,
      content: 'old',
    })

    await expect(api.writeFile('project', 'main.tex', revision, 'new')).rejects.toMatchObject({
      code: 'REVISION_CONFLICT',
      details: expect.objectContaining({ outcome: 'unknown' }),
    })
    expect(connection.submitUpdate).toHaveBeenCalledOnce()
  })
})
