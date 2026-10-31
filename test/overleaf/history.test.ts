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
