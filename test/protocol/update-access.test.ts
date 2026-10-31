import { EventEmitter } from 'node:events'

import { describe, expect, test, vi } from 'vitest'

import { McpError } from '../../src/core/errors.js'
import { ProjectConnection } from '../../src/protocol/project-connection.js'
import { assertUpdatePermitted, requiredUpdateAccess } from '../../src/protocol/update-access.js'
import { upstreamReason } from '../../src/protocol/upstream-reason.js'

// The access check before an OT update is sent, and the classification of otUpdateError.

class FakePeer extends EventEmitter {
  readonly call = vi.fn()
  readonly close = vi.fn()
}

function connect(permissionsLevel: string, peer = new FakePeer()): ProjectConnection {
  return new ProjectConnection({
    projectId: 'project',
    peer,
    join: {
      publicId: 'P.client',
      project: { _id: 'project', rootFolder: [{ _id: 'root', name: 'rootFolder' }] },
      permissionsLevel,
      protocolVersion: 2,
    },
    supportedProtocolVersions: [2],
    callTimeoutMs: 1_000,
    applyTimeoutMs: 1_000,
  })
}

const untracked = { doc: 'doc', v: 3, op: [{ p: 0, i: 'x' }] }
const tracked = { ...untracked, meta: { tc: '0123456789abcdef01' } }
const comment = { doc: 'doc', v: 3, op: [{ p: 0, c: 'x', t: 'thread' }] }
const historyComment = { doc: 'doc', v: 3, op: [{ commentId: 'thread', ranges: [{ pos: 0, length: 1 }] }] }
const historyStatus = { doc: 'doc', v: 3, op: [{ commentId: 'thread', resolved: true }] }
const historyTracked = {
  doc: 'doc',
  v: 3,
  op: [
    {
      textOperation: [
        2,
        { i: 'x', tracking: { type: 'insert', userId: 'USER', ts: 'T' } },
        { r: 3, tracking: { type: 'delete', userId: 'USER', ts: 'T' } },
        1,
      ],
    },
  ],
}

describe('the access an update needs', () => {
  test('follows the shape of the update on both protocols', () => {
    expect(requiredUpdateAccess(comment)).toBe('view')
    expect(requiredUpdateAccess(tracked)).toBe('review')
    expect(requiredUpdateAccess(untracked)).toBe('edit')
    // A reject is untracked: its `u` components carry no tracking metadata.
    expect(requiredUpdateAccess({ doc: 'doc', v: 3, op: [{ p: 0, d: 'x', u: true }] })).toBe('edit')
    expect(requiredUpdateAccess({ ...comment, op: [...comment.op, { p: 0, i: 'x' }] })).toBe('edit')

    expect(requiredUpdateAccess(historyComment)).toBe('view')
    expect(requiredUpdateAccess(historyStatus)).toBe('edit')
    expect(requiredUpdateAccess(historyTracked)).toBe('review')
    for (const component of [-1, 'x', { r: 1, tracking: { type: 'none' } }, { i: 'x' }]) {
      expect(requiredUpdateAccess({ doc: 'doc', v: 3, op: [{ textOperation: [1, component] }] })).toBe('edit')
    }
  })

  test('refuses only what the access level cannot send, naming the level and the need', () => {
    const permitted: Array<[string, Record<string, unknown>]> = [
      ['owner', untracked],
      ['readAndWrite', historyStatus],
      ['review', tracked],
      ['review', historyTracked],
      ['readOnly', comment],
      ['readOnly', historyComment],
      ['someFutureLevel', comment],
    ]
    for (const [level, update] of permitted) expect(() => assertUpdatePermitted(level, update)).not.toThrow()

    const refused: Array<[string, Record<string, unknown>, string, string]> = [
      ['review', untracked, 'review', 'edit'],
      ['review', historyStatus, 'review', 'edit'],
      ['readOnly', tracked, 'readOnly', 'review'],
      ['readOnly', historyTracked, 'readOnly', 'review'],
      ['readOnly', untracked, 'readOnly', 'edit'],
      ['someFutureLevel', tracked, 'unrecognized', 'review'],
    ]
    for (const [level, update, accessLevel, required] of refused) {
      expect(() => assertUpdatePermitted(level, update)).toThrowError(
        expect.objectContaining({ code: 'PERMISSION_DENIED', details: { accessLevel, required } })
      )
    }
  })

  test('ProjectConnection refuses before anything is sent', async () => {
    const peer = new FakePeer()
    const connection = connect('review', peer)
    await expect(connection.submitUpdate('doc', untracked)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
    const readOnly = connect('readOnly', peer)
    await expect(readOnly.submitUpdate('doc', tracked)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
    expect(peer.call).not.toHaveBeenCalled()
    expect(connection.closed).toBe(false)
  })
})

/** A peer that acknowledges the update, then emits `otUpdateError` with these arguments. */
function erroringPeer(...args: unknown[]): FakePeer {
  const peer = new FakePeer()
  peer.call.mockImplementation(async () => {
    setImmediate(() => peer.emit('otUpdateError', ...args))
    return [null]
  })
  return peer
}

describe('otUpdateError', () => {
  test("exactly 'update is too large' is UPDATE_TOO_LARGE, not applied, after one send", async () => {
    const peer = erroringPeer('update is too large', {
      project_id: 'project',
      doc_id: 'doc',
      error: 'update is too large',
    })
    const connection = connect('owner', peer)
    const error = await connection.submitUpdate('doc', untracked).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(McpError)
    expect((error as McpError).toJSON()).toMatchObject({
      code: 'UPDATE_TOO_LARGE',
      retryable: false,
      details: { outcome: 'not_applied', reason: 'update_too_large' },
    })
    expect(peer.call).toHaveBeenCalledOnce()
    // Overleaf disconnects the socket after the event, so it is not used again.
    expect(connection.closed).toBe(true)
  })

  test('anything else leaves the outcome unknown with only a known reason', async () => {
    for (const [message, reason] of [
      ['Invalid hash', 'invalid_hash'],
      ['Delete component does not match', 'delete_mismatch'],
      // Only the exact text is too-large: another case or spacing names the reason but is not proof.
      ['Update is too large', 'update_too_large'],
      [' update is too large ', 'update_too_large'],
      // Not matched by prefix: a longer text is free text.
      ['update is too large: 9000000', 'unrecognized'],
      ['Delete component does not match: secret text', 'unrecognized'],
    ]) {
      const peer = erroringPeer(message, { project_id: 'project', doc_id: 'doc', error: message, _id: 'host' })
      const connection = connect('owner', peer)
      const error = (await connection.submitUpdate('doc', untracked).catch((caught: unknown) => caught)) as McpError
      expect(error.toJSON(), message).toEqual({
        code: 'OUTCOME_UNKNOWN',
        message: 'Overleaf reported an error on the document after the OT update was sent.',
        retryable: false,
        details: { event: 'otUpdateError', reason },
      })
      expect(connection.closed).toBe(true)
    }
  })

  test("another document's error is ignored", async () => {
    const peer = new FakePeer()
    peer.call.mockImplementation(async () => {
      setImmediate(() => {
        peer.emit('otUpdateError', 'update is too large', { doc_id: 'other' })
        peer.emit('otUpdateApplied', { doc: 'doc', v: 3 })
      })
      return [null]
    })
    const connection = connect('owner', peer)
    await expect(connection.submitUpdate('doc', untracked)).resolves.toBeUndefined()
    expect(connection.closed).toBe(false)
  })
})

describe('upstream reasons', () => {
  test('fixed upstream messages map exactly, case and surrounding space aside', () => {
    expect(upstreamReason('Op too old')).toBe('op_too_old')
    expect(upstreamReason({ message: ' doc ops range is not loaded in redis ' })).toBe('ops_not_loaded')
    expect(upstreamReason(new Error('too many comments or tracked changes'))).toBe('too_many_ranges')
    expect(upstreamReason({ message: 'Something went wrong in real-time service' })).toBe('realtime_error')
    const fixed = [
      'Update takes doc over max doc size',
      'blocking doc update: doc is too large',
      'ranges are too large',
      'resulting string would be too long',
      'doc ops range is not loaded in redis',
      'too many comments or tracked changes',
      'Unrecognized op',
      'Delete ops delete different text in the same region of the document',
      'Op too old',
      'Op at future version',
      'Version missing',
      'Delete component does not match',
      'Invalid hash',
      'null bytes found in op',
      'Something went wrong in real-time service',
    ]
    const reasons = fixed.map(message => upstreamReason(message))
    expect(reasons).not.toContain('unrecognized')
    expect(new Set(reasons).size).toBe(fixed.length)
    expect(upstreamReason('document not found: 0123')).toBe('unrecognized')
    expect(upstreamReason('Op too old!')).toBe('unrecognized')
  })
})
