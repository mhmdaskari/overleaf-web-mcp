import { describe, expect, test } from 'vitest'

import { FifoQueue } from '../../src/core/queue.js'

describe('project FIFO queue', () => {
  test('serializes operations in submission order and survives failures', async () => {
    const queue = new FifoQueue()
    const events: string[] = []

    const first = queue.run(async () => {
      events.push('first:start')
      await Promise.resolve()
      events.push('first:end')
      throw new Error('expected')
    })
    const second = queue.run(async () => {
      events.push('second:start')
      events.push('second:end')
      return 2
    })

    await expect(first).rejects.toThrow('expected')
    await expect(second).resolves.toBe(2)
    expect(events).toEqual(['first:start', 'first:end', 'second:start', 'second:end'])
  })
})
