import WebSocket from 'ws'

import { McpError } from '../core/errors.js'

interface PendingCommand {
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
  timer: NodeJS.Timeout
}

interface CdpResponse {
  id?: number
  result?: unknown
  error?: { code?: number; message?: string }
}

/**
 * Minimal Chrome DevTools Protocol transport for the interactive login flow.
 * Numeric command IDs are correlated while unrelated browser notifications are ignored.
 */
export class CdpClient {
  readonly #socket: WebSocket
  readonly #pending = new Map<number, PendingCommand>()
  #nextId = 1
  #closed = false

  private constructor(socket: WebSocket) {
    this.#socket = socket
    socket.on('message', data => this.#handleMessage(data))
    socket.on('error', error => this.#failAll(error))
    socket.on('close', () => {
      this.#closed = true
      this.#failAll(new McpError('OUTCOME_UNKNOWN', 'Chrome login connection closed.'))
    })
  }

  get closed(): boolean {
    return this.#closed
  }

  static async connect(url: string, timeoutMs = 5_000): Promise<CdpClient> {
    const socket = new WebSocket(url)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.close()
        reject(new McpError('TIMEOUT', 'Timed out connecting to Chrome for login.'))
      }, timeoutMs)
      socket.once('open', () => {
        clearTimeout(timer)
        resolve()
      })
      socket.once('error', error => {
        clearTimeout(timer)
        reject(error)
      })
    })
    return new CdpClient(socket)
  }

  send<T>(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 5_000): Promise<T> {
    if (this.#closed || this.#socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new McpError('OUTCOME_UNKNOWN', 'Chrome login connection is closed.'))
    }
    const id = this.#nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new McpError('TIMEOUT', `Chrome command timed out: ${method}`))
      }, timeoutMs)
      this.#pending.set(id, {
        resolve: value => resolve(value as T),
        reject,
        timer,
      })
      this.#socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  }

  close(): void {
    if (!this.#closed) this.#socket.close()
  }

  #handleMessage(raw: WebSocket.RawData): void {
    let message: CdpResponse
    try {
      const payload = Buffer.isBuffer(raw)
        ? raw.toString('utf8')
        : Array.isArray(raw)
          ? Buffer.concat(raw).toString('utf8')
          : Buffer.from(new Uint8Array(raw)).toString('utf8')
      message = JSON.parse(payload) as CdpResponse
    } catch {
      return
    }
    if (message.id === undefined) return
    const pending = this.#pending.get(message.id)
    if (!pending) return
    clearTimeout(pending.timer)
    this.#pending.delete(message.id)
    if (message.error) {
      pending.reject(
        new McpError('REMOTE_ERROR', message.error.message ?? 'Chrome rejected a login command.', {
          details: { protocolCode: message.error.code },
        })
      )
    } else {
      pending.resolve(message.result ?? {})
    }
  }

  #failAll(error: unknown): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.#pending.clear()
  }
}
