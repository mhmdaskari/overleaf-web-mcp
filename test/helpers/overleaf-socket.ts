import { EventEmitter } from 'node:events'

import { DocumentsApi } from '../../src/overleaf/documents.js'
import { ProjectConnectionCache } from '../../src/protocol/connection-cache.js'
import { ProjectConnection } from '../../src/protocol/project-connection.js'
import { SocketIo09Peer } from '../../src/protocol/socketio09-client.js'

export interface ServerDocument {
  content: string
  version: number
  /** Lines sent exactly as given instead of encoding `content`. */
  rawLines?: string[]
}

export type Handler = (socket: FakeOverleafSocket, name: string, args: unknown[], ackId: number) => void

/**
 * A project socket that answers joinDoc and leaveDoc like Overleaf's legacy editor, sending each
 * line as the latin1 string of its UTF-8 bytes; applyOtUpdate is left to each test.
 */
export class FakeOverleafSocket extends EventEmitter {
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
      const lines =
        this.document.rawLines ??
        this.document.content.split('\n').map(line => Buffer.from(line, 'utf8').toString('latin1'))
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

  emitEvent(name: string, args: unknown[]): void {
    setImmediate(() => this.emit('message', Buffer.from(`5:::${JSON.stringify({ name, args })}`)))
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

export function createStack(document: ServerDocument, onApply: Handler) {
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

/** Applies ShareJS text components in order, refusing a delete that does not match, as ShareJS does. */
export function applyShareJs(content: string, op: Array<{ p: number; i?: string; d?: string }>): string {
  let result = content
  for (const component of op) {
    if (component.d !== undefined) {
      if (result.slice(component.p, component.p + component.d.length) !== component.d) {
        throw new Error('delete does not match the document')
      }
      result = result.slice(0, component.p) + result.slice(component.p + component.d.length)
    }
    if (component.i !== undefined) {
      result = result.slice(0, component.p) + component.i + result.slice(component.p)
    }
  }
  return result
}
