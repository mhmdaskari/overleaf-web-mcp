import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test, vi } from 'vitest'

import { McpError } from '../../src/core/errors.js'
import { FifoQueue } from '../../src/core/queue.js'
import { EntitiesApi } from '../../src/overleaf/entities.js'
import type { ProjectEntity } from '../../src/overleaf/tree.js'

const tree: ProjectEntity[] = [
  {
    id: 'folder',
    name: 'chapters',
    path: 'chapters',
    type: 'folder' as const,
    parentFolderId: 'root',
  },
  {
    id: 'doc',
    name: 'old.tex',
    path: 'chapters/old.tex',
    type: 'doc' as const,
    parentFolderId: 'folder',
  },
]

function harness() {
  const http = {
    postJson: vi.fn(async () => ({ _id: 'new-doc', name: 'new.tex' })),
    deleteJson: vi.fn(async () => ({})),
    postForm: vi.fn(async (path: string, form: FormData) => {
      void path
      void form
      return { success: true, entity_id: 'upload', entity_type: 'file' }
    }),
    getBytes: vi.fn(async () => new Uint8Array([1, 2, 3])),
  }
  const connection = {
    queue: new FifoQueue(),
    getTree: () => tree,
    rootFolderId: 'root',
    trackChangesActive: false,
    rootDocId: 'doc',
    compiler: 'pdflatex',
    imageName: 'texlive-full:2024.1',
    spellCheckLanguage: 'en',
  }
  const connections = {
    withConnection: async <T>(_id: string, operation: (value: typeof connection) => Promise<T>) =>
      await operation(connection),
    invalidate: vi.fn(async () => undefined),
  }
  return { api: new EntitiesApi(http, connections), http, connections }
}

describe('entity API', () => {
  test('creates a document in its resolved parent folder', async () => {
    const { api, http, connections } = harness()

    await api.createEmptyFile('project', 'chapters/new.tex')

    expect(http.postJson).toHaveBeenCalledWith('/project/project/doc', {
      parent_folder_id: 'folder',
      name: 'new.tex',
    })
    expect(connections.invalidate).toHaveBeenCalledWith('project')
  })

  test('requires exact confirmPath before deleting', async () => {
    const { api, http } = harness()

    await expect(
      api.manageEntity('project', {
        action: 'delete',
        path: 'chapters/old.tex',
        confirmPath: 'old.tex',
      })
    ).rejects.toMatchObject({ code: 'CONFIRMATION_MISMATCH' })
    expect(http.deleteJson).not.toHaveBeenCalled()

    const result = await api.manageEntity('project', {
      action: 'delete',
      path: 'chapters/old.tex',
      confirmPath: 'chapters/old.tex',
    })
    expect(http.deleteJson).toHaveBeenCalledWith('/project/project/doc/doc')
    expect(result).toMatchObject({ trackChangesActive: false, writeMode: 'untracked' })
  })

  test('uses fileRef routes for binary files and destination folder IDs for moves', async () => {
    const { api, http } = harness()
    tree.push({
      id: 'binary',
      name: 'plot.png',
      path: 'plot.png',
      type: 'file',
      parentFolderId: 'root',
    })

    await api.manageEntity('project', {
      action: 'move',
      path: 'plot.png',
      destinationFolderPath: 'chapters',
    })

    expect(http.postJson).toHaveBeenCalledWith('/project/project/file/binary/move', {
      folder_id: 'folder',
    })
  })

  test('uploads the multipart filename field required by Overleaf', async () => {
    const { api, http } = harness()
    const directory = await mkdtemp(join(tmpdir(), 'overleaf-upload-'))
    const path = `${directory}/plot.png`
    await writeFile(path, 'png')

    await api.uploadFile('project', path)

    const form = http.postForm.mock.calls[0]?.[1]
    expect(form?.get('name')).toBe('plot.png')
    expect(form?.get('qqfile')).toBeInstanceOf(Blob)
  })

  test('reports the destination path, whether it replaced an entity, and a git blob hash', async () => {
    const { api } = harness()
    const directory = await mkdtemp(join(tmpdir(), 'overleaf-upload-'))
    // A name absent from the shared tree fixture, so this upload creates rather than replaces.
    const created = `${directory}/appendix-figure.png`
    await writeFile(created, 'hello\n')

    await expect(api.uploadFile('project', created)).resolves.toMatchObject({
      entityId: 'upload',
      entityType: 'file',
      path: 'appendix-figure.png',
      replaced: false,
      // Identical to `git hash-object`, which is what Overleaf stores.
      hash: 'ce013625030ba8dba906f756967f9e9ca394464a',
    })
  })

  test('marks an upload over an existing path as a replacement and honours destinationName', async () => {
    const { api, http } = harness()
    const directory = await mkdtemp(join(tmpdir(), 'overleaf-upload-'))
    const source = `${directory}/rewritten.tex`
    await writeFile(source, 'text')

    const result = await api.uploadFile('project', source, 'chapters', 'old.tex')

    expect(result).toMatchObject({ path: 'chapters/old.tex', replaced: true })
    expect(http.postForm.mock.calls[0]?.[1]?.get('name')).toBe('old.tex')
  })

  test('translates Overleaf upload rejections into actionable argument errors', async () => {
    const { api, http } = harness()
    http.postForm.mockRejectedValueOnce(
      new McpError('REMOTE_ERROR', 'Overleaf returned HTTP 422.', {
        details: { status: 422, path: '/upload', overleafError: 'duplicate_file_name' },
      })
    )
    const directory = await mkdtemp(join(tmpdir(), 'overleaf-upload-'))
    const source = `${directory}/plot.png`
    await writeFile(source, 'png')

    await expect(api.uploadFile('project', source)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      details: { overleafError: 'duplicate_file_name' },
    })
  })

  test('returns the root document, compiler, and image alongside the tree', async () => {
    const { api } = harness()

    await expect(api.getProjectTree('project')).resolves.toMatchObject({
      rootDocPath: 'chapters/old.tex',
      compiler: 'pdflatex',
      imageName: 'texlive-full:2024.1',
      spellCheckLanguage: 'en',
      trackChangesActive: false,
    })
    const result = await api.getProjectTree('project')
    expect(result.entities.some(entity => entity.path === 'chapters/old.tex')).toBe(true)
    expect(result.hashNote).toMatch(/git hash-object/u)
  })

  test('refuses to replace an existing local file unless overwrite is requested', async () => {
    const { api } = harness()
    const directory = await mkdtemp(join(tmpdir(), 'overleaf-download-'))
    const target = `${directory}/existing.tex`
    await writeFile(target, 'do not clobber')

    await expect(
      api.downloadFile('project', 'chapters/old.tex', target)
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(readFile(target, 'utf8')).resolves.toBe('do not clobber')

    await expect(
      api.downloadFile('project', 'chapters/old.tex', target, true)
    ).resolves.toMatchObject({ bytes: 3 })
  })

  test('with ifExists skip, leaves an existing entity untouched and sends nothing', async () => {
    const { api, http } = harness()
    const folder = await mkdtemp(join(tmpdir(), 'overleaf-upload-'))
    const local = join(folder, 'old.tex')
    await writeFile(local, 'new text')

    await expect(
      api.uploadFile('project', local, 'chapters', undefined, { ifExists: 'skip' })
    ).resolves.toEqual({ path: 'chapters/old.tex', skipped: true, entityId: 'doc', entityType: 'doc' })
    await expect(
      api.uploadFile('project', local, '', 'chapters', { ifExists: 'skip' })
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(http.postForm).not.toHaveBeenCalled()

    await api.uploadFile('project', local, 'chapters', 'fresh.tex', { ifExists: 'skip' })
    expect(http.postForm).toHaveBeenCalledTimes(1)
  })
})
