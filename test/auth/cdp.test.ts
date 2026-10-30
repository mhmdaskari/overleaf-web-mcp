import type { AddressInfo } from 'node:net'

import { WebSocketServer } from 'ws'
import { afterEach, describe, expect, test } from 'vitest'

import { CdpClient } from '../../src/auth/cdp.js'

describe('Chrome DevTools Protocol client', () => {
  const servers: WebSocketServer[] = []

  afterEach(async () => {
    await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))))
  })

  test('correlates command responses and carries a target session ID', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    servers.push(server)
    await new Promise<void>(resolve => server.once('listening', resolve))
    const port = (server.address() as AddressInfo).port
    const received = new Promise<Record<string, unknown>>(resolve => {
      server.on('connection', socket => {
        socket.on('message', data => {
          const request = JSON.parse(String(data)) as Record<string, unknown>
          resolve(request)
          socket.send(JSON.stringify({ id: request.id, result: { ok: true } }))
        })
      })
    })

    const client = await CdpClient.connect(`ws://127.0.0.1:${port}`)
    await expect(client.send<{ ok: boolean }>('Page.enable', {}, 'session-1')).resolves.toEqual({
      ok: true,
    })
    await expect(received).resolves.toMatchObject({
      method: 'Page.enable',
      sessionId: 'session-1',
    })
    client.close()
  })

  test('surfaces protocol errors without leaking requests', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    servers.push(server)
    await new Promise<void>(resolve => server.once('listening', resolve))
    const port = (server.address() as AddressInfo).port
    server.on('connection', socket => {
      socket.on('message', data => {
        const request = JSON.parse(String(data)) as { id: number }
        socket.send(JSON.stringify({ id: request.id, error: { code: -32_000, message: 'rejected' } }))
      })
    })

    const client = await CdpClient.connect(`ws://127.0.0.1:${port}`)
    await expect(client.send('Storage.getCookies')).rejects.toThrow(/rejected/u)
    client.close()
  })
})
