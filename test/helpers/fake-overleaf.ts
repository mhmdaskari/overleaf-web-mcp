import { EventEmitter } from 'node:events'
import { join } from 'node:path'

import { readConfig, type AppConfig } from '../../src/config.js'
import { McpError } from '../../src/core/errors.js'
import type { RawFolder } from '../../src/overleaf/tree.js'
import type { HistorySnapshot, ShareJsComponent } from '../../src/protocol/ot.js'
import { ProjectConnection } from '../../src/protocol/project-connection.js'
import { OverleafRuntime, type RuntimeDependencies } from '../../src/runtime.js'
import { createOverleafService } from '../../src/service/operations.js'
import { applyShareJs } from './overleaf-socket.js'
import { BOOTSTRAP_PAGE, cookieJar } from './runtime.js'

/** The one project the fake serves. */
export const PROJECT = 'project'
const TIMESTAMP = '2026-01-01T00:00:00.000Z'

type Mark = 'insert' | 'delete' | undefined

/** One document as the fake Overleaf holds it. History-OT keeps tracked deletions in `content`. */
export interface ServerDocument {
  protocol: 'sharejs' | 'history-ot'
  version: number
  content: string
  /** History-OT only: the tracked state of each UTF-16 unit of `content`. */
  marks: Mark[]
}

/** The project state every socket the runtime opens shares, so a rejoin sees what an update did. */
export interface FakeOverleaf {
  root: RawFolder
  documents: Map<string, ServerDocument>
  trackChangesState?: boolean
  newDocumentProtocol: 'sharejs' | 'history-ot'
  /** The next applyOtUpdate applies and then fails as a socket would. */
  failNextApply?: 'timeout' | 'lost-socket'
  applied: number
  /** Every request after the bootstrap `GET /project`, as `METHOD /path`. */
  requests: string[]
  /** Every bootstrap `GET /project`, one per runtime opened. */
  bootstraps: number
  /** Every project socket a runtime opened, in order. */
  peers: FakePeer[]
}

export function sharejs(content: string, version: number): ServerDocument {
  return { protocol: 'sharejs', version, content, marks: [] }
}

export function history(content: string, version: number, deleted?: { pos: number; length: number }): ServerDocument {
  const marks: Mark[] = Array.from({ length: content.length }, (_, index) =>
    deleted !== undefined && index >= deleted.pos && index < deleted.pos + deleted.length ? 'delete' : undefined
  )
  return { protocol: 'history-ot', version, content, marks }
}

/** A project whose first document is `main.tex` and every other `<id>.tex`, all in the root folder. */
export function fakeOverleaf(
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
    requests: [],
    bootstraps: 0,
    peers: [],
  }
}

function snapshotOf(document: ServerDocument): HistorySnapshot {
  const trackedChanges: NonNullable<HistorySnapshot['trackedChanges']> = []
  let start = 0
  for (let index = 1; index <= document.marks.length; index += 1) {
    if (index < document.marks.length && document.marks[index] === document.marks[start]) continue
    const type = document.marks[start]
    if (type !== undefined) {
      trackedChanges.push({
        range: { pos: start, length: index - start },
        tracking: { type, userId: 'user', ts: TIMESTAMP },
      })
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
export class FakePeer extends EventEmitter {
  closed = false
  /** Every socket call this peer received, by name. */
  readonly calls: string[] = []
  readonly #server: FakeOverleaf

  constructor(server: FakeOverleaf) {
    super()
    this.#server = server
  }

  async call(name: string, args: unknown[]): Promise<unknown[]> {
    this.calls.push(name)
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

/**
 * The configuration and injected fetcher and socket factory of a session over the fake, as
 * `OverleafRuntime.create` and `createOverleafClient` take them. `directory` is a fresh folder
 * holding the session's protected cookie jar, free for local files.
 */
export async function fakeSession(
  server: FakeOverleaf
): Promise<{ config: AppConfig; dependencies: RuntimeDependencies; directory: string }> {
  const { cookiePath, directory } = await cookieJar()
  let created = 0
  const config = readConfig({
    OVERLEAF_COOKIE_JAR_FILE: cookiePath,
    OVERLEAF_BASE_URL: 'https://overleaf.test',
    OVERLEAF_BROWSER_PROFILE_DIR: join(directory, 'profile'),
    OVERLEAF_RECOVERY_TIMEOUT_MS: '500',
  })
  const dependencies: RuntimeDependencies = {
    fetcher: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      const method = init?.method ?? 'GET'
      if (method === 'GET' && url.pathname === '/project') {
        server.bootstraps += 1
        return new Response(BOOTSTRAP_PAGE)
      }
      server.requests.push(`${method} ${url.pathname}`)
      if (method === 'POST' && url.pathname === '/api/project') {
        return Response.json({
          totalSize: 1,
          projects: [{ _id: PROJECT, name: 'Placeholder project', accessLevel: 'owner' }],
        })
      }
      if (method === 'POST' && url.pathname === `/project/${PROJECT}/doc`) {
        const body = JSON.parse(String(init?.body)) as { parent_folder_id: string; name: string }
        const folder = findFolder(server.root, body.parent_folder_id)
        if (folder === undefined) return new Response(null, { status: 404 })
        created += 1
        const id = `new-doc-${created}`
        ;(folder.docs ??= []).push({ _id: id, name: body.name })
        server.documents.set(id, server.newDocumentProtocol === 'sharejs' ? sharejs('', 0) : history('', 0))
        return new Response(JSON.stringify({ _id: id, name: body.name }), {
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`unexpected ${method} ${url.pathname}`)
    },
    connectionFactory: async projectId => {
      const peer = new FakePeer(server)
      server.peers.push(peer)
      return new ProjectConnection({
        projectId,
        peer,
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
      })
    },
  }
  return { config, dependencies, directory }
}

/** A real runtime over the fake, with the operations as every interface calls them. */
export async function openFakeRuntime(server: FakeOverleaf) {
  const { config, dependencies, directory } = await fakeSession(server)
  const runtime = await OverleafRuntime.create(config, dependencies)
  return { runtime, service: createOverleafService(runtime), directory }
}

/** The text an editor shows: history-OT tracked deletions left out. */
export function visible(server: FakeOverleaf, id: string): string {
  const document = server.documents.get(id)!
  return document.content
    .split('')
    .filter((_, index) => document.marks[index] !== 'delete')
    .join('')
}
