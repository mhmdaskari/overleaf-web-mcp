import { EventEmitter } from 'node:events'

import { describe, expect, test } from 'vitest'

import { createRevision } from '../../src/core/revision.js'
import { DocumentsApi } from '../../src/overleaf/documents.js'
import { ProjectConnectionCache } from '../../src/protocol/connection-cache.js'
import { ProjectConnection } from '../../src/protocol/project-connection.js'
import { SocketIo09Peer } from '../../src/protocol/socketio09-client.js'

interface ServerDocument {
  content: string
  version: number
}

type Handler = (socket: FakeOverleafSocket, name: string, args: unknown[], ackId: number) => void

/** Answers joinDoc and leaveDoc like Overleaf; applyOtUpdate is left to each test. */
class FakeOverleafSocket extends EventEmitter {
  readyState = 1
  readonly events: string[] = []

  constructor(
    readonly document: ServerDocument,
    readonly onApply: Handler
  ) {
    super()
  }

  send(value: string): void {
    const match = /^5:(\d+)\+::(.*)$/su.exec(value)
    if (!match) return
    const ackId = Number(match[1])
    const { name, args } = JSON.parse(match[2]!) as { name: string; args: unknown[] }
    this.events.push(name)
    if (name === 'joinDoc') {
      const lines = this.document.content
        .split('\n')
        .map(line => Buffer.from(line, 'utf8').toString('latin1'))
      this.ack(ackId, [null, lines, this.document.version, [], {}, 'sharejs-text-ot'])
    } else if (name === 'leaveDoc') {
      this.ack(ackId, [null])
    } else if (name === 'applyOtUpdate') {
      this.onApply(this, name, args, ackId)
    }
  }

  ack(ackId: number, args: unknown[]): void {
    setImmediate(() => this.emit('message', Buffer.from(`6:::${ackId}+${JSON.stringify(args)}`)))
  }

  /** Overleaf closing the socket, as it does after refusing an update or during a drain. */
  close(): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.emit('close')
  }
}

const join = {
  publicId: 'P.client',
  project: {
    _id: 'project',
    rootFolder: [
      {
        _id: 'root',
        name: 'rootFolder',
        docs: [{ _id: 'doc', name: 'main.tex' }],
        fileRefs: [],
        folders: [],
      },
    ],
  },
  permissionsLevel: 'owner',
  protocolVersion: 2,
}

function createStack(document: ServerDocument, onApply: Handler) {
  const sockets: FakeOverleafSocket[] = []
  const cache = new ProjectConnectionCache<ProjectConnection>({
    capacity: 2,
    idleTtlMs: 60_000,
    factory: async projectId => {
      const socket = new FakeOverleafSocket(document, onApply)
      sockets.push(socket)
      return new ProjectConnection({
        projectId,
        peer: new SocketIo09Peer(socket),
        join: structuredClone(join),
        supportedProtocolVersions: [2],
        callTimeoutMs: 1_000,
        applyTimeoutMs: 1_000,
      })
    },
  })
  const api = new DocumentsApi(cache, { recoveryTimeoutMs: 50, recoveryPollIntervalMs: 0 })
  return { api, cache, sockets }
}

describe('project socket recovery', () => {
  test('opens a fresh socket for the next call after Overleaf closes the cached one', async () => {
    const { api, cache, sockets } = createStack({ content: 'text', version: 3 }, () => undefined)

    await expect(api.readFile('project', 'main.tex')).resolves.toMatchObject({ content: 'text' })
    sockets[0]!.close()

    await expect(api.readFile('project', 'main.tex')).resolves.toMatchObject({ content: 'text' })
    expect(sockets).toHaveLength(2)
    await cache.closeAll()
  })

  test('classifies a write whose socket closed before its acknowledgement without sending it again', async () => {
    const document = { content: 'old', version: 3 }
    const { api, cache, sockets } = createStack(document, socket => {
      // Overleaf applied the update, then the socket closed before the acknowledgement arrived.
      document.content = 'new'
      document.version = 4
      setImmediate(() => socket.close())
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
    const applies = sockets.flatMap(socket => socket.events).filter(name => name === 'applyOtUpdate')
    expect(applies).toHaveLength(1)
    expect(sockets).toHaveLength(2)
    await cache.closeAll()
  })

  test('reports a write as not applied when the original stays live after its socket closed', async () => {
    const document = { content: 'old', version: 3 }
    const { api, cache, sockets } = createStack(document, socket => {
      setImmediate(() => socket.close())
    })
    const revision = createRevision({
      projectId: 'project',
      docId: 'doc',
      protocol: 'sharejs',
      otVersion: 3,
      content: 'old',
    })

    await expect(api.writeFile('project', 'main.tex', revision, 'new')).rejects.toMatchObject({
      details: expect.objectContaining({ outcome: 'not_applied' }),
    })
    const applies = sockets.flatMap(socket => socket.events).filter(name => name === 'applyOtUpdate')
    expect(applies).toHaveLength(1)
    await cache.closeAll()
  })
})
