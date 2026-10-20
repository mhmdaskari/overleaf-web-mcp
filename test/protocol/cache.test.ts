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

  test('wakes a pending invalidate when a closed connection still in use is replaced', async () => {
    const connection = { closed: false, close: vi.fn() }
    const factory = vi.fn()
      .mockResolvedValueOnce(connection)
      .mockRejectedValue(new Error('reconnect failed'))
    const cache = new ProjectConnectionCache({ capacity: 4, idleTtlMs: 90_000, factory })

    let finishHolder!: () => void
    let held!: () => void
    const isHeld = new Promise<void>(resolve => {
      held = resolve
    })
    const holder = cache.withConnection('project', async () => {
      held()
      await new Promise<void>(resolve => {
        finishHolder = resolve
      })
    })
    await isHeld
    connection.closed = true

    let invalidated = false
    const invalidating = cache.invalidate('project').then(() => {
      invalidated = true
    })
    await expect(cache.withConnection('project', async () => undefined)).rejects.toThrow('reconnect failed')
    finishHolder()
    await holder

    await vi.waitFor(() => expect(invalidated).toBe(true), { timeout: 200 })
    await invalidating
    await cache.closeAll()
  })

  test('wakes every pending invalidate when a closed connection still in use is replaced', async () => {
    const connection = { closed: false, close: vi.fn() }
    const factory = vi.fn()
      .mockResolvedValueOnce(connection)
      .mockRejectedValue(new Error('reconnect failed'))
    const cache = new ProjectConnectionCache({ capacity: 4, idleTtlMs: 90_000, factory })

    let finishHolder!: () => void
    let held!: () => void
    const isHeld = new Promise<void>(resolve => {
      held = resolve
    })
    const holder = cache.withConnection('project', async () => {
      held()
      await new Promise<void>(resolve => {
        finishHolder = resolve
      })
    })
    await isHeld
    connection.closed = true

    const invalidated = [false, false]
    const invalidating = [0, 1].map(index =>
      cache.invalidate('project').then(() => {
        invalidated[index] = true
      })
    )
    await expect(cache.withConnection('project', async () => undefined)).rejects.toThrow('reconnect failed')
    finishHolder()
    await holder

    await vi.waitFor(() => expect(invalidated).toEqual([true, true]), { timeout: 200 })
    await Promise.all(invalidating)
    await cache.closeAll()
  })

  test('a slot freed by a release reaches a capacity waiter behind a parked invalidate', async () => {
    const factory = vi.fn(async () => ({ close: vi.fn() }))
    const cache = new ProjectConnectionCache({ capacity: 2, idleTtlMs: 90_000, factory })

    const finish: Record<string, () => void> = {}
    const holding = (projectId: string) => {
      let held!: () => void
      const isHeld = new Promise<void>(resolve => {
        held = resolve
      })
      const done = cache.withConnection(projectId, async () => {
        held()
        await new Promise<void>(resolve => {
          finish[projectId] = resolve
        })
      })
      return { isHeld, done }
    }
    const one = holding('one')
    const two = holding('two')
    await Promise.all([one.isHeld, two.isHeld])

    let invalidated = false
    const invalidating = cache.invalidate('one').then(() => {
      invalidated = true
    })
    let acquired = false
    const third = cache.withConnection('three', async () => {
      acquired = true
    })
    await new Promise(resolve => setTimeout(resolve, 10))

    finish.two!()
    await two.done
    await vi.waitFor(() => expect(acquired).toBe(true), { timeout: 200 })
    await third
    expect(invalidated).toBe(false)

    finish.one!()
    await one.done
    await invalidating
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
