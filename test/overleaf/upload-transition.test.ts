import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test, vi } from 'vitest'

import { gitBlobHash } from '../../src/core/hash.js'
import { AccessPolicy } from '../../src/core/policy.js'
import { FifoQueue } from '../../src/core/queue.js'
import { EntitiesApi } from '../../src/overleaf/entities.js'
import type { ProjectEntity } from '../../src/overleaf/tree.js'

const OLD_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1])
const OLD_HASH = gitBlobHash(OLD_PNG)

const tree: ProjectEntity[] = [
  { id: 'fig', name: 'plot.png', path: 'plot.png', type: 'file', parentFolderId: 'root', hash: OLD_HASH },
  { id: 'doc', name: 'main.tex', path: 'main.tex', type: 'doc', parentFolderId: 'root' },
]

function harness(options: { trackChangesActive?: boolean; policy?: AccessPolicy } = {}) {
  const http = {
    postJson: vi.fn(async () => ({})),
    deleteJson: vi.fn(async () => ({})),
    postForm: vi.fn(async (_path: string, form: FormData) => {
      const name = form.get('name') as string
      return { success: true, entity_id: `new-${name}`, entity_type: name.endsWith('.tex') ? 'doc' : 'file' }
    }),
    getBytes: vi.fn(async () => new Uint8Array()),
  }
  const connection = {
    queue: new FifoQueue(),
    getTree: () => tree,
    rootFolderId: 'root',
    trackChangesActive: options.trackChangesActive ?? false,
  }
  const connections = {
    withConnection: async <T>(_id: string, operation: (value: typeof connection) => Promise<T>) =>
      await operation(connection),
    invalidate: vi.fn(async () => undefined),
  }
  return { api: new EntitiesApi(http, connections, options.policy), http }
}

async function localFile(name: string, content: string | Uint8Array): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'overleaf-upload-transition-'))
  const path = join(directory, name)
  await writeFile(path, content)
  return path
}

describe('upload_file onto an existing binary', () => {
  test('overwrite: false and a stale expectedHash refuse before anything is sent', async () => {
    const { api, http } = harness()
    const png = await localFile('plot.png', new Uint8Array([9, 9]))

    await expect(api.uploadFile('p', png, '', undefined, { overwrite: false })).rejects.toMatchObject({
      code: 'CONFIRMATION_MISMATCH',
    })
    await expect(api.uploadFile('p', png, '', undefined, { expectedHash: 'f'.repeat(40) })).rejects.toMatchObject({
      code: 'REMOTE_DRIFT',
      details: { changed: 'remote' },
    })
    // An explicit refusal wins even when the hash matches.
    await expect(
      api.uploadFile('p', png, '', undefined, { overwrite: false, expectedHash: OLD_HASH })
    ).rejects.toMatchObject({ code: 'CONFIRMATION_MISMATCH' })
    expect(http.postForm).not.toHaveBeenCalled()
  })

  test('the matching hash or overwrite: true replaces it; an omitted overwrite still does, deprecated', async () => {
    const { api, http } = harness()
    const png = await localFile('plot.png', new Uint8Array([9, 9]))

    await expect(api.uploadFile('p', png, '', undefined, { expectedHash: OLD_HASH })).resolves.not.toHaveProperty('deprecations')
    await expect(api.uploadFile('p', png, '', undefined, { overwrite: true })).resolves.toMatchObject({
      replaced: true,
      writeMode: 'untracked',
    })
    const omitted = await api.uploadFile('p', png)
    expect(omitted).toMatchObject({
      replaced: true,
      deprecations: [{ parameter: 'overwrite', enforcedIn: '0.6.0', message: expect.stringContaining('CONFIRMATION_MISMATCH') }],
    })
    expect(http.postForm).toHaveBeenCalledTimes(3)
  })

  test('a new path needs no confirmation, and expectedHash for a missing entity is drift', async () => {
    const { api, http } = harness()
    const png = await localFile('fresh.png', new Uint8Array([1]))

    await expect(api.uploadFile('p', png, '', undefined, { overwrite: false })).resolves.toMatchObject({
      replaced: false,
      writeMode: 'untracked',
    })
    await expect(api.uploadFile('p', png, '', undefined, { expectedHash: OLD_HASH })).rejects.toMatchObject({
      code: 'REMOTE_DRIFT',
    })
    expect(http.postForm).toHaveBeenCalledTimes(1)
  })
})

describe('upload_file onto an existing document', () => {
  test('still replaces without uncheckedDocumentReplace, with a deprecation naming write_file', async () => {
    const { api } = harness()
    const tex = await localFile('main.tex', '\\section{New}\n')

    await expect(api.uploadFile('p', tex)).resolves.toMatchObject({
      replaced: true,
      deprecations: [{ parameter: 'uncheckedDocumentReplace', message: expect.stringContaining('write_file') }],
    })
    await expect(api.uploadFile('p', tex, '', undefined, { uncheckedDocumentReplace: true })).resolves.not.toHaveProperty(
      'deprecations'
    )
    await expect(api.uploadFile('p', tex, '', undefined, { overwrite: false })).rejects.toMatchObject({
      code: 'CONFIRMATION_MISMATCH',
    })
  })

  test('is refused before sending when the policy does not allow unchecked replacement', async () => {
    const policy = await AccessPolicy.create({ allowedEffects: ['local-read', 'overleaf-read', 'overleaf-write'] })
    const { api, http } = harness({ policy })
    const tex = await localFile('main.tex', 'x')
    const png = await localFile('new.png', new Uint8Array([1]))

    await expect(api.uploadFile('p', tex, '', undefined, { uncheckedDocumentReplace: true })).rejects.toMatchObject({
      code: 'POLICY_DENIED',
      details: { effect: 'unchecked-replace' },
    })
    expect(http.postForm).not.toHaveBeenCalled()
    await expect(api.uploadFile('p', png)).resolves.toMatchObject({ replaced: false })
  })
})

describe('upload_file writeMode', () => {
  test('reports tracked only for a document replacing a document while track changes is on', async () => {
    const tex = await localFile('main.tex', 'x')
    const fresh = await localFile('new.tex', 'x')
    const png = await localFile('plot.png', new Uint8Array([2]))

    const tracking = harness({ trackChangesActive: true }).api
    await expect(tracking.uploadFile('p', tex, '', undefined, { uncheckedDocumentReplace: true })).resolves.toMatchObject({
      writeMode: 'tracked',
      trackChangesActive: true,
    })
    // A new document is untracked content, and binaries are never tracked.
    await expect(tracking.uploadFile('p', fresh)).resolves.toMatchObject({ writeMode: 'untracked', replaced: false })
    await expect(tracking.uploadFile('p', png, '', undefined, { overwrite: true })).resolves.toMatchObject({
      writeMode: 'untracked',
    })

    const off = harness({ trackChangesActive: false }).api
    await expect(off.uploadFile('p', tex, '', undefined, { uncheckedDocumentReplace: true })).resolves.toMatchObject({
      writeMode: 'untracked',
      trackChangesActive: false,
    })
  })
})
