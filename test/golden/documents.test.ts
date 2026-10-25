import { EventEmitter } from 'node:events'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, test } from 'vitest'

import { readConfig } from '../../src/config.js'
import { McpError } from '../../src/core/errors.js'
import type { HistorySnapshot, ShareJsComponent } from '../../src/protocol/ot.js'
import { ProjectConnection } from '../../src/protocol/project-connection.js'
import type { RawFolder } from '../../src/overleaf/tree.js'
import { OverleafRuntime } from '../../src/runtime.js'
import { createOverleafService } from '../../src/service/operations.js'
import { expectGolden } from '../helpers/golden.js'
import { applyShareJs } from '../helpers/overleaf-socket.js'
import { BOOTSTRAP_PAGE, cookieJar } from '../helpers/runtime.js'

const PROJECT = 'project'
const TIMESTAMP = '2026-01-01T00:00:00.000Z'

type Mark = 'insert' | 'delete' | undefined

/** One document as the fake Overleaf holds it. History-OT keeps tracked deletions in `content`. */
interface ServerDocument {
  protocol: 'sharejs' | 'history-ot'
  version: number
  content: string
  /** History-OT only: the tracked state of each UTF-16 unit of `content`. */
  marks: Mark[]
}

/** The project state every socket the runtime opens shares, so a rejoin sees what an update did. */
interface FakeOverleaf {
  root: RawFolder
  documents: Map<string, ServerDocument>
  trackChangesState?: boolean
  newDocumentProtocol: 'sharejs' | 'history-ot'
  /** The next applyOtUpdate applies and then fails as a socket would. */
  failNextApply?: 'timeout' | 'lost-socket'
  applied: number
}

function sharejs(content: string, version: number): ServerDocument {
  return { protocol: 'sharejs', version, content, marks: [] }
}

function history(content: string, version: number, deleted?: { pos: number; length: number }): ServerDocument {
  const marks: Mark[] = Array.from({ length: content.length }, (_, index) =>
    deleted !== undefined && index >= deleted.pos && index < deleted.pos + deleted.length ? 'delete' : undefined
  )
  return { protocol: 'history-ot', version, content, marks }
}

function fakeOverleaf(
  documents: Record<string, ServerDocument>,
  options: { trackChangesState?: boolean; newDocumentProtocol?: 'sharejs' | 'history-ot' } = {}
): FakeOverleaf {
  return {
    root: {
      _id: 'root-folder',
      name: 'rootFolder',
      docs: Object.keys(documents).map((id, index) => ({ _id: id, name: index === 0 ? 'main.tex' : `${id}.tex` })),
      fileRefs: [],
      folders: [],
    },
    documents: new Map(Object.entries(documents)),
    ...(options.trackChangesState === undefined ? {} : { trackChangesState: options.trackChangesState }),
    newDocumentProtocol: options.newDocumentProtocol ?? 'sharejs',
    applied: 0,
  }
}

function snapshotOf(document: ServerDocument): HistorySnapshot {
  const trackedChanges: NonNullable<HistorySnapshot['trackedChanges']> = []
  let start = 0
  for (let index = 1; index <= document.marks.length; index += 1) {
    if (index < document.marks.length && document.marks[index] === document.marks[start]) continue
    const type = document.marks[start]
    if (type !== undefined) {
      trackedChanges.push({ range: { pos: start, length: index - start }, tracking: { type, userId: 'user', ts: TIMESTAMP } })
    }
    start = index
  }
  return { content: document.content, comments: [], trackedChanges }
}

type TextComponent = number | string | { i: string; tracking: { type: Mark } } | { r: number; tracking: { type: Mark } }

/** Applies one history-OT text operation, which must span the whole raw content. */
function applyTextOperation(document: ServerDocument, operation: TextComponent[]): void {
  let cursor = 0
  let content = ''
  const marks: Mark[] = []
  const repeat = (mark: Mark, length: number): Mark[] => Array.from({ length }, () => mark)
  for (const component of operation) {
    if (typeof component === 'number' && component >= 0) {
      content += document.content.slice(cursor, cursor + component)
      marks.push(...document.marks.slice(cursor, cursor + component))
      cursor += component
    } else if (typeof component === 'number') {
      cursor -= component
    } else if (typeof component === 'string') {
      content += component
      marks.push(...repeat(undefined, component.length))
    } else if ('i' in component) {
      content += component.i
      marks.push(...repeat(component.tracking.type, component.i.length))
    } else {
      content += document.content.slice(cursor, cursor + component.r)
      marks.push(...repeat(component.tracking.type, component.r))
      cursor += component.r
    }
  }
  if (cursor !== document.content.length) throw new Error('the operation does not span the document')
  document.content = content
  document.marks = marks
}

/** A project socket that answers joinDoc, leaveDoc, and applyOtUpdate from the shared state. */
class FakePeer extends EventEmitter {
  closed = false
  readonly #server: FakeOverleaf

  constructor(server: FakeOverleaf) {
    super()
    this.#server = server
  }

  async call(name: string, args: unknown[]): Promise<unknown[]> {
    if (this.closed) throw new McpError('OUTCOME_UNKNOWN', 'Overleaf socket is not connected.')
    if (name === 'leaveDoc') return [null]
    const document = this.#server.documents.get(args[0] as string)
    if (document === undefined) return [{ message: 'not found' }]
    if (name === 'joinDoc') {
      return document.protocol === 'history-ot'
        ? [null, snapshotOf(document), document.version, [], {}, 'history-ot']
        : [
            null,
            document.content.split('\n').map(line => Buffer.from(line, 'utf8').toString('latin1')),
            document.version,
            [],
            {},
            'sharejs-text-ot',
          ]
    }
    if (name !== 'applyOtUpdate') throw new Error(`unexpected socket call ${name}`)
    const update = args[1] as { doc: string; v: number; op: unknown[] }
    if (update.v !== document.version) return [{ message: 'version mismatch' }]
    if (document.protocol === 'sharejs') {
      document.content = applyShareJs(document.content, update.op as ShareJsComponent[])
    } else {
      for (const step of update.op as Array<{ textOperation: TextComponent[] }>) {
        applyTextOperation(document, step.textOperation)
      }
    }
    document.version += 1
    this.#server.applied += 1
    const failure = this.#server.failNextApply
    delete this.#server.failNextApply
    if (failure === 'timeout') throw new McpError('TIMEOUT', 'Timed out waiting for otUpdateApplied.')
    if (failure === 'lost-socket') {
      this.closed = true
      throw new Error('socket closed')
    }
    setImmediate(() => this.emit('otUpdateApplied', { doc: update.doc, v: update.v }))
    return [null]
  }

  close(): void {
    this.closed = true
  }
}

function findFolder(folder: RawFolder, id: string): RawFolder | undefined {
  if (folder._id === id) return folder
  for (const child of folder.folders ?? []) {
    const found = findFolder(child, id)
    if (found !== undefined) return found
  }
  return undefined
}

/** A real runtime over the fake, with the operations as every interface calls them. */
async function open(server: FakeOverleaf) {
  const { cookiePath, directory } = await cookieJar()
  let created = 0
  const runtime = await OverleafRuntime.create(
    readConfig({
      OVERLEAF_COOKIE_JAR_FILE: cookiePath,
      OVERLEAF_BASE_URL: 'https://overleaf.test',
      OVERLEAF_BROWSER_PROFILE_DIR: join(directory, 'profile'),
      OVERLEAF_RECOVERY_TIMEOUT_MS: '500',
    }),
    {
      fetcher: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input))
        const method = init?.method ?? 'GET'
        if (method === 'GET' && url.pathname === '/project') return new Response(BOOTSTRAP_PAGE)
        if (method === 'POST' && url.pathname === `/project/${PROJECT}/doc`) {
          const body = JSON.parse(String(init?.body)) as { parent_folder_id: string; name: string }
          const folder = findFolder(server.root, body.parent_folder_id)
          if (folder === undefined) return new Response(null, { status: 404 })
          created += 1
          const id = `new-doc-${created}`
          ;(folder.docs ??= []).push({ _id: id, name: body.name })
          server.documents.set(
            id,
            server.newDocumentProtocol === 'sharejs' ? sharejs('', 0) : history('', 0)
          )
          return new Response(JSON.stringify({ _id: id, name: body.name }), {
            headers: { 'content-type': 'application/json' },
          })
        }
        throw new Error(`unexpected ${method} ${url.pathname}`)
      },
      connectionFactory: async projectId =>
        new ProjectConnection({
          projectId,
          peer: new FakePeer(server),
          join: {
            publicId: 'public',
            project: {
              _id: projectId,
              rootFolder: [structuredClone(server.root)],
              ...(server.trackChangesState === undefined ? {} : { trackChangesState: server.trackChangesState }),
            },
            permissionsLevel: 'owner',
            protocolVersion: 2,
          },
          supportedProtocolVersions: [2],
          currentUserId: 'user',
          callTimeoutMs: 1_000,
          applyTimeoutMs: 1_000,
        }),
    }
  )
  return { runtime, service: createOverleafService(runtime), directory }
}

type Opened = Awaited<ReturnType<typeof open>>

async function withService(server: FakeOverleaf, run: (opened: Opened) => Promise<void>): Promise<void> {
  const opened = await open(server)
  try {
    await run(opened)
  } finally {
    await opened.runtime.close()
  }
}

/** The text an editor shows: history-OT tracked deletions left out. */
function visible(server: FakeOverleaf, id: string): string {
  const document = server.documents.get(id)!
  return document.content
    .split('')
    .filter((_, index) => document.marks[index] !== 'delete')
    .join('')
}

describe('read_file', () => {
  test('a ShareJS document', async () => {
    const server = fakeOverleaf({ d1: sharejs('First placeholder line.\nSecond placeholder line.', 7) })
    await withService(server, async ({ service }) => {
      expectGolden('read_file', await service.read_file({ projectId: PROJECT, filePath: 'main.tex' }))
    })
  })

  test('a history-OT document, with a tracked deletion left out of content', async () => {
    const server = fakeOverleaf({ d1: history('Kept text. Dropped text.', 12, { pos: 10, length: 14 }) })
    await withService(server, async ({ service }) => {
      const result = await service.read_file({ projectId: PROJECT, filePath: 'main.tex' })
      expect((result as { content: string }).content).toBe('Kept text.')
      expectGolden('read_file', result)
    })
  })

  test('an empty document', async () => {
    const server = fakeOverleaf({ d1: sharejs('', 0) })
    await withService(server, async ({ service }) => {
      expectGolden('read_file', await service.read_file({ projectId: PROJECT, filePath: 'main.tex' }))
    })
  })

  test('a document in a project with track changes on', async () => {
    const server = fakeOverleaf({ d1: history('Placeholder text.', 2) }, { trackChangesState: true })
    await withService(server, async ({ service }) => {
      expectGolden('read_file', await service.read_file({ projectId: PROJECT, filePath: 'main.tex' }))
    })
  })
})

describe('write_file', () => {
  const cases: Array<{
    variant: string
    document: () => ServerDocument
    target: string
    writeMode?: 'untracked' | 'tracked'
    trackChangesState?: boolean
    applied: number
  }> = [
    { variant: 'untracked ShareJS', document: () => sharejs('Old placeholder.', 3), target: 'New placeholder.', applied: 1 },
    {
      variant: 'tracked ShareJS',
      document: () => sharejs('Old placeholder.', 3),
      target: 'New placeholder.',
      writeMode: 'tracked',
      applied: 1,
    },
    { variant: 'untracked history-OT', document: () => history('Draft sentence.', 5), target: 'Final sentence.', applied: 1 },
    {
      variant: 'tracked history-OT',
      document: () => history('Draft sentence.', 5),
      target: 'Final sentence.',
      writeMode: 'tracked',
      trackChangesState: true,
      applied: 1,
    },
    { variant: 'no-op untracked', document: () => sharejs('Same text.', 4), target: 'Same text.', applied: 0 },
    {
      variant: 'no-op tracked',
      document: () => history('Same text.', 4),
      target: 'Same text.',
      writeMode: 'tracked',
      applied: 0,
    },
    { variant: 'emptying the document', document: () => sharejs('Only line.', 9), target: '', applied: 1 },
  ]

  for (const entry of cases) {
    test(entry.variant, async () => {
      const server = fakeOverleaf(
        { d1: entry.document() },
        entry.trackChangesState === undefined ? {} : { trackChangesState: entry.trackChangesState }
      )
      await withService(server, async ({ service }) => {
        const read = (await service.read_file({ projectId: PROJECT, filePath: 'main.tex' })) as { revision: string }
        const result = await service.write_file({
          projectId: PROJECT,
          filePath: 'main.tex',
          revision: read.revision,
          content: entry.target,
          ...(entry.writeMode === undefined ? {} : { writeMode: entry.writeMode }),
        })
        expect(server.applied).toBe(entry.applied)
        expect(visible(server, 'd1')).toBe(entry.target)
        expectGolden('write_file', result)
      })
    })
  }

  test('content from a local file', async () => {
    const server = fakeOverleaf({ d1: sharejs('Old placeholder.', 3) })
    await withService(server, async ({ service, directory }) => {
      const localPath = join(directory, 'replacement.tex')
      await writeFile(localPath, 'Replacement placeholder.\r\n')
      const read = (await service.read_file({ projectId: PROJECT, filePath: 'main.tex' })) as { revision: string }
      const result = await service.write_file({ projectId: PROJECT, filePath: 'main.tex', revision: read.revision, localPath })
      expect(visible(server, 'd1')).toBe('Replacement placeholder.\n')
      expectGolden('write_file', result)
    })
  })

  for (const failure of ['timeout', 'lost-socket'] as const) {
    test(`recovered after a ${failure} once the update applied`, async () => {
      const server = fakeOverleaf({ d1: sharejs('Old placeholder.', 3) })
      await withService(server, async ({ service }) => {
        const read = (await service.read_file({ projectId: PROJECT, filePath: 'main.tex' })) as { revision: string }
        server.failNextApply = failure
        const result = await service.write_file({
          projectId: PROJECT,
          filePath: 'main.tex',
          revision: read.revision,
          content: 'New placeholder.',
        })
        expect(server.applied).toBe(1)
        expect(result).toMatchObject({ recoveredAfterTimeout: true })
        expectGolden('write_file', result)
      })
    })
  }
})

describe('create_file', () => {
  test('an empty document', async () => {
    const server = fakeOverleaf({ d1: sharejs('Main.', 1) })
    await withService(server, async ({ service }) => {
      const result = await service.create_file({ projectId: PROJECT, filePath: 'empty.tex' })
      expect(server.applied).toBe(0)
      expectGolden('create_file', result)
    })
  })

  test('untracked initial content on a ShareJS document', async () => {
    const server = fakeOverleaf({ d1: sharejs('Main.', 1) })
    await withService(server, async ({ service }) => {
      const result = await service.create_file({
        projectId: PROJECT,
        filePath: 'chapter.tex',
        content: 'Chapter placeholder.',
      })
      expect(visible(server, 'new-doc-1')).toBe('Chapter placeholder.')
      expectGolden('create_file', result)
    })
  })

  test('tracked initial content on a history-OT document with track changes on', async () => {
    const server = fakeOverleaf({ d1: history('Main.', 1) }, { trackChangesState: true, newDocumentProtocol: 'history-ot' })
    await withService(server, async ({ service }) => {
      const result = await service.create_file({
        projectId: PROJECT,
        filePath: 'chapter.tex',
        content: 'Chapter placeholder.',
        writeMode: 'tracked',
      })
      expect(visible(server, 'new-doc-1')).toBe('Chapter placeholder.')
      expectGolden('create_file', result)
    })
  })

  test('initial content recovered after a timeout', async () => {
    const server = fakeOverleaf({ d1: sharejs('Main.', 1) })
    await withService(server, async ({ service }) => {
      server.failNextApply = 'timeout'
      const result = await service.create_file({
        projectId: PROJECT,
        filePath: 'chapter.tex',
        content: 'Chapter placeholder.',
        writeMode: 'tracked',
      })
      expect(result).toMatchObject({ recoveredAfterTimeout: true })
      expectGolden('create_file', result)
    })
  })
})
