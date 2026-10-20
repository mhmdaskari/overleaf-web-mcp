import { EventEmitter } from 'node:events'

import { describe, expect, test, vi } from 'vitest'

import { SocketIo09Peer } from '../../src/protocol/socketio09-client.js'

class FakeWebSocket extends EventEmitter {
  readonly sent: string[] = []
  readyState = 1

  send(value: string): void {
    this.sent.push(value)
  }

  close(): void {
    this.readyState = 3
    this.emit('close')
  }
}

describe('Socket.IO peer', () => {
  test('answers heartbeats and dispatches events', () => {
    const socket = new FakeWebSocket()
    const peer = new SocketIo09Peer(socket)
    let payload: unknown
    peer.on('notice', value => {
      payload = value
    })

    socket.emit('message', Buffer.from('2::'))
    socket.emit('message', Buffer.from('5:::{"name":"notice","args":[{"ok":true}]}'))

    expect(socket.sent).toContain('2::')
    expect(payload).toEqual({ ok: true })
  })

  test('keeps the socket open for an event that carries no args', async () => {
    const socket = new FakeWebSocket()
    const peer = new SocketIo09Peer(socket)
    const pending = peer.call('joinDoc', ['DOC', {}], 1_000)
    const notice = vi.fn()
    peer.on('reconnectGracefully', notice)

    socket.emit('message', Buffer.from('5:::{"name":"reconnectGracefully"}'))
    socket.emit('message', Buffer.from('6:::1+[null,["line"],4,[],{},"sharejs-text-ot"]'))

    expect(notice).toHaveBeenCalledWith()
    expect(socket.readyState).toBe(1)
    await expect(pending).resolves.toEqual([null, ['line'], 4, [], {}, 'sharejs-text-ot'])
  })

  test('correlates acknowledgement packets to calls', async () => {
    const socket = new FakeWebSocket()
    const peer = new SocketIo09Peer(socket)
    const pending = peer.call('joinDoc', ['DOC', {}], 1_000)

    expect(socket.sent[0]).toContain('"name":"joinDoc"')
    socket.emit('message', Buffer.from('6:::1+[null,["line"],4,[],{},"sharejs-text-ot"]'))

    await expect(pending).resolves.toEqual([null, ['line'], 4, [], {}, 'sharejs-text-ot'])
  })

  test('closes on malformed protocol frames even when no error listener remains', () => {
    const socket = new FakeWebSocket()
    new SocketIo09Peer(socket)

    expect(() => socket.emit('message', Buffer.from('malformed'))).not.toThrow()
    expect(socket.readyState).toBe(3)
  })
})
