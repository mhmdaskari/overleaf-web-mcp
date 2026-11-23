import { describe, expect, test, vi } from 'vitest'

import { McpError } from '../../src/core/errors.js'
import { HistoryApi } from '../../src/overleaf/history.js'

const firstUpdate = {
  fromV: 5,
  toV: 8,
  meta: {
    users: [
      {
        id: 'user',
        first_name: 'Ada',
        last_name: 'Lovelace',
        email: 'private@example.com',
      },
      null,
    ],
    start_ts: 1_700_000_000_000,
    end_ts: 1_700_000_060_000,
    origin: {
      kind: 'file-restore',
      path: 'main.tex',
      timestamp: 1_699_999_000_000,
      version: 4,
    },
  },
  labels: [
    {
      id: 'label',
      comment: 'Ready',
      version: 8,
      created_at: '2023-11-14T22:14:00.000Z',
      lastUpdatedTimestamp: null,
      user_id: 'user',
      user_display_name: 'Ada Lovelace',
    },
  ],
  pathnames: ['main.tex', 'chapter.tex'],
  project_ops: [
    { atV: 6, add: { pathname: 'chapter.tex' } },
    { atV: 7, rename: { pathname: 'old.tex', newPathname: 'new.tex' } },
    { atV: 8, remove: { pathname: 'gone.tex' } },
  ],
}

describe('project history API', () => {
  test('normalizes recent updates, authors, labels, operations, and origin', async () => {
    const http = {
      getJson: vi.fn(async () => ({
        updates: [
          {
            ...firstUpdate,
            fromV: 8,
            toV: 10,
            meta: {
              ...firstUpdate.meta,
              start_ts: 1_700_000_120_000,
              end_ts: 1_700_000_180_000,
              origin: undefined,
              source: 'git-bridge',
            },
            labels: [],
            pathnames: ['main.tex'],
            project_ops: [],
          },
          firstUpdate,
        ],
        nextBeforeTimestamp: 1_699_000_000_000,
      })),
    }
    const api = new HistoryApi(http)

    const result = await api.monitorProjectHistory('project', 5)

    expect(http.getJson).toHaveBeenCalledWith('/project/project/updates?min_count=25')
    expect(result).toMatchObject({
      projectId: 'project',
      currentVersion: 10,
      nextSinceVersion: 10,
      hasEarlierHistory: true,
      gapDetected: false,
    })
    expect(result.updates.map(update => update.toVersion)).toEqual([10, 8])
    expect(result.updates[0]?.origin).toEqual({ kind: 'git-bridge' })
    expect(result.updates[1]).toEqual({
      fromVersion: 5,
      toVersion: 8,
      startedAt: '2023-11-14T22:13:20.000Z',
      endedAt: '2023-11-14T22:14:20.000Z',
      authors: [{ id: 'user', displayName: 'Ada Lovelace' }, null],
      paths: ['main.tex', 'chapter.tex'],
      projectOperations: [
        { type: 'add', atVersion: 6, path: 'chapter.tex' },
        { type: 'rename', atVersion: 7, path: 'old.tex', newPath: 'new.tex' },
        { type: 'remove', atVersion: 8, path: 'gone.tex' },
      ],
      labels: [
        {
          id: 'label',
          comment: 'Ready',
          version: 8,
          createdAt: '2023-11-14T22:14:00.000Z',
          userId: 'user',
          userDisplayName: 'Ada Lovelace',
        },
      ],
      origin: {
        kind: 'file-restore',
        path: 'main.tex',
        timestamp: '2023-11-14T21:56:40.000Z',
        version: 4,
      },
    })
    expect(JSON.stringify(result)).not.toContain('private@example.com')
  })

  test('filters by version cursor and reports a gap before the returned window', async () => {
    const http = {
      getJson: vi.fn(async () => ({
        updates: [{ ...firstUpdate, fromV: 100, toV: 110 }],
        nextBeforeTimestamp: 1,
      })),
    }
    const api = new HistoryApi(http)

    await expect(api.monitorProjectHistory('project', 50)).resolves.toMatchObject({
      currentVersion: 110,
      nextSinceVersion: 110,
      hasEarlierHistory: true,
      gapDetected: true,
      updates: [expect.objectContaining({ fromVersion: 100, toVersion: 110 })],
    })
  })

  test('drops operations before the cursor from a group that straddles it', async () => {
    // Overleaf re-merged 138-141 into 138-142 between polls; the op at 141 made version 142.
    const straddling = {
      ...firstUpdate,
      fromV: 138,
      toV: 142,
      labels: [],
      project_ops: [
        { atV: 141, add: { pathname: 'review.tex' } },
        { atV: 140, remove: { pathname: 'withbib.tex' } },
        { atV: 139, remove: { pathname: 'refs.bib' } },
        { atV: 138, remove: { pathname: 'broken.tex' } },
      ],
    }
    const api = new HistoryApi({
      getJson: vi.fn(async () => ({
        updates: [straddling, { ...firstUpdate, fromV: 137, toV: 138, labels: [] }],
      })),
    })
    const atVersions = async (sinceVersion?: number) => {
      const result = await api.monitorProjectHistory('project', sinceVersion)
      return result.updates.map(update => ({
        fromVersion: update.fromVersion,
        toVersion: update.toVersion,
        atVersions: update.projectOperations.map(operation => operation.atVersion),
      }))
    }

    await expect(atVersions(141)).resolves.toEqual([{ fromVersion: 138, toVersion: 142, atVersions: [141] }])
    await expect(atVersions(139)).resolves.toEqual([{ fromVersion: 138, toVersion: 142, atVersions: [141, 140, 139] }])
    await expect(atVersions()).resolves.toEqual([
      { fromVersion: 138, toVersion: 142, atVersions: [141, 140, 139, 138] },
      { fromVersion: 137, toVersion: 138, atVersions: [6, 7, 8] },
    ])
  })

  test('returns an unchanged cursor for an empty project history', async () => {
    const api = new HistoryApi({ getJson: vi.fn(async () => ({ updates: [] })) })

    await expect(api.monitorProjectHistory('project', 7)).resolves.toEqual({
      projectId: 'project',
      currentVersion: null,
      nextSinceVersion: 7,
      hasEarlierHistory: false,
      gapDetected: false,
      updates: [],
    })
  })

  test('rejects cursors newer than the observed project version', async () => {
    const api = new HistoryApi({
      getJson: vi.fn(async () => ({ updates: [firstUpdate] })),
    })

    await expect(api.monitorProjectHistory('project', 9)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    })
  })

  test('rejects negative or fractional version cursors before requesting history', async () => {
    const http = { getJson: vi.fn() }
    const api = new HistoryApi(http)

    await expect(api.monitorProjectHistory('project', -1)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    })
    await expect(api.monitorProjectHistory('project', 1.5)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    })
    expect(http.getJson).not.toHaveBeenCalled()
  })

  test('rejects malformed private history responses', async () => {
    const api = new HistoryApi({
      getJson: vi.fn(async () => ({ updates: [{ ...firstUpdate, toV: '8' }] })),
    })

    await expect(api.monitorProjectHistory('project')).rejects.toMatchObject({
      code: 'PROTOCOL_UNSUPPORTED',
    })
  })

  test('rejects history updates whose version range moves backwards', async () => {
    const api = new HistoryApi({
      getJson: vi.fn(async () => ({
        updates: [{ ...firstUpdate, fromV: 9, toV: 8 }],
      })),
    })

    await expect(api.monitorProjectHistory('project')).rejects.toMatchObject({
      code: 'PROTOCOL_UNSUPPORTED',
    })
  })

  test('normalizes missing and anonymous label attribution without exposing private data', async () => {
    const labels = [
      {
        id: 'missing-name',
        comment: 'Imported',
        version: 8,
        created_at: '2023-11-14T22:14:00.000Z',
        user_id: 'user',
      },
      {
        id: 'anonymous',
        comment: 'Anonymous',
        version: 8,
        created_at: '2023-11-14T22:14:00.000Z',
        user_id: null,
        user_display_name: null,
      },
    ]
    const api = new HistoryApi({
      getJson: vi.fn(async () => ({ updates: [{ ...firstUpdate, labels }] })),
    })

    await expect(api.monitorProjectHistory('project')).resolves.toMatchObject({
      updates: [
        expect.objectContaining({
          labels: [
            expect.objectContaining({ userId: 'user', userDisplayName: null }),
            expect.objectContaining({ userId: null, userDisplayName: null }),
          ],
        }),
      ],
    })
  })

  test('rejects project operations containing more than one action', async () => {
    const projectOperation = {
      atV: 8,
      add: { pathname: 'added.tex' },
      remove: { pathname: 'removed.tex' },
    }
    const api = new HistoryApi({
      getJson: vi.fn(async () => ({
        updates: [{ ...firstUpdate, project_ops: [projectOperation] }],
      })),
    })

    await expect(api.monitorProjectHistory('project')).rejects.toMatchObject({
      code: 'PROTOCOL_UNSUPPORTED',
    })
  })

  test('preserves existing authentication and permission errors', async () => {
    const denied = new McpError('PERMISSION_DENIED', 'Denied')
    const api = new HistoryApi({ getJson: vi.fn(async () => await Promise.reject(denied)) })

    await expect(api.monitorProjectHistory('project')).rejects.toBe(denied)
  })
})

describe('HistoryApi restoreFile', () => {
  const readResult = {
    content: 'Old',
    revision: 'r',
    newline: 'LF' as const,
    protocol: 'sharejs' as const,
    trackChangesActive: false,
  }

  function setup(options: {
    diff?: unknown
    post: () => Promise<unknown>
    after?: Array<{ id: string; path: string; type: string }>
  }) {
    let entities = [{ id: 'd1', path: 'main.tex', type: 'doc' }]
    const post = vi.fn(async () => {
      try {
        return await options.post()
      } finally {
        if (options.after !== undefined) entities = options.after
      }
    })
    const api = new HistoryApi(
      { getJson: vi.fn(async () => options.diff ?? { diff: [{ u: 'Old' }] }), postJson: post },
      undefined,
      { listEntities: vi.fn(async () => entities), readFile: vi.fn(async () => readResult) }
    )
    return { api, post }
  }

  test('a binary file at that version is refused before anything is sent', async () => {
    const { api, post } = setup({ diff: { diff: { binary: true } }, post: async () => ({}) })
    await expect(api.restoreFile('p', 'main.tex', { version: 2 }, 'main.tex')).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      details: { kind: 'binary_file' },
    })
    expect(post).not.toHaveBeenCalled()
  })

  test('a refusal from Overleaf passes through, since nothing changed', async () => {
    const denied = new McpError('PERMISSION_DENIED', 'Denied')
    const { api, post } = setup({ post: async () => await Promise.reject(denied) })
    await expect(api.restoreFile('p', 'main.tex', { version: 2 }, 'main.tex')).rejects.toBe(denied)
    expect(post).toHaveBeenCalledTimes(1)
  })

  test('a server error after the live file was removed is OUTCOME_UNKNOWN', async () => {
    const failed = new McpError('REMOTE_ERROR', 'HTTP 500', { details: { status: 500 } })
    const { api } = setup({ post: async () => await Promise.reject(failed), after: [] })
    await expect(api.restoreFile('p', 'main.tex', { version: 2 }, 'main.tex')).rejects.toMatchObject({
      code: 'OUTCOME_UNKNOWN',
      details: { filePath: 'main.tex', version: 2, outcome: 'unknown' },
    })
  })

  test('a server error that left the file as it was is not_applied', async () => {
    const failed = new McpError('REMOTE_ERROR', 'HTTP 500', { details: { status: 500 } })
    const { api } = setup({ post: async () => await Promise.reject(failed) })
    await expect(api.restoreFile('p', 'main.tex', { version: 2 }, 'main.tex')).rejects.toMatchObject({
      code: 'REMOTE_ERROR',
      retryable: false,
      details: { outcome: 'not_applied' },
    })
  })

  test('a server error after which the restored document exists counts as applied', async () => {
    const failed = new McpError('REMOTE_ERROR', 'HTTP 500', { details: { status: 500 } })
    const { api } = setup({
      post: async () => await Promise.reject(failed),
      after: [{ id: 'd2', path: 'main.tex', type: 'doc' }],
    })
    await expect(api.restoreFile('p', 'main.tex', { version: 2 }, 'main.tex')).resolves.toMatchObject({
      docId: 'd2',
      previousDocId: 'd1',
      recoveredAfterTimeout: true,
      contentMatches: true,
    })
  })
})
