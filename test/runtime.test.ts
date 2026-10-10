import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test, vi } from 'vitest'

import { readConfig } from '../src/config.js'
import { gitBlobHash } from '../src/core/hash.js'
import { AccessPolicy } from '../src/core/policy.js'
import type { RawFolder } from '../src/overleaf/tree.js'
import { ProjectConnection } from '../src/protocol/project-connection.js'
import { OverleafRuntime } from '../src/runtime.js'

function runtimeWithWrites(userId: string | null = 'user') {
  const entities = { createEmptyFile: vi.fn(async () => undefined) }
  const documents = {
    readFile: vi.fn(async () => ({
      content: '',
      revision: 'revision',
      newline: 'LF' as const,
      protocol: 'sharejs' as const,
      trackChangesActive: false,
    })),
    writeFile: vi.fn(async () => ({
      revision: 'new-revision',
      protocol: 'sharejs' as const,
      trackChangesActive: false,
      writeMode: 'tracked' as const,
    })),
  }
  const runtime = Object.assign(Object.create(OverleafRuntime.prototype), {
    entities,
    documents,
    policy: AccessPolicy.permissive,
    ...(userId === null ? {} : { userId }),
  }) as OverleafRuntime
  return { runtime, entities, documents }
}

describe('runtime bootstrap', () => {
  test('loads a protected browser cookie jar and discovers account metadata', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'overleaf-runtime-'))
    const cookiePath = join(directory, 'cookies.txt')
    await writeFile(
      cookiePath,
      '# Netscape HTTP Cookie File\n.overleaf.test\tTRUE\t/\tTRUE\t2147483647\toverleaf.sid\tsession\n'
    )
    if (process.platform !== 'win32') await chmod(cookiePath, 0o600)
    const config = readConfig({
      OVERLEAF_COOKIE_JAR_FILE: cookiePath,
      OVERLEAF_BASE_URL: 'https://overleaf.test',
    })
    const runtime = await OverleafRuntime.create(config, {
      fetcher: async input => {
        const url = String(input)
        if (url.endsWith('/api/project')) {
          return new Response(
            JSON.stringify({ totalSize: 1, projects: [{ _id: 'p', name: 'Paper', accessLevel: 'owner' }] }),
            { headers: { 'content-type': 'application/json' } }
          )
        }
        if (url.endsWith('/project')) {
          return new Response(
            '<meta name="ol-csrfToken" content="csrf"><meta name="ol-user_id" content="user">'
          )
        }
        throw new Error(`unexpected URL ${url}`)
      },
      connectionFactory: async () => {
        throw new Error('socket should not be opened by auth_status')
      },
    })

    await expect(runtime.authStatus()).resolves.toMatchObject({
      authenticated: true,
      userId: 'user',
      projectCount: 1,
      baseUrl: 'https://overleaf.test',
      sessionExpiresAt: '2038-01-19T03:14:07.000Z',
    })
    await runtime.close()
  })

  test('tracks non-empty initial file content when requested', async () => {
    const { runtime, documents } = runtimeWithWrites()

    await runtime.createFile('project', 'chapter.tex', 'Tracked content', 'tracked')

    expect(documents.writeFile).toHaveBeenCalledWith(
      'project',
      'chapter.tex',
      'revision',
      'Tracked content',
      'tracked'
    )
  })

  test('rejects tracked empty file creation before creating an entity', async () => {
    const { runtime, entities } = runtimeWithWrites()

    await expect(
      runtime.createFile('project', 'chapter.tex', '', 'tracked')
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(entities.createEmptyFile).not.toHaveBeenCalled()
  })

  test('rejects tracked file creation without a user identity before creating an entity', async () => {
    const { runtime, entities } = runtimeWithWrites(null)

    await expect(
      runtime.createFile('project', 'chapter.tex', 'Tracked content', 'tracked')
    ).rejects.toMatchObject({ code: 'PROTOCOL_UNSUPPORTED' })
    expect(entities.createEmptyFile).not.toHaveBeenCalled()
  })
})

describe('folder sync through the real runtime', () => {
  test('plans and mirrors a folder through the connection cache, REST uploads, and deletes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'overleaf-runtime-sync-'))
    const cookiePath = join(directory, 'cookies.txt')
    await writeFile(
      cookiePath,
      '# Netscape HTTP Cookie File\n.overleaf.test\tTRUE\t/\tTRUE\t2147483647\toverleaf.sid\tsession\n'
    )
    if (process.platform !== 'win32') await chmod(cookiePath, 0o600)
    const local = await mkdtemp(join(tmpdir(), 'overleaf-runtime-local-'))
    await writeFile(join(local, 'main.tex'), 'same')
    await writeFile(join(local, 'new.png'), 'new')

    const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)
    const root: RawFolder = {
      _id: 'root',
      name: 'rootFolder',
      docs: [{ _id: 'd1', name: 'main.tex' }],
      fileRefs: [{ _id: 'f1', name: 'old.png', hash: gitBlobHash(bytes('old')) }],
      folders: [{ _id: 'fs', name: 'stale', fileRefs: [{ _id: 'f2', name: 'x.png', hash: gitBlobHash(bytes('x')) }] }],
    }
    const requests: string[] = []
    let joins = 0

    const runtime = await OverleafRuntime.create(
      readConfig({ OVERLEAF_COOKIE_JAR_FILE: cookiePath, OVERLEAF_BASE_URL: 'https://overleaf.test' }),
      {
        fetcher: async (input, init) => {
          const url = new URL(String(input))
          const method = init?.method ?? 'GET'
          if (method === 'GET' && url.pathname === '/project') {
            return new Response('<meta name="ol-csrfToken" content="csrf"><meta name="ol-user_id" content="user">')
          }
          requests.push(`${method} ${url.pathname}`)
          if (method === 'POST' && url.pathname === '/project/p/upload') {
            const file = (init?.body as FormData).get('qqfile') as Blob
            const hash = gitBlobHash(new Uint8Array(await file.arrayBuffer()))
            root.fileRefs!.push({ _id: 'f3', name: (init?.body as FormData).get('name') as string, hash })
            return new Response(JSON.stringify({ success: true, entity_id: 'f3', entity_type: 'file', hash }), {
              headers: { 'content-type': 'application/json' },
            })
          }
          if (method === 'DELETE' && url.pathname === '/project/p/file/f1') {
            root.fileRefs = root.fileRefs!.filter(file => file._id !== 'f1')
            return new Response(null, { status: 204 })
          }
          if (method === 'DELETE' && url.pathname === '/project/p/folder/fs') {
            root.folders = []
            return new Response(null, { status: 204 })
          }
          throw new Error(`unexpected ${method} ${url.pathname}`)
        },
        connectionFactory: async projectId => {
          joins += 1
          const peer = {
            on() {
              return peer
            },
            once() {
              return peer
            },
            removeListener() {
              return peer
            },
            call: async (name: string) =>
              name === 'joinDoc' ? [null, ['same'], 3, null, {}, 'sharejs-text-ot'] : [null],
            close() {},
          }
          return new ProjectConnection({
            projectId,
            peer,
            join: {
              publicId: 'public',
              project: { _id: projectId, rootFolder: [structuredClone(root)] },
              permissionsLevel: 'owner',
              protocolVersion: 2,
            },
            supportedProtocolVersions: [2],
          })
        },
      }
    )

    try {
      const plan = await runtime.sync.planSync('p', local)
      expect(plan.toUpload.map(entry => entry.destinationPath)).toEqual(['new.png'])
      expect(plan.identical).toEqual({ count: 1, paths: ['main.tex'] })
      expect(plan.remoteOnly.map(entry => [entry.destinationPath, entry.contains])).toEqual([
        ['old.png', undefined],
        ['stale', 1],
      ])

      const result = await runtime.sync.syncDirectory('p', local, {
        mode: 'mirror',
        planToken: plan.planToken,
        confirmDeleteCount: 2,
      })
      expect(result).toMatchObject({ status: 'complete', failed: [], remaining: [] })
      expect(requests).toEqual([
        'POST /project/p/upload',
        'DELETE /project/p/file/f1',
        'DELETE /project/p/folder/fs',
      ])
      // Every decision is made from a freshly joined tree, never a cached one.
      expect(joins).toBeGreaterThan(3)

      const again = await runtime.sync.planSync('p', local)
      expect(again).toMatchObject({ toUpload: [], remoteOnly: [], identical: { count: 2 } })
      expect(again.planToken).toBe(result.planToken)
    } finally {
      await runtime.close()
    }
  })
})
