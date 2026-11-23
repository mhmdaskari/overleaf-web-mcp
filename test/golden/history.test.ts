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

  test('a cursor inside a group: a label below it and a remove at it; a label without a display name; a kind-and-version origin', async () => {
    const result = (await monitor(
      {
        updates: [
          {
            fromV: 20,
            toV: 25,
            meta: {
              users: [user('user-1', 'Author', 'One')],
              start_ts: 1_700_000_300_000,
              end_ts: 1_700_000_360_000,
              origin: { kind: 'history-resync', version: 19 },
            },
            labels: [
              {
                id: 'label-below',
                comment: 'Below the cursor',
                version: 21,
                created_at: '2023-11-14T22:18:20.000Z',
                user_id: 'user-1',
              },
            ],
            pathnames: ['main.tex'],
            project_ops: [
              { atV: 23, add: { pathname: 'notes.tex' } },
              { atV: 22, remove: { pathname: 'old.tex' } },
              { atV: 21, rename: { pathname: 'draft.tex', newPathname: 'paper.tex' } },
            ],
          },
        ],
      },
      22
    )) as { updates: Array<Record<string, unknown>> }
    const [group] = result.updates
    // Only project operations are cut at the cursor: one at the cursor produced the next version, so it is new.
    expect(group?.projectOperations).toEqual([
      { type: 'add', atVersion: 23, path: 'notes.tex' },
      { type: 'remove', atVersion: 22, path: 'old.tex' },
    ])
    // The contract cuts only project operations, so a label below the cursor is still listed.
    expect(group?.labels).toEqual([
      expect.objectContaining({ id: 'label-below', version: 21, userId: 'user-1', userDisplayName: null }),
    ])
    expect(group?.origin).toEqual({ kind: 'history-resync', version: 19 })
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

/** Waits for the request's own timeout, then fails as fetch does, so the client reports TIMEOUT. */
async function lost(init: RequestInit | undefined): Promise<Response> {
  return await new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('timed out', 'TimeoutError')))
  })
}

const updatesAt = (version: number) => ({ updates: [{ ...bridgedGroup, fromV: version - 1, toV: version }] })

const storedLabel = (id: string, comment: string, version: number) => ({
  id,
  comment,
  version,
  created_at: '2026-11-20T10:00:00.000Z',
  user_id: 'user-1',
  user_display_name: 'Author One',
})

describe('monitor_project_history after a file restore', () => {
  test('reads a restore origin whose timestamp Overleaf sends as an ISO string', async () => {
    const restore = {
      ...bridgedGroup,
      fromV: 10,
      toV: 12,
      meta: {
        ...restoredGroup.meta,
        origin: { kind: 'file-restore', version: 6, path: 'main.tex', timestamp: '2026-11-23T11:18:22.824Z' },
      },
    }
    const result = await monitor({ updates: [restore, bridgedGroup] })
    expect(result.updates[0]!.origin).toEqual({
      kind: 'file-restore',
      path: 'main.tex',
      timestamp: '2026-11-23T11:18:22.824Z',
      version: 6,
    })
    expectGolden('monitor_project_history', result)
  })
})

describe('manage_history create_label', () => {
  test('labels the current version and reads the label back', async () => {
    const posted: unknown[] = []
    let labels = [storedLabel('older', 'First draft', 4)]
    const { runtime, fetches, directory } = await createTestRuntime({
      fetcher: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input))
        if (url.pathname === '/project/p/updates') return Response.json(updatesAt(12))
        if (url.pathname === '/project/p/labels' && init?.method === 'POST') {
          posted.push(JSON.parse(String(init.body)))
          const created = storedLabel('label-new', 'Before revising', 12)
          labels = [...labels, created]
          return Response.json(created)
        }
        if (url.pathname === '/project/p/labels') return Response.json(labels)
        throw new Error(`unexpected ${url.pathname}`)
      },
    })
    try {
      const result = await createOverleafService(runtime).manage_history({
        projectId: 'p',
        action: 'create_label',
        comment: 'Before revising',
      })
      expect(fetches).toEqual([
        'GET /project/p/updates?min_count=1',
        'GET /project/p/labels',
        'POST /project/p/labels',
        'GET /project/p/labels',
      ])
      expect(posted).toEqual([{ comment: 'Before revising', version: 12 }])
      expect(result).toEqual({
        action: 'create_label',
        label: { id: 'label-new', comment: 'Before revising', version: 12, createdAt: '2026-11-20T10:00:00.000Z' },
        verified: true,
      })
      expectGolden('manage_history', result)
    } finally {
      await runtime.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  test.each([
    ['applied', true],
    ['not applied', false],
  ])('a timed-out create that was %s is read back, never sent twice', async (_name, applied) => {
    let labels = [storedLabel('same', 'Before revising', 12)]
    const { runtime, fetches, directory } = await createTestRuntime({
      env: { OVERLEAF_REQUEST_TIMEOUT_MS: '50' },
      fetcher: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input))
        if (url.pathname === '/project/p/updates') return Response.json(updatesAt(12))
        if (url.pathname === '/project/p/labels' && init?.method === 'POST') {
          if (applied) labels = [...labels, storedLabel('label-new', 'Before revising', 12)]
          return await lost(init)
        }
        if (url.pathname === '/project/p/labels') return Response.json(labels)
        throw new Error(`unexpected ${url.pathname}`)
      },
    })
    try {
      const outcome = await createOverleafService(runtime)
        .manage_history({ projectId: 'p', action: 'create_label', comment: 'Before revising' })
        .catch((error: unknown) => error)
      expect(fetches.filter(fetch => fetch.startsWith('POST'))).toHaveLength(1)
      if (applied) {
        expect(outcome).toMatchObject({ label: { id: 'label-new' }, verified: true, recoveredAfterTimeout: true })
        expectGolden('manage_history', outcome)
      } else {
        // An older label with the same comment and version is not mistaken for the new one.
        expect(outcome).toMatchObject({ code: 'OUTCOME_UNKNOWN', details: { outcome: 'unknown' } })
      }
    } finally {
      await runtime.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe('read_file_version', () => {
  test('reads a document at a version through a diff of that version with itself', async () => {
    const { runtime, fetches, directory } = await createTestRuntime({
      fetcher: async input => {
        const url = new URL(input instanceof Request ? input.url : String(input))
        if (url.pathname === '/project/p/labels') return Response.json([storedLabel('label-1', 'Ready', 7)])
        if (url.pathname === '/project/p/updates') return Response.json(updatesAt(9))
        if (url.pathname === '/project/p/filetree/diff') {
          return Response.json({ diff: [{ pathname: 'chapters/intro.tex', editable: true }] })
        }
        if (url.pathname === '/project/p/diff') return Response.json({ diff: [{ u: 'Old text\r\nline two\n' }] })
        throw new Error(`unexpected ${url.pathname}`)
      },
    })
    try {
      const service = createOverleafService(runtime)
      const byVersion = await service.read_file_version({ projectId: 'p', filePath: 'chapters/intro.tex', version: 7 })
      const byLabel = await service.read_file_version({
        projectId: 'p',
        filePath: 'chapters/intro.tex',
        labelId: 'label-1',
      })
      const read = [
        'GET /project/p/updates?min_count=1',
        'GET /project/p/filetree/diff?from=7&to=7',
        'GET /project/p/diff?pathname=chapters%2Fintro.tex&from=7&to=7',
      ]
      expect(fetches).toEqual([...read, 'GET /project/p/labels', ...read])
      expect(byLabel).toEqual(byVersion)
      expect(byVersion).toEqual({
        filePath: 'chapters/intro.tex',
        version: 7,
        content: 'Old text\nline two\n',
        newline: 'LF',
      })
      expectGolden('read_file_version', byVersion)
    } finally {
      await runtime.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('a binary file, a missing path, a future version, and both version and labelId are refused', async () => {
    const { runtime, fetches, directory } = await createTestRuntime({
      fetcher: async input => {
        const url = new URL(input instanceof Request ? input.url : String(input))
        if (url.pathname === '/project/p/updates') return Response.json(updatesAt(9))
        if (url.pathname === '/project/p/filetree/diff') {
          return Response.json({
            diff: [
              { pathname: 'main.tex', editable: true },
              { pathname: 'figure.png', editable: false },
            ],
          })
        }
        throw new Error(`unexpected ${url.pathname}`)
      },
    })
    try {
      const service = createOverleafService(runtime)
      const read = async (input: Parameters<typeof service.read_file_version>[0]) =>
        await service.read_file_version(input).catch((error: unknown) => error)
      expect(await read({ projectId: 'p', filePath: 'figure.png', version: 2 })).toMatchObject({
        code: 'INVALID_ARGUMENT',
        details: { kind: 'binary_file', filePath: 'figure.png', version: 2 },
      })
      expect(await read({ projectId: 'p', filePath: 'gone.tex', version: 2 })).toMatchObject({
        code: 'NOT_FOUND',
        details: { filePath: 'gone.tex', version: 2 },
      })
      expect(await read({ projectId: 'p', filePath: 'main.tex', version: 12 })).toMatchObject({
        code: 'INVALID_ARGUMENT',
        details: { kind: 'version_ahead', version: 12, currentVersion: 9 },
      })
      expect(await read({ projectId: 'p', filePath: 'main.tex', version: 2, labelId: 'l' })).toMatchObject({
        code: 'INVALID_ARGUMENT',
        details: { parameters: ['version', 'labelId'] },
      })
      // Overleaf answers each of these with HTTP 500, so the history diff is never requested.
      expect(fetches.some(fetch => fetch.includes('/project/p/diff'))).toBe(false)
    } finally {
      await runtime.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe('manage_history restore_file', () => {
  /** A project whose main.tex is d1, until a restore replaces it with d2. */
  async function restoring(options: { revert: (init: RequestInit | undefined) => Promise<Response> }) {
    const root = {
      _id: 'root',
      name: 'rootFolder',
      docs: [{ _id: 'd1', name: 'main.tex' }],
      fileRefs: [],
      folders: [],
    }
    const posted: unknown[] = []
    const replace = () => {
      root.docs = [{ _id: 'd2', name: 'main.tex' }]
    }
    const test = await createTestRuntime({
      root,
      documentLines: ['Old text'],
      env: { OVERLEAF_REQUEST_TIMEOUT_MS: '50' },
      fetcher: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input))
        if (url.pathname === '/project/p/updates') return Response.json(updatesAt(9))
        if (url.pathname === '/project/p/filetree/diff')
          return Response.json({ diff: [{ pathname: 'main.tex', editable: true }] })
        if (url.pathname === '/project/p/diff') return Response.json({ diff: [{ u: 'Old text' }] })
        if (url.pathname === '/project/p/revert_file') {
          posted.push(JSON.parse(String(init?.body)))
          return await options.revert(init)
        }
        throw new Error(`unexpected ${url.pathname}`)
      },
    })
    return { ...test, posted, replace }
  }

  test('restores a document, and returns the new document from a fresh join', async () => {
    const setup = await restoring({
      revert: async () => {
        setup.replace()
        return Response.json({ type: 'doc', id: 'd2' })
      },
    })
    try {
      const result = await createOverleafService(setup.runtime).manage_history({
        projectId: 'p',
        action: 'restore_file',
        filePath: 'main.tex',
        version: 4,
        confirmPath: 'main.tex',
      })
      expect(setup.fetches).toEqual([
        'GET /project/p/updates?min_count=1',
        'GET /project/p/filetree/diff?from=4&to=4',
        'GET /project/p/diff?pathname=main.tex&from=4&to=4',
        'POST /project/p/revert_file',
      ])
      expect(setup.posted).toEqual([{ version: 4, pathname: 'main.tex' }])
      expect(result).toMatchObject({
        action: 'restore_file',
        filePath: 'main.tex',
        version: 4,
        docId: 'd2',
        previousDocId: 'd1',
        contentMatches: true,
      })
      expectGolden('manage_history', result)
    } finally {
      await setup.runtime.close()
      await rm(setup.directory, { recursive: true, force: true })
    }
  })

  test.each([undefined, 'other.tex'])(
    'confirmPath %s is CONFIRMATION_MISMATCH, and nothing is sent',
    async confirmPath => {
      const setup = await restoring({ revert: async () => await Promise.reject(new Error('must not be sent')) })
      try {
        const outcome = await createOverleafService(setup.runtime)
          .manage_history({
            projectId: 'p',
            action: 'restore_file',
            filePath: 'main.tex',
            version: 4,
            ...(confirmPath === undefined ? {} : { confirmPath }),
          })
          .catch((error: unknown) => error)
        expect(outcome).toMatchObject({ code: 'CONFIRMATION_MISMATCH' })
        expect(setup.fetches).toEqual([])
      } finally {
        await setup.runtime.close()
        await rm(setup.directory, { recursive: true, force: true })
      }
    }
  )

  test('a timed-out restore is classified from the tree, never resent', async () => {
    const applied = await restoring({
      revert: async init => {
        applied.replace()
        return await lost(init)
      },
    })
    const unchanged = await restoring({ revert: async init => await lost(init) })
    try {
      const recovered = await createOverleafService(applied.runtime).manage_history({
        projectId: 'p',
        action: 'restore_file',
        filePath: 'main.tex',
        version: 4,
        confirmPath: 'main.tex',
      })
      expect(recovered).toMatchObject({ docId: 'd2', previousDocId: 'd1', recoveredAfterTimeout: true })
      const failure = await createOverleafService(unchanged.runtime)
        .manage_history({
          projectId: 'p',
          action: 'restore_file',
          filePath: 'main.tex',
          version: 4,
          confirmPath: 'main.tex',
        })
        .catch((error: unknown) => error)
      // Overleaf may still act on a request whose answer was lost, so an unchanged file proves nothing.
      expect(failure).toMatchObject({ code: 'OUTCOME_UNKNOWN', details: { outcome: 'unknown' } })
      for (const setup of [applied, unchanged]) {
        expect(setup.fetches.filter(fetch => fetch.startsWith('POST'))).toHaveLength(1)
      }
    } finally {
      for (const setup of [applied, unchanged]) {
        await setup.runtime.close()
        await rm(setup.directory, { recursive: true, force: true })
      }
    }
  })
})
