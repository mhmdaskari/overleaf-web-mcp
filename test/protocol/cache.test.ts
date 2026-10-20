import { describe, expect, test, vi } from 'vitest'

import { ProjectConnectionCache } from '../../src/protocol/connection-cache.js'

describe('project connection cache', () => {
  test('evicts the least-recently-used idle connection at capacity', async () => {
    const closed: string[] = []
    const factory = vi.fn(async (projectId: string) => ({
      projectId,
      close: () => {
        closed.push(projectId)
      },
    }))
    const cache = new ProjectConnectionCache({ capacity: 2, idleTtlMs: 60_000, factory })

    await cache.withConnection('one', async () => undefined)
    await cache.withConnection('two', async () => undefined)
    await cache.withConnection('three', async () => undefined)

    expect(closed).toEqual(['one'])
    expect(factory).toHaveBeenCalledTimes(3)
    await cache.closeAll()
  })

  test('disconnects idle sockets after the configured TTL', async () => {
    vi.useFakeTimers()
    const close = vi.fn()
    const cache = new ProjectConnectionCache({
      capacity: 2,
      idleTtlMs: 90_000,
      factory: async () => ({ close }),
    })

    await cache.withConnection('project', async () => undefined)
    await vi.advanceTimersByTimeAsync(90_000)

    expect(close).toHaveBeenCalledOnce()
    vi.useRealTimers()
  })

  test('replaces a cached connection whose socket has closed', async () => {
    const connections: Array<{ closed: boolean; close: () => void }> = []
    const factory = vi.fn(async () => {
      const connection = { closed: false, close: vi.fn() }
      connections.push(connection)
      return connection
    })
    const cache = new ProjectConnectionCache({ capacity: 2, idleTtlMs: 90_000, factory })

    await cache.withConnection('project', async () => undefined)
    connections[0]!.closed = true
    const used = await cache.withConnection('project', async connection => connection)

    expect(factory).toHaveBeenCalledTimes(2)
    expect(used).toBe(connections[1])
    expect(connections[0]!.close).toHaveBeenCalledOnce()
    await cache.closeAll()
  })

  test('invalidates an idle project before timeout recovery reconnects', async () => {
    const close = vi.fn()
    const factory = vi.fn(async () => ({ close }))
    const cache = new ProjectConnectionCache({ capacity: 2, idleTtlMs: 90_000, factory })

    await cache.withConnection('project', async () => undefined)
    await cache.invalidate('project')
    await cache.withConnection('project', async () => undefined)

    expect(close).toHaveBeenCalledOnce()
    expect(factory).toHaveBeenCalledTimes(2)
    await cache.closeAll()
  })
})
