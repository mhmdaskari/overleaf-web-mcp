import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'vitest'

import { readConfig } from '../../src/config.js'
import type { OperationName } from '../../src/contracts/operations.js'
import { parseOperationInput } from '../../src/contracts/parse.js'
import type { OverleafService } from '../../src/contracts/service.js'
import { gitBlobHash } from '../../src/core/hash.js'
import type { RawEntity, RawFolder } from '../../src/overleaf/tree.js'
import { ProjectConnection, type JoinProjectData, type SocketPeerLike } from '../../src/protocol/project-connection.js'
import { OverleafRuntime } from '../../src/runtime.js'
import { createOverleafService } from '../../src/service/operations.js'
import { expectGolden } from '../helpers/golden.js'
import { BOOTSTRAP_PAGE, cookieJar } from '../helpers/runtime.js'

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

/** The project-level settings joinProject may carry next to the tree. */
type ProjectSettings = Partial<
  Pick<JoinProjectData['project'], 'rootDoc_id' | 'compiler' | 'imageName' | 'spellCheckLanguage' | 'trackChangesState'>
>

const PROJECT = 'project'
/** The account id BOOTSTRAP_PAGE carries as ol-user_id. */
const USER = 'user'
const PLOT_BYTES = Buffer.from('placeholder image bytes')
const PLOT_HASH = gitBlobHash(PLOT_BYTES)
const MAIN_TEXT = '\\documentclass{article}\n\\begin{document}\nPlaceholder.\n\\end{document}\n'

/**
 * Raw entities carry more than id, name, and hash on the wire, and a hash need not be a string;
 * the extra keys here show the tree is rebuilt key by key rather than passed through.
 */
function raw(entity: { _id: string; name: string } & Record<string, unknown>): RawEntity {
  return entity
}

/** Nested folders, documents, binary files with a hash, and one older binary without one. */
const NESTED_ROOT: RawFolder = {
  _id: 'folder-root',
  name: 'rootFolder',
  docs: [raw({ _id: 'doc-main', name: 'main.tex' })],
  fileRefs: [raw({ _id: 'file-plot', name: 'plot.png', hash: PLOT_HASH, created: '2026-01-01T00:00:00.000Z', linkedFileData: null })],
  folders: [
    {
      _id: 'folder-chapters',
      name: 'chapters',
      docs: [raw({ _id: 'doc-intro', name: 'intro.tex' })],
      fileRefs: [],
      folders: [
        {
          _id: 'folder-appendix',
          name: 'appendix',
          docs: [raw({ _id: 'doc-proofs', name: 'proofs.tex' })],
          fileRefs: [raw({ _id: 'file-data', name: 'data.csv', hash: gitBlobHash(Buffer.from('a,b\n1,2\n')) })],
          folders: [],
        },
      ],
    },
    {
      _id: 'folder-figures',
      name: 'figures',
      docs: [],
      fileRefs: [raw({ _id: 'file-legacy', name: 'legacy.pdf', created: '2026-01-01T00:00:00.000Z' })],
      folders: [],
    },
  ],
}

/** A peer that answers nothing: these operations read the joined tree and never call the socket. */
function silentPeer(): SocketPeerLike {
  const peer: SocketPeerLike = {
    on: () => peer,
    once: () => peer,
    removeListener: () => peer,
    call: async (name: string) => {
      throw new Error(`unexpected socket call ${name}`)
    },
    close() {},
  }
  return peer
}

/**
 * A real `OverleafRuntime` whose joined project carries `settings` beside the tree, which
 * `createTestRuntime` cannot set. Every request but the bootstrap goes to `fetcher`.
 */
async function goldenRuntime(rootFolder: RawFolder, settings: ProjectSettings = {}, fetcher?: Fetcher) {
  const { cookiePath, directory } = await cookieJar()
  const requests: string[] = []
  const runtime = await OverleafRuntime.create(
    readConfig({
      OVERLEAF_COOKIE_JAR_FILE: cookiePath,
      OVERLEAF_BASE_URL: 'https://overleaf.test',
      OVERLEAF_BROWSER_PROFILE_DIR: join(directory, 'profile'),
    }),
    {
      fetcher: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input))
        const method = init?.method ?? 'GET'
        if (method === 'GET' && url.pathname === '/project') return new Response(BOOTSTRAP_PAGE)
        requests.push(`${method} ${url.pathname}`)
        if (fetcher !== undefined) return await fetcher(input, init)
        throw new Error(`unexpected ${method} ${url.pathname}`)
      },
      connectionFactory: async projectId =>
        new ProjectConnection({
          projectId,
          peer: silentPeer(),
          join: {
            publicId: 'public',
            project: { _id: projectId, rootFolder: [structuredClone(rootFolder)], ...structuredClone(settings) },
            permissionsLevel: 'owner',
            protocolVersion: 2,
          },
          supportedProtocolVersions: [2],
          // The runtime passes the bootstrap page's user id, so per-user track changes resolve as in production.
          currentUserId: USER,
        }),
    }
  )
  const service = createOverleafService(runtime)
  return {
    runtime,
    requests,
    service,
    close: async () => {
      await runtime.close()
      await rm(directory, { recursive: true, force: true })
    },
  }
}

/** Calls an operation with its input parsed as the MCP server parses it, defaults applied. */
async function run(service: OverleafService, name: OperationName, input: unknown): Promise<unknown> {
  const handler = service[name] as (input: unknown) => Promise<unknown>
  return await handler(parseOperationInput(name, input))
}

/** Answers each `METHOD /path` with its response; anything else fails the test. */
function routes(table: Record<string, () => Response>): Fetcher {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const key = `${init?.method ?? 'GET'} ${url.pathname}`
    const answer = table[key]
    if (answer === undefined) throw new Error(`unexpected ${key}`)
    return answer()
  }
}

const json = (value: unknown) => () =>
  new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
const noContent = () => new Response(null, { status: 204 })

describe('get_project_tree golden results', () => {
  test('a nested tree with every project setting and track changes on', async () => {
    const harness = await goldenRuntime(NESTED_ROOT, {
      rootDoc_id: 'doc-main',
      compiler: 'xelatex',
      imageName: 'texlive-full:2025.1',
      spellCheckLanguage: 'en',
      trackChangesState: true,
    })
    try {
      const result = await run(harness.service, 'get_project_tree', { projectId: PROJECT })
      expectGolden('get_project_tree', result)
      expect(harness.requests).toEqual([])
    } finally {
      await harness.close()
    }
  })

  test('an empty project with no settings, empty-string settings, and a root document that is gone', async () => {
    const harness = await goldenRuntime(
      { _id: 'folder-root', name: 'rootFolder', docs: [], fileRefs: [], folders: [] },
      { rootDoc_id: 'doc-gone', compiler: '', imageName: '', spellCheckLanguage: '', trackChangesState: { 'user-other': true } }
    )
    try {
      const result = await run(harness.service, 'get_project_tree', { projectId: PROJECT })
      // Track changes on for another collaborator only is off for this account.
      expect(result).toMatchObject({ trackChangesActive: false })
      expectGolden('get_project_tree', result)
    } finally {
      await harness.close()
    }
  })

  test('track changes on for this account only', async () => {
    const harness = await goldenRuntime(
      { _id: 'folder-root', name: 'rootFolder', docs: [raw({ _id: 'doc-main', name: 'main.tex' })], fileRefs: [], folders: [] },
      { trackChangesState: { [USER]: true, 'user-other': false, __guests__: false } }
    )
    try {
      const result = await run(harness.service, 'get_project_tree', { projectId: PROJECT })
      expect(result).toMatchObject({ trackChangesActive: true })
      expectGolden('get_project_tree', result)
    } finally {
      await harness.close()
    }
  })

  test('a binary file whose hash is null in the joined tree has no hash key', async () => {
    const harness = await goldenRuntime({
      _id: 'folder-root',
      name: 'rootFolder',
      docs: [],
      fileRefs: [
        raw({ _id: 'file-pending', name: 'pending.png', hash: null }),
        raw({ _id: 'file-plot', name: 'plot.png', hash: PLOT_HASH }),
      ],
      folders: [],
    })
    try {
      const result = (await run(harness.service, 'get_project_tree', { projectId: PROJECT })) as {
        entities: Array<{ id: string }>
      }
      const byId = new Map(result.entities.map(entity => [entity.id, entity]))
      expect(byId.get('file-pending')).not.toHaveProperty('hash')
      expect(byId.get('file-plot')).toHaveProperty('hash', PLOT_HASH)
      expectGolden('get_project_tree', result)
    } finally {
      await harness.close()
    }
  })
})

describe('manage_entity golden results', () => {
  test('create_folder, reducing the folder Overleaf returns to its id and name', async () => {
    const harness = await goldenRuntime(NESTED_ROOT, {}, routes({
      [`POST /project/${PROJECT}/folder`]: json({
        _id: 'folder-tables',
        name: 'tables',
        docs: [],
        fileRefs: [],
        folders: [],
      }),
    }))
    try {
      expectGolden('manage_entity', await run(harness.service, 'manage_entity', {
        projectId: PROJECT,
        action: 'create_folder',
        path: 'chapters/tables',
      }))
      expect(harness.requests).toEqual([`POST /project/${PROJECT}/folder`])
    } finally {
      await harness.close()
    }
  })

  test('create_folder when Overleaf answers without the folder', async () => {
    const harness = await goldenRuntime(NESTED_ROOT, { trackChangesState: true }, routes({
      [`POST /project/${PROJECT}/folder`]: () => new Response(''),
    }))
    try {
      expectGolden('manage_entity', await run(harness.service, 'manage_entity', {
        projectId: PROJECT,
        action: 'create_folder',
        path: 'notes',
      }))
    } finally {
      await harness.close()
    }
  })

  test('rename a document', async () => {
    const harness = await goldenRuntime(NESTED_ROOT, {}, routes({
      [`POST /project/${PROJECT}/doc/doc-intro/rename`]: noContent,
    }))
    try {
      expectGolden('manage_entity', await run(harness.service, 'manage_entity', {
        projectId: PROJECT,
        action: 'rename',
        path: 'chapters/intro.tex',
        newName: 'introduction.tex',
      }))
    } finally {
      await harness.close()
    }
  })

  test('move a binary file, with track changes on', async () => {
    const harness = await goldenRuntime(NESTED_ROOT, { trackChangesState: true }, routes({
      [`POST /project/${PROJECT}/file/file-plot/move`]: noContent,
    }))
    try {
      expectGolden('manage_entity', await run(harness.service, 'manage_entity', {
        projectId: PROJECT,
        action: 'move',
        path: 'plot.png',
        destinationFolderPath: 'figures',
      }))
    } finally {
      await harness.close()
    }
  })

  test('delete a folder', async () => {
    const harness = await goldenRuntime(NESTED_ROOT, {}, routes({
      [`DELETE /project/${PROJECT}/folder/folder-appendix`]: noContent,
    }))
    try {
      expectGolden('manage_entity', await run(harness.service, 'manage_entity', {
        projectId: PROJECT,
        action: 'delete',
        path: 'chapters/appendix',
        confirmPath: 'chapters/appendix',
      }))
    } finally {
      await harness.close()
    }
  })

  // Overleaf's answer to a rename or delete is not part of the result: none of its keys, an
  // address among them, may reach the caller.
  test('delete a document whose response is a JSON body with extra keys', async () => {
    const harness = await goldenRuntime(NESTED_ROOT, {}, routes({
      [`DELETE /project/${PROJECT}/doc/doc-proofs`]: json({
        _id: 'doc-proofs',
        deleted: true,
        deletedBy: { id: 'user-other', email: 'collaborator@example.test' },
        project: { name: 'Placeholder project' },
      }),
    }))
    try {
      const result = await run(harness.service, 'manage_entity', {
        projectId: PROJECT,
        action: 'delete',
        path: 'chapters/appendix/proofs.tex',
        confirmPath: 'chapters/appendix/proofs.tex',
      })
      expect(harness.requests).toEqual([`DELETE /project/${PROJECT}/doc/doc-proofs`])
      expect(JSON.stringify(result)).not.toContain('example.test')
      expectGolden('manage_entity', result)
    } finally {
      await harness.close()
    }
  })

  test('rename a binary file whose response is a JSON body with extra keys', async () => {
    const harness = await goldenRuntime(NESTED_ROOT, {}, routes({
      [`POST /project/${PROJECT}/file/file-data/rename`]: json({
        _id: 'file-data',
        name: 'values.csv',
        rev: 3,
        owner: { email: 'owner@example.test', first_name: 'Placeholder' },
      }),
    }))
    try {
      const result = await run(harness.service, 'manage_entity', {
        projectId: PROJECT,
        action: 'rename',
        path: 'chapters/appendix/data.csv',
        newName: 'values.csv',
      })
      expect(harness.requests).toEqual([`POST /project/${PROJECT}/file/file-data/rename`])
      expect(JSON.stringify(result)).not.toContain('example.test')
      expectGolden('manage_entity', result)
    } finally {
      await harness.close()
    }
  })
})

describe('download_file golden results', () => {
  // localPath is echoed as given, so the temporary folder is replaced by a fixed token for the snapshot.
  const FOLDER = '<download-folder>'

  test('a text document to a new local file', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'overleaf-golden-download-'))
    const harness = await goldenRuntime(NESTED_ROOT, {}, routes({
      [`GET /Project/${PROJECT}/doc/doc-main/download`]: () => new Response(MAIN_TEXT),
    }))
    try {
      const localPath = join(folder, 'main.tex')
      const result = (await run(harness.service, 'download_file', {
        projectId: PROJECT,
        filePath: 'main.tex',
        localPath,
      })) as { localPath: string }
      expect(result.localPath).toBe(localPath)
      await expect(readFile(localPath, 'utf8')).resolves.toBe(MAIN_TEXT)
      expectGolden('download_file', { ...result, localPath: result.localPath.replace(folder, FOLDER) })
    } finally {
      await harness.close()
      await rm(folder, { recursive: true, force: true })
    }
  })

  test('a binary file replacing an existing local file with overwrite', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'overleaf-golden-download-'))
    const harness = await goldenRuntime(NESTED_ROOT, {}, routes({
      [`GET /Project/${PROJECT}/file/file-plot`]: () => new Response(PLOT_BYTES),
    }))
    try {
      const localPath = join(folder, 'plot.png')
      await writeFile(localPath, 'older bytes')
      const result = (await run(harness.service, 'download_file', {
        projectId: PROJECT,
        filePath: 'plot.png',
        localPath,
        overwrite: true,
      })) as { localPath: string }
      expect(result.localPath).toBe(localPath)
      await expect(readFile(localPath)).resolves.toEqual(PLOT_BYTES)
      expectGolden('download_file', { ...result, localPath: result.localPath.replace(folder, FOLDER) })
    } finally {
      await harness.close()
      await rm(folder, { recursive: true, force: true })
    }
  })
})
