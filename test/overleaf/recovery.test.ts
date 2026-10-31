import { describe, expect, test, vi } from 'vitest'

import { McpError } from '../../src/core/errors.js'
import {
  isUnchangedDocument,
  isUnconfirmedWriteError,
  notAppliedError,
  observeUnconfirmedWrite,
  type RecoveryState,
} from '../../src/overleaf/recovery.js'
import type { JoinedDocument } from '../../src/protocol/project-connection.js'

// Each entry is one observation: a state the classifier reports, or an Error that observe throws.
function observations(sequence: Array<RecoveryState | Error>) {
  const remaining = [...sequence]
  return vi.fn(async (): Promise<RecoveryState> => {
    const next = remaining.shift()
    if (next === undefined) throw new Error('no observation left')
    if (next instanceof Error) throw next
    return next
  })
}

const classify = (state: RecoveryState): RecoveryState => state

function document(content: string, version: number, protocol: JoinedDocument['protocol'] = 'sharejs'): JoinedDocument {
  return { docId: 'doc', protocol, version, content, ranges: null, rawSnapshot: content }
}

describe('unconfirmed write recovery', () => {
  test('resolves with the target state as soon as it is observed', async () => {
    const observe = observations(['target', 'original'])

    await expect(observeUnconfirmedWrite({ observe, classify, timeoutMs: 1_000, pollIntervalMs: 0 })).resolves.toEqual({
      state: 'target',
      observed: 'target',
    })
    expect(observe).toHaveBeenCalledOnce()
  })

  test('polls through the window while the original state is live and resolves with a late target', async () => {
    const observe = observations(['original', 'original', 'target'])

    await expect(observeUnconfirmedWrite({ observe, classify, timeoutMs: 1_000, pollIntervalMs: 0 })).resolves.toEqual({
      state: 'target',
      observed: 'target',
    })
    expect(observe).toHaveBeenCalledTimes(3)
  })

  test('resolves with the original state when it is still live at the end of the window', async () => {
    const observe = observations(['original'])

    await expect(observeUnconfirmedWrite({ observe, classify, timeoutMs: 0, pollIntervalMs: 0 })).resolves.toEqual({
      state: 'original',
      observed: 'original',
    })
    // A window of zero still observes once, and only once.
    expect(observe).toHaveBeenCalledOnce()
  })

  test('throws a conflict with an unknown outcome at the first sighting of a third state', async () => {
    const observe = observations(['original', 'other', 'target'])

    const error = await observeUnconfirmedWrite({ observe, classify, timeoutMs: 1_000, pollIntervalMs: 0 }).catch(
      (caught: unknown) => caught
    )
    expect(error).toBeInstanceOf(McpError)
    expect(error).toMatchObject({ code: 'REVISION_CONFLICT', retryable: false, details: { outcome: 'unknown' } })
    expect(observe).toHaveBeenCalledTimes(2)
  })

  test('throws OUTCOME_UNKNOWN with the last observation failure as its cause when nothing was observed', async () => {
    const lost = new Error('socket closed')
    const observe = observations([lost])

    const error = await observeUnconfirmedWrite({ observe, classify, timeoutMs: 0, pollIntervalMs: 0 }).catch(
      (caught: unknown) => caught
    )
    expect(error).toBeInstanceOf(McpError)
    expect(error).toMatchObject({ code: 'OUTCOME_UNKNOWN', retryable: false })
    expect((error as McpError).details).toBeUndefined()
    expect((error as McpError).cause).toBe(lost)
  })

  test('retries a failed observation within the window', async () => {
    const observe = observations([new Error('join failed'), 'target'])

    await expect(observeUnconfirmedWrite({ observe, classify, timeoutMs: 1_000, pollIntervalMs: 0 })).resolves.toEqual({
      state: 'target',
      observed: 'target',
    })
    expect(observe).toHaveBeenCalledTimes(2)
  })

  test('treats an original sighting followed by a failed last observation as unobserved', async () => {
    let clock = 0
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock)
    try {
      const observe = vi.fn(async (): Promise<RecoveryState> => {
        if (observe.mock.calls.length === 1) return 'original'
        // The window ends while this observation fails.
        clock = 100
        throw new Error('socket closed')
      })

      await expect(
        observeUnconfirmedWrite({ observe, classify, timeoutMs: 50, pollIntervalMs: 0 })
      ).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' })
      expect(observe).toHaveBeenCalledTimes(2)
    } finally {
      now.mockRestore()
    }
  })

  test('accepts an asynchronous classifier', async () => {
    const observe = vi.fn(async () => 'live')

    await expect(
      observeUnconfirmedWrite({
        observe,
        classify: async observed => await Promise.resolve(observed === 'live' ? 'target' : 'original'),
        timeoutMs: 0,
        pollIntervalMs: 0,
      })
    ).resolves.toEqual({ state: 'target', observed: 'live' })
  })

  test('lets a classifier error end recovery unchanged instead of counting it as a failed observation', async () => {
    const refusal = new McpError('PROTOCOL_UNSUPPORTED', 'refused')
    const observe = vi.fn(async () => 'live')

    await expect(
      observeUnconfirmedWrite({
        observe,
        classify: () => {
          throw refusal
        },
        timeoutMs: 1_000,
        pollIntervalMs: 0,
      })
    ).rejects.toBe(refusal)
    expect(observe).toHaveBeenCalledOnce()
  })

  test('ends recovery at once with an observation error the caller rethrows, and retries any other', async () => {
    const refusal = new McpError('PROTOCOL_UNSUPPORTED', 'refused')
    const rethrow = (error: unknown) => error instanceof McpError && error.code === 'PROTOCOL_UNSUPPORTED'
    const observe = observations([new Error('join failed'), refusal, 'target'])

    await expect(
      observeUnconfirmedWrite({ observe, classify, rethrow, timeoutMs: 1_000, pollIntervalMs: 0 })
    ).rejects.toBe(refusal)
    expect(observe).toHaveBeenCalledTimes(2)
  })

  test('waits the poll interval between observations', async () => {
    vi.useFakeTimers()
    try {
      const observe = observations(Array<RecoveryState>(20).fill('original'))
      // Running out of observations ends recovery, so a loop that does not wait fails instead of spinning.
      const rethrow = () => true
      const settled = observeUnconfirmedWrite({ observe, classify, rethrow, timeoutMs: 1_000, pollIntervalMs: 100 })
      settled.catch(() => undefined)

      await vi.advanceTimersByTimeAsync(0)
      expect(observe).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(99)
      expect(observe).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(1)
      expect(observe).toHaveBeenCalledTimes(2)

      await vi.advanceTimersByTimeAsync(1_000)
      await expect(settled).resolves.toEqual({ state: 'original', observed: 'original' })
      // One observation at the start, then one per interval to the end of the window.
      expect(observe).toHaveBeenCalledTimes(11)
    } finally {
      vi.useRealTimers()
    }
  })

  test('builds the third-state and unobserved errors with the caller factories', async () => {
    const other = new McpError('OUTCOME_UNKNOWN', 'changed', { details: { threadId: 'thread' } })
    const onOther = vi.fn(() => other)
    await expect(
      observeUnconfirmedWrite({
        observe: observations(['other']),
        classify,
        timeoutMs: 0,
        pollIntervalMs: 0,
        onOther,
      })
    ).rejects.toBe(other)
    expect(onOther).toHaveBeenCalledWith('other')

    const lost = new Error('socket closed')
    const unobserved = new McpError('OUTCOME_UNKNOWN', 'unobserved')
    const onUnobserved = vi.fn(() => unobserved)
    await expect(
      observeUnconfirmedWrite({
        observe: observations([lost]),
        classify,
        timeoutMs: 0,
        pollIntervalMs: 0,
        onUnobserved,
      })
    ).rejects.toBe(unobserved)
    expect(onUnobserved).toHaveBeenCalledWith(lost)
  })

  test.each<[string, unknown, string]>([
    ['a timeout', new McpError('TIMEOUT', 'ack timeout'), 'TIMEOUT'],
    ['a lost socket', new McpError('OUTCOME_UNKNOWN', 'socket closed'), 'REMOTE_ERROR'],
    ['a failed verification read', new Error('join failed'), 'REMOTE_ERROR'],
  ])('reports a write not applied after %s as %s, never retryable', (_, submitError, code) => {
    const error = notAppliedError(submitError, 'not applied', { threadId: 'thread' })

    expect(error).toMatchObject({ code, message: 'not applied', retryable: false })
    expect(error.details).toEqual({ threadId: 'thread', outcome: 'not_applied' })
    expect(Object.keys(error.details!)).toEqual(['threadId', 'outcome'])
    expect(notAppliedError(submitError, 'not applied').details).toEqual({ outcome: 'not_applied' })
  })

  test('recognizes only a timeout or a lost socket as an unconfirmed write', () => {
    expect(isUnconfirmedWriteError(new McpError('TIMEOUT', 'ack timeout'))).toBe(true)
    expect(isUnconfirmedWriteError(new McpError('OUTCOME_UNKNOWN', 'socket closed'))).toBe(true)
    expect(isUnconfirmedWriteError(new McpError('REMOTE_ERROR', 'refused'))).toBe(false)
    expect(isUnconfirmedWriteError(new Error('timeout'))).toBe(false)
    expect(isUnconfirmedWriteError(undefined)).toBe(false)
  })

  test('compares protocol, version, and content to decide that a document is unchanged', () => {
    const before = document('old', 3)

    expect(isUnchangedDocument(document('old', 3), before)).toBe(true)
    expect(isUnchangedDocument(document('old', 4), before)).toBe(false)
    expect(isUnchangedDocument(document('new', 3), before)).toBe(false)
    expect(isUnchangedDocument(document('old', 3, 'history-ot'), before)).toBe(false)
  })
})
