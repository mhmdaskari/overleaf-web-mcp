import { rm } from 'node:fs/promises'

import { describe, expect, test } from 'vitest'

import { createOverleafService } from '../../src/service/operations.js'
import { expectGolden } from '../helpers/golden.js'
import { createTestRuntime } from '../helpers/runtime.js'

// Overleaf's history users carry an email, which the result must never repeat. A marker that is
// not an address stands in for it.
const EMAIL_MARKER = 'email-placeholder'

function user(id: string, firstName: string, lastName: string) {
  return { id, first_name: firstName, last_name: lastName, email: EMAIL_MARKER }
}

/** A group with every field Overleaf sends: a full origin, an attributed label, and each project operation. */
const restoredGroup = {
  fromV: 5,
  toV: 8,
  meta: {
    users: [user('user-1', 'Author', 'One'), null],
    start_ts: 1_700_000_000_000,
    end_ts: 1_700_000_060_000,
    origin: { kind: 'file-restore', path: 'main.tex', timestamp: 1_699_999_000_000, version: 4 },
  },
  labels: [
    {
      id: 'label-1',
      comment: 'Ready',
      version: 8,
      created_at: '2023-11-14T22:14:00.000Z',
      lastUpdatedTimestamp: null,
      user_id: 'user-1',
      user_display_name: 'Author One',
    },
  ],
  pathnames: ['main.tex', 'chapter.tex'],
  project_ops: [
    { atV: 6, add: { pathname: 'chapter.tex' } },
    { atV: 7, rename: { pathname: 'old.tex', newPathname: 'new.tex' } },
    { atV: 8, remove: { pathname: 'gone.tex' } },
  ],
}

/** A later group whose origin is only a `source`, with no labels or project operations. */
const bridgedGroup = {
  fromV: 8,
  toV: 10,
  meta: {
    users: [user('user-2', 'Author', 'Two')],
    start_ts: 1_700_000_120_000,
    end_ts: 1_700_000_180_000,
    source: 'git-bridge',
  },
  labels: [],
  pathnames: ['main.tex'],
  project_ops: [],
}

async function monitor(body: unknown, sinceVersion?: number) {
  const { runtime, fetches, directory } = await createTestRuntime({
    fetcher: async input => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.pathname === '/project/p/updates') return Response.json(body)
      throw new Error(`unexpected ${url.pathname}`)
    },
  })
  try {
    const service = createOverleafService(runtime)
    const result = await service.monitor_project_history(
      sinceVersion === undefined ? { projectId: 'p' } : { projectId: 'p', sinceVersion }
    )
    expect(fetches).toEqual(['GET /project/p/updates?min_count=25'])
    expect(JSON.stringify(result)).not.toContain(EMAIL_MARKER)
    return result
  } finally {
    await runtime.close()
    await rm(directory, { recursive: true, force: true })
  }
}

describe('monitor_project_history golden results', () => {
  test('without a cursor: newest first, full and source-only origins, every operation, an anonymous author', async () => {
    const result = await monitor({
      updates: [restoredGroup, bridgedGroup],
      nextBeforeTimestamp: 1_699_000_000_000,
    })
    expectGolden('monitor_project_history', result)
  })

  test('origin from type, kind alone, or nothing; unattributed labels; a nameless author; no earlier history', async () => {
    const result = await monitor({
      updates: [
        {
          fromV: 0,
          toV: 1,
          meta: { users: [], start_ts: 1_700_000_000_000, end_ts: 1_700_000_000_000 },
          labels: [
            { id: 'label-2', comment: 'Unattributed', version: 1, created_at: '2023-11-14T22:13:20.000Z' },
            {
              id: 'label-3',
              comment: 'Anonymous',
              version: 1,
              created_at: '2023-11-14T22:13:20.000Z',
              user_id: null,
              user_display_name: null,
            },
          ],
          pathnames: [],
          project_ops: [{ atV: 0, add: { pathname: 'main.tex' } }],
        },
        {
          fromV: 1,
          toV: 2,
          meta: {
            users: [user('user-3', '', '')],
            start_ts: 1_700_000_060_000,
            end_ts: 1_700_000_120_000,
            type: 'external',
          },
          labels: [],
          pathnames: ['main.tex'],
          project_ops: [],
        },
        {
          fromV: 2,
          toV: 3,
          meta: {
            users: [null],
            start_ts: 1_700_000_180_000,
            end_ts: 1_700_000_240_000,
            origin: { kind: 'upload' },
          },
          labels: [],
          pathnames: ['figure.png'],
          project_ops: [],
        },
      ],
    })
    expectGolden('monitor_project_history', result)
  })

  test('a cursor older than the returned window reports a gap', async () => {
    const result = await monitor(
      { updates: [{ ...restoredGroup, fromV: 100, toV: 110, labels: [] }], nextBeforeTimestamp: 1 },
      50
    )
    expectGolden('monitor_project_history', result)
  })

  test('a cursor inside a group keeps only the operations at or after it', async () => {
    const result = await monitor(
      {
        updates: [
          {
            ...restoredGroup,
            fromV: 138,
            toV: 142,
            labels: [],
            project_ops: [
              { atV: 141, add: { pathname: 'review.tex' } },
              { atV: 140, rename: { pathname: 'draft.tex', newPathname: 'paper.tex' } },
              { atV: 139, remove: { pathname: 'refs.bib' } },
              { atV: 138, remove: { pathname: 'broken.tex' } },
            ],
          },
          { ...bridgedGroup, fromV: 130, toV: 138 },
        ],
        nextBeforeTimestamp: 1_699_000_000_000,
      },
      140
    )
    expectGolden('monitor_project_history', result)
  })

  test('a cursor at the current version returns no updates', async () => {
    const result = await monitor({ updates: [restoredGroup, bridgedGroup] }, 10)
    expectGolden('monitor_project_history', result)
  })

  test('an empty history without a cursor', async () => {
    const result = await monitor({ updates: [] })
    expectGolden('monitor_project_history', result)
  })

  test('an empty window with a cursor and earlier history keeps the cursor', async () => {
    const result = await monitor({ updates: [], nextBeforeTimestamp: 1_699_000_000_000 }, 7)
    expectGolden('monitor_project_history', result)
  })
})
