import { describe, expect, test } from 'vitest'

import { createRevision } from '../../src/core/revision.js'
import { createStack } from '../helpers/overleaf-socket.js'

describe('project socket recovery', () => {
  test('opens a fresh socket for the next call after Overleaf closes the cached one', async () => {
    const { api, cache, sockets } = createStack({ content: 'text', version: 3 }, () => undefined)

    await expect(api.readFile('project', 'main.tex')).resolves.toMatchObject({ content: 'text' })
    sockets[0]!.close()

    await expect(api.readFile('project', 'main.tex')).resolves.toMatchObject({ content: 'text' })
    expect(sockets).toHaveLength(2)
    await cache.closeAll()
  })

  test('classifies a write whose socket closed before its acknowledgement without sending it again', async () => {
    const document = { content: 'old', version: 3 }
    const { api, cache, sockets } = createStack(document, socket => {
      // Overleaf applied the update, then the socket closed before the acknowledgement arrived.
      document.content = 'new'
      document.version = 4
      setImmediate(() => socket.close())
    })
    const revision = createRevision({
      projectId: 'project',
      docId: 'doc',
      protocol: 'sharejs',
      otVersion: 3,
      content: 'old',
    })

    await expect(api.writeFile('project', 'main.tex', revision, 'new')).resolves.toMatchObject({
      recoveredAfterTimeout: true,
    })
    const applies = sockets.flatMap(socket => socket.events).filter(name => name === 'applyOtUpdate')
    expect(applies).toHaveLength(1)
    expect(sockets).toHaveLength(2)
    await cache.closeAll()
  })

  test('reports a write as not applied when the original stays live after its socket closed', async () => {
    const document = { content: 'old', version: 3 }
    const { api, cache, sockets } = createStack(document, socket => {
      setImmediate(() => socket.close())
    })
    const revision = createRevision({
      projectId: 'project',
      docId: 'doc',
      protocol: 'sharejs',
      otVersion: 3,
      content: 'old',
    })

    await expect(api.writeFile('project', 'main.tex', revision, 'new')).rejects.toMatchObject({
      details: expect.objectContaining({ outcome: 'not_applied' }),
    })
    const applies = sockets.flatMap(socket => socket.events).filter(name => name === 'applyOtUpdate')
    expect(applies).toHaveLength(1)
    await cache.closeAll()
  })
})
