import { EventEmitter } from 'node:events'

import { describe, expect, test, vi } from 'vitest'

import { ProjectConnection } from '../../src/protocol/project-connection.js'

class FakePeer extends EventEmitter {
  readonly call = vi.fn()
  readonly close = vi.fn()
}

const project = {
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
  trackChangesState: { user: true },
}

describe('project connection', () => {
  test('fails at bootstrap when the server protocol version is unsupported', () => {
    expect(
      () =>
        new ProjectConnection({
          projectId: 'project',
          peer: new FakePeer(),
          join: {
            publicId: 'P.client',
            project,
            permissionsLevel: 'owner',
            protocolVersion: 3,
          },
          supportedProtocolVersions: [2],
          currentUserId: 'user',
        })
    ).toThrowError(expect.objectContaining({ code: 'PROTOCOL_UNSUPPORTED' }))
  })

  test('joins and leaves one document session and decodes ShareJS lines', async () => {
    const peer = new FakePeer()
    peer.call
      .mockResolvedValueOnce([
        null,
        [Buffer.from('café', 'utf8').toString('latin1')],
        4,
        [],
        { comments: [], changes: [] },
        'sharejs-text-ot',
      ])
      .mockResolvedValueOnce([null])
    const connection = new ProjectConnection({
      projectId: 'project',
      peer,
      join: {
        publicId: 'P.client',
        project,
        permissionsLevel: 'owner',
        protocolVersion: 2,
      },
      supportedProtocolVersions: [2],
      currentUserId: 'user',
    })

    const result = await connection.withDocument('doc', async document => document)

    expect(result).toMatchObject({
      docId: 'doc',
      protocol: 'sharejs',
      version: 4,
      content: 'café',
    })
    expect(connection.trackChangesActive).toBe(true)
    expect(peer.call).toHaveBeenNthCalledWith(
      1,
      'joinDoc',
      ['doc', { encodeRanges: true, supportsHistoryOT: true }],
      30_000
    )
    expect(peer.call).toHaveBeenNthCalledWith(2, 'leaveDoc', ['doc'], 30_000)
  })

  test('normalizes history-OT snapshots to visible content', async () => {
    const peer = new FakePeer()
    peer.call
      .mockResolvedValueOnce([
        null,
        {
          content: 'aOLDz',
          comments: [],
          trackedChanges: [
            {
              range: { pos: 1, length: 3 },
              tracking: { type: 'delete', userId: 'u', ts: 'now' },
            },
          ],
        },
        9,
        [],
        null,
        'history-ot',
      ])
      .mockResolvedValueOnce([null])
    const connection = new ProjectConnection({
      projectId: 'project',
      peer,
      join: {
        publicId: 'P.client',
        project,
        permissionsLevel: 'owner',
        protocolVersion: 2,
      },
      supportedProtocolVersions: [2],
      currentUserId: 'user',
    })

    await expect(
      connection.withDocument('doc', async document => document.content)
    ).resolves.toBe('az')
  })

  test('correlates an apply acknowledgement with the sender applied event', async () => {
    const peer = new FakePeer()
    peer.call.mockResolvedValueOnce([null])
    const connection = new ProjectConnection({
      projectId: 'project',
      peer,
      join: {
        publicId: 'P.client',
        project,
        permissionsLevel: 'owner',
        protocolVersion: 2,
      },
      supportedProtocolVersions: [2],
      currentUserId: 'user',
      callTimeoutMs: 1_000,
    })
    const pending = connection.submitUpdate('doc', {
      doc: 'doc',
      v: 4,
      op: [{ p: 0, i: 'x' }],
    })

    peer.emit('otUpdateApplied', { doc: 'doc', v: 4 })

    await expect(pending).resolves.toBeUndefined()
  })

  test('reports itself closed once its socket disconnects', () => {
    const peer = new FakePeer()
    const connection = new ProjectConnection({
      projectId: 'project',
      peer,
      join: {
        publicId: 'P.client',
        project,
        permissionsLevel: 'owner',
        protocolVersion: 2,
      },
      supportedProtocolVersions: [2],
    })

    expect(connection.closed).toBe(false)
    peer.emit('disconnect')
    expect(connection.closed).toBe(true)
  })

  test('keeps the cached project tree synchronized with collaborator events', () => {
    const peer = new FakePeer()
    const connection = new ProjectConnection({
      projectId: 'project',
      peer,
      join: {
        publicId: 'P.client',
        project,
        permissionsLevel: 'owner',
        protocolVersion: 2,
      },
      supportedProtocolVersions: [2],
    })

    peer.emit('reciveNewFolder', 'root', { _id: 'folder', name: 'chapters' })
    peer.emit('reciveNewDoc', 'folder', { _id: 'new-doc', name: 'draft.tex' })
    peer.emit('reciveEntityRename', 'new-doc', 'final.tex')
    expect(connection.getTree()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'new-doc', path: 'chapters/final.tex' }),
      ])
    )

    peer.emit('reciveEntityMove', 'new-doc', 'root')
    expect(connection.getTree()).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'new-doc', path: 'final.tex' })])
    )

    peer.emit('removeEntity', 'new-doc')
    expect(connection.getTree()).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'new-doc' })])
    )
  })
})
