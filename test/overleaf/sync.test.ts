import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, posix } from 'node:path'

import { describe, expect, test } from 'vitest'

import { McpError } from '../../src/core/errors.js'
import { gitBlobHash } from '../../src/core/hash.js'
import { assertRevisionMatches, createRevision } from '../../src/core/revision.js'
import { normalizeLf } from '../../src/core/text.js'
import type { WriteMode } from '../../src/overleaf/documents.js'
import type { EntityAction } from '../../src/overleaf/entities.js'
import { SyncApi, type SyncDependencies } from '../../src/overleaf/sync.js'
import type { EntityType, ProjectTree } from '../../src/overleaf/tree.js'

const PROJECT = 'project'

interface FakeEntity {
  id: string
  type: EntityType
  hash?: string
  content?: string
  version?: number
}

type Content = string | Uint8Array

/**
 * An in-memory Overleaf project that behaves like the primitives a sync is composed of:
 * revision-checked document writes, in-place uploads keyed by path, and recursive deletes.
 */
class FakeProject {
  readonly entities = new Map<string, FakeEntity>()
  readonly mutations: string[] = []
  readonly writeModes: WriteMode[] = []
  #nextId = 1
  failUploads = new Set<string>()
  failFolders = new Set<string>()
  /** Uploads Overleaf acknowledges without storing anything. */
  dropUploads = new Set<string>()
  /** Uploads that time out, after landing or without landing. */
  timeoutUploads = new Map<string, 'landed' | 'lost'>()
  rateLimitUploads = new Set<string>()
  treeReads = 0
  /** Document reads, each one a join through the project's queue. */
  documentReads = 0
  failTreeReadsAfter: number | undefined
  beforeWrite: ((path: string) => void) | undefined
  afterUpload: ((path: string) => void) | undefined

  constructor(files: Record<string, Content | null> = {}) {
    for (const [path, content] of Object.entries(files)) {
      if (content === null) this.folder(path)
      else this.put(path, content)
    }
  }

  #id(): string {
    return `id${this.#nextId++}`
  }

  folder(path: string): void {
    const parent = posix.dirname(path)
    if (parent !== '.' && !this.entities.has(parent)) this.folder(parent)
    if (!this.entities.has(path)) this.entities.set(path, { id: this.#id(), type: 'folder' })
  }

  /** Text for .tex/.bib/.txt names becomes a document; anything else a binary file. */
  put(path: string, content: Content): void {
    const parent = posix.dirname(path)
    if (parent !== '.') this.folder(parent)
    const existing = this.entities.get(path)
    const id = existing?.id ?? this.#id()
    if (typeof content === 'string' && /\.(tex|bib|txt|cls|sty)$/u.test(path)) {
      this.entities.set(path, { id, type: 'doc', content: normalizeLf(content), version: (existing?.version ?? 0) + 1 })
    } else {
      const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content
      this.entities.set(path, { id, type: 'file', hash: gitBlobHash(bytes) })
    }
  }

  /** A collaborator's edit, which moves the document's version like any OT update. */
  edit(path: string, content: string): void {
    const entity = this.entities.get(path)!
    entity.content = content
    entity.version = (entity.version ?? 0) + 1
  }

  tree(): ProjectTree {
    return {
      entities: [...this.entities.entries()].map(([path, entity]) => ({
        id: entity.id,
        name: posix.basename(path),
        path,
        type: entity.type,
        parentFolderId: 'root',
        ...(entity.hash === undefined ? {} : { hash: entity.hash }),
      })),
      trackChangesActive: false,
      hashNote: '',
    }
  }

  #revision(path: string): string {
    const entity = this.entities.get(path)!
    return createRevision({
      projectId: PROJECT,
      docId: entity.id,
      protocol: 'sharejs',
      otVersion: entity.version!,
      content: entity.content!,
    })
  }

  #doc(path: string): FakeEntity {
    const entity = this.entities.get(path)
    if (entity === undefined) throw new McpError('NOT_FOUND', `Project path was not found: ${path}`)
    if (entity.type !== 'doc') throw new McpError('INVALID_ARGUMENT', `${path} is not a doc`)
    return entity
  }

  deps(options: { currentUserId?: string } = { currentUserId: 'user' }): SyncDependencies {
    return {
      getProjectTree: async () => {
        this.treeReads += 1
        if (this.failTreeReadsAfter !== undefined && this.treeReads > this.failTreeReadsAfter) {
          throw new McpError('TIMEOUT', 'Overleaf request timed out.', { retryable: true })
        }
        return this.tree()
      },
      readFile: async (_projectId, filePath) => {
        this.documentReads += 1
        const entity = this.#doc(filePath)
        return {
          content: entity.content!,
          revision: this.#revision(filePath),
          newline: 'LF',
          protocol: 'sharejs',
          trackChangesActive: false,
        }
      },
      writeFile: async (_projectId, filePath, revision, content, writeMode) => {
        this.beforeWrite?.(filePath)
        const entity = this.#doc(filePath)
        assertRevisionMatches(revision, {
          projectId: PROJECT,
          docId: entity.id,
          protocol: 'sharejs',
          otVersion: entity.version!,
          content: entity.content!,
        })
        this.mutations.push(`write ${filePath}`)
        this.writeModes.push(writeMode)
        entity.content = normalizeLf(content)
        entity.version = entity.version! + 1
        return { revision: this.#revision(filePath), protocol: 'sharejs', trackChangesActive: false, writeMode }
      },
      createFile: async (_projectId, filePath, content, writeMode) => {
        this.mutations.push(`create ${filePath}`)
        this.writeModes.push(writeMode)
        this.entities.set(filePath, { id: this.#id(), type: 'doc', content: normalizeLf(content), version: 1 })
        return { revision: this.#revision(filePath), protocol: 'sharejs', trackChangesActive: false, writeMode }
      },
      uploadFile: async (_projectId, localPath, folderPath, name, options) => {
        const path = folderPath === '' ? name : `${folderPath}/${name}`
        const existing = this.entities.get(path)
        if (options?.ifExists === 'skip' && existing !== undefined) {
          if (existing.type === 'folder') throw new McpError('INVALID_ARGUMENT', `The project holds a folder at ${path}.`)
          return { path, skipped: true as const, entityId: existing.id, entityType: existing.type }
        }
        // The checks EntitiesApi.uploadFile makes inside the upload's queue job, before sending.
        if (options?.expectedHash !== undefined && (existing?.type !== 'file' || existing.hash !== options.expectedHash)) {
          throw new McpError('REMOTE_DRIFT', `${path} no longer has expectedHash.`, { details: { changed: 'remote' } })
        }
        if (options?.overwrite === false && existing !== undefined && existing.type !== 'folder') {
          throw new McpError('CONFIRMATION_MISMATCH', `${path} already exists and overwrite is false.`)
        }
        if (this.failUploads.has(path)) throw new McpError('REMOTE_ERROR', 'Overleaf returned HTTP 500.')
        if (this.rateLimitUploads.has(path)) {
          throw new McpError('RATE_LIMITED', 'Overleaf rate-limited this request. Wait before retrying.', { retryable: true })
        }
        const timeout = this.timeoutUploads.get(path)
        if (timeout !== undefined) {
          this.mutations.push(`upload ${path}`)
          if (timeout === 'landed') {
            const bytes = await readFile(localPath)
            this.put(path, /\.(tex|bib|txt)$/u.test(path) ? new TextDecoder().decode(bytes) : bytes)
          }
          throw new McpError('TIMEOUT', 'Overleaf request timed out.', { retryable: true })
        }
        if (folderPath !== '' && this.entities.get(folderPath)?.type !== 'folder') {
          throw new McpError('INVALID_ARGUMENT', 'The destination folder no longer exists in the project tree.')
        }
        this.mutations.push(`upload ${path}`)
        if (!this.dropUploads.has(path)) {
          const bytes = await readFile(localPath)
          const text = new TextDecoder().decode(bytes)
          this.put(path, /\.(tex|bib|txt)$/u.test(path) ? text : bytes)
        }
        this.afterUpload?.(path)
        const entity = this.entities.get(path)
        const documentReplaced = existing?.type === 'doc' && options?.uncheckedDocumentReplace !== true
        return {
          ...(entity === undefined || entity.type === 'folder' ? {} : { entityId: entity.id, entityType: entity.type }),
          path,
          replaced: existing !== undefined,
          trackChangesActive: false,
          writeMode: 'untracked' as const,
          ...(documentReplaced
            ? { deprecations: [{ parameter: 'uncheckedDocumentReplace', message: 'blind', enforcedIn: '0.6.0' }] }
            : {}),
        }
      },
      manageEntity: async (_projectId, action: EntityAction) => {
        if (action.action === 'create_folder') {
          if (this.failFolders.has(action.path)) throw new McpError('PERMISSION_DENIED', 'Overleaf returned HTTP 403.')
          this.mutations.push(`create_folder ${action.path}`)
          this.folder(action.path)
          return { action: 'create_folder', created: { _id: this.entities.get(action.path)!.id } }
        }
        if (action.action === 'delete') {
          if (action.confirmPath !== action.path) throw new McpError('CONFIRMATION_MISMATCH', 'mismatch')
          const entity = this.entities.get(action.path)
          if (entity === undefined) throw new McpError('NOT_FOUND', `Project path was not found: ${action.path}`)
          this.mutations.push(`delete ${action.path}`)
          for (const key of [...this.entities.keys()]) {
            if (key === action.path || key.startsWith(`${action.path}/`)) this.entities.delete(key)
          }
          return { action: 'delete', id: entity.id }
        }
        throw new Error(`unexpected ${action.action}`)
      },
      currentUserId: options.currentUserId,
    }
  }
}

async function localFolder(files: Record<string, Content>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'overleaf-sync-'))
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), content)
  }
  return root
}

const png = (seed: number): Uint8Array => new Uint8Array([0x89, 0x50, 0x4e, 0x47, seed, 0xff])

describe('plan_sync', () => {
  test('compares binaries by hash and documents by content without changing anything', async () => {
    const project = new FakeProject({
      'main.tex': '\\section{Old}\n',
      'refs.bib': '@book{a}\n',
      'figures/same.png': png(1),
      'figures/old.png': png(2),
      'stale.tex': 'stale\n',
    })
    const root = await localFolder({
      // CRLF and a byte order mark compare equal to the LF document Overleaf holds.
      'refs.bib': '\uFEFF@book{a}\r\n',
      'main.tex': '\\section{New}\n',
      'figures/same.png': png(1),
      'figures/old.png': png(3),
      'figures/new.png': png(4),
      'main.aux': 'build output',
    })

    const plan = await new SyncApi(project.deps()).planSync(PROJECT, root)

    expect(plan.toUpload).toEqual([
      { localPath: 'figures/new.png', destinationPath: 'figures/new.png', reason: 'new' },
      {
        localPath: 'figures/old.png',
        destinationPath: 'figures/old.png',
        reason: 'changed',
        comparedBy: 'hash',
        remoteType: 'file',
      },
      {
        localPath: 'main.tex',
        destinationPath: 'main.tex',
        reason: 'changed',
        comparedBy: 'content',
        remoteType: 'doc',
      },
    ])
    expect(plan.identical).toEqual({ count: 2, paths: ['figures/same.png', 'refs.bib'] })
    expect(plan.remoteOnly).toEqual([
      { destinationPath: 'stale.tex', entityId: project.entities.get('stale.tex')!.id, type: 'doc' },
    ])
    expect(plan.ignored).toEqual({ count: 1, entries: [{ localPath: 'main.aux', matchedPattern: '*.aux' }] })
    expect(plan.conflicts).toEqual([])
    expect(plan.planToken).toEqual(expect.any(String))
    expect(project.mutations).toEqual([])
  })

  test('collapses remote-only folders to one entry but never through a protected path', async () => {
    const project = new FakeProject({
      'main.tex': 'x',
      'old/a.png': png(1),
      'old/deep/b.png': png(2),
      'build/output.log': 'log',
      'build/stale.png': png(3),
      '.latexmkrc': 'rc',
    })
    const root = await localFolder({ 'main.tex': 'x' })

    const plan = await new SyncApi(project.deps()).planSync(PROJECT, root)

    // .latexmkrc and output.log match ignore rules, so they are protected, and build/ stays.
    expect(plan.remoteOnly.map(entry => [entry.destinationPath, entry.type, entry.contains])).toEqual([
      ['build/stale.png', 'file', undefined],
      ['old', 'folder', 3],
    ])
  })

  test('scopes the comparison to destinationFolderPath and bounds identical unless verbose', async () => {
    const remote: Record<string, Content> = { 'paper.tex': 'outside the scope' }
    const local: Record<string, Content> = {}
    for (let index = 0; index < 30; index += 1) {
      remote[`figures/f${String(index).padStart(2, '0')}.png`] = png(index)
      local[`f${String(index).padStart(2, '0')}.png`] = png(index)
    }
    const project = new FakeProject(remote)
    const root = await localFolder(local)
    const api = new SyncApi(project.deps())

    const bounded = await api.planSync(PROJECT, root, { destinationFolderPath: 'figures' })
    expect(bounded.identical.count).toBe(30)
    expect(bounded.identical.paths).toHaveLength(25)
    expect(bounded.identical.paths[0]).toBe('figures/f00.png')
    expect(bounded.remoteOnly).toEqual([])

    const verbose = await api.planSync(PROJECT, root, { destinationFolderPath: 'figures/', verbose: true })
    expect(verbose.destinationFolderPath).toBe('figures')
    expect(verbose.identical.paths).toHaveLength(30)
    await expect(api.planSync(PROJECT, root, { destinationFolderPath: '.' })).resolves.toMatchObject({
      destinationFolderPath: '',
    })
  })

  test('reports conflicts that a sync cannot resolve on its own', async () => {
    const project = new FakeProject({
      'figures/x.png': png(1),
      'data': png(2),
      'notes.tex': 'text',
    })
    const root = await localFolder({
      figures: 'a file where the project has a folder',
      'data/table.csv': 'a folder where the project has a file',
      'notes.tex': new Uint8Array([0xff, 0xfe, 0x00]),
    })

    const plan = await new SyncApi(project.deps()).planSync(PROJECT, root)

    expect(plan.conflicts.map(conflict => [conflict.localPath, conflict.reason])).toEqual([
      ['data/', 'local_folder_remote_file'],
      ['figures', 'local_file_remote_folder'],
      ['notes.tex', 'not_utf8_text'],
    ])
    // Nothing inside either side of a conflict is uploaded or planned for deletion.
    expect(plan.toUpload).toEqual([])
    expect(plan.remoteOnly).toEqual([])
  })
})

describe('sync_directory', () => {
  test('does the reference cleanup in two calls and never re-uploads identical figures', async () => {
    const remote: Record<string, Content> = {
      'main.tex': 'old main\n',
      'refs.bib': 'old refs\n',
      'appendix.tex': 'old appendix\n',
      'plot.pdf': png(100),
      'stale/a.png': png(101),
      'stale/b.png': png(102),
    }
    const local: Record<string, Content> = {
      'main.tex': 'new main\n',
      'refs.bib': 'new refs\n',
      'appendix.tex': 'new appendix\n',
      'plot.pdf': png(200),
    }
    for (let index = 1; index <= 9; index += 1) {
      remote[`figures/fig${index}.png`] = png(index)
      local[`figures/fig${index}.png`] = png(index)
    }
    for (let index = 1; index <= 19; index += 1) remote[`old-${index}.png`] = png(50 + index)
    const project = new FakeProject(remote)
    const root = await localFolder(local)
    const api = new SyncApi(project.deps())

    const plan = await api.planSync(PROJECT, root)
    expect(plan.toUpload).toHaveLength(4)
    expect(plan.identical.count).toBe(9)
    expect(plan.remoteOnly).toHaveLength(20)

    const result = await api.syncDirectory(PROJECT, root, {
      mode: 'mirror',
      planToken: plan.planToken,
      confirmDeleteCount: 20,
    })

    expect(result).toMatchObject({ status: 'complete', failed: [], remaining: [], identicalCount: 9 })
    expect(project.mutations.filter(entry => entry.includes('figures/'))).toEqual([])
    expect(project.mutations.filter(entry => entry.startsWith('write '))).toEqual([
      'write appendix.tex',
      'write main.tex',
      'write refs.bib',
    ])
    expect(project.mutations.filter(entry => entry.startsWith('upload '))).toEqual(['upload plot.pdf'])
    expect(project.mutations.filter(entry => entry.startsWith('delete '))).toHaveLength(20)
    expect(project.mutations.indexOf('delete old-1.png')).toBeGreaterThan(project.mutations.indexOf('upload plot.pdf'))
    expect(project.entities.get('main.tex')?.content).toBe('new main\n')
    expect(project.entities.has('stale')).toBe(false)

    // The returned token describes the synced state, so a second pass is a verified no-op.
    const again = await api.syncDirectory(PROJECT, root, {
      mode: 'mirror',
      planToken: result.planToken,
      confirmDeleteCount: 0,
    })
    expect(again).toMatchObject({ status: 'complete', completed: [], identicalCount: 13 })
  })

  test('never deletes after a failed upload and resumes with the returned token', async () => {
    const project = new FakeProject({ 'a.png': png(1), 'stale.png': png(9) })
    const root = await localFolder({ 'a.png': png(2), 'b.png': png(3), 'c.png': png(4) })
    const api = new SyncApi(project.deps())
    const plan = await api.planSync(PROJECT, root)
    project.failUploads.add('b.png')

    const partial = await api.syncDirectory(PROJECT, root, {
      mode: 'mirror',
      planToken: plan.planToken,
      confirmDeleteCount: 1,
    })

    expect(partial.status).toBe('partial')
    expect(partial.completed.map(entry => entry.destinationPath)).toEqual(['a.png', 'c.png'])
    expect(partial.failed).toEqual([
      { destinationPath: 'b.png', action: 'upload', errorCode: 'REMOTE_ERROR', message: 'Overleaf returned HTTP 500.' },
    ])
    expect(partial.remaining).toEqual([{ destinationPath: 'stale.png', action: 'delete' }])
    expect(project.entities.has('stale.png')).toBe(true)
    expect(project.mutations.some(entry => entry.startsWith('delete'))).toBe(false)

    project.failUploads.clear()
    project.mutations.length = 0
    const resumed = await api.syncDirectory(PROJECT, root, {
      mode: 'mirror',
      planToken: partial.planToken,
      confirmDeleteCount: 1,
    })

    expect(resumed.status).toBe('complete')
    // Only what was left is done; the completed uploads are not repeated.
    expect(project.mutations).toEqual(['upload b.png', 'delete stale.png'])
  })

  test('stops at the first failure with stopOnError and lists the rest as remaining', async () => {
    const project = new FakeProject({})
    const root = await localFolder({ 'a.png': png(1), 'b.png': png(2), 'c.png': png(3) })
    project.failUploads.add('a.png')

    const result = await new SyncApi(project.deps()).syncDirectory(PROJECT, root, {
      mode: 'additive',
      unplanned: true,
      stopOnError: true,
    })

    expect(result.failed.map(entry => entry.destinationPath)).toEqual(['a.png'])
    expect(result.remaining).toEqual([
      { destinationPath: 'b.png', action: 'upload' },
      { destinationPath: 'c.png', action: 'upload' },
    ])
    expect(project.mutations).toEqual([])
  })

  test('refuses with REMOTE_DRIFT, changing nothing, when the project or the folder changed since the plan', async () => {
    const project = new FakeProject({ 'main.tex': 'shared\n', 'fig.png': png(1) })
    const root = await localFolder({ 'main.tex': 'mine\n', 'fig.png': png(2) })
    const api = new SyncApi(project.deps())

    const plan = await api.planSync(PROJECT, root)
    project.edit('main.tex', 'a collaborator typed this\n')
    await expect(
      api.syncDirectory(PROJECT, root, { mode: 'additive', planToken: plan.planToken })
    ).rejects.toMatchObject({ code: 'REMOTE_DRIFT', details: { changed: 'remote' } })
    expect(project.mutations).toEqual([])
    expect(project.entities.get('main.tex')?.content).toBe('a collaborator typed this\n')

    const fresh = await api.planSync(PROJECT, root)
    await writeFile(join(root, 'extra.png'), png(7))
    await expect(
      api.syncDirectory(PROJECT, root, { mode: 'additive', planToken: fresh.planToken })
    ).rejects.toMatchObject({ code: 'REMOTE_DRIFT', details: { changed: 'local' } })
    expect(project.mutations).toEqual([])
  })

  test('fails one document with REVISION_CONFLICT when a collaborator edits it mid-sync', async () => {
    const project = new FakeProject({ 'a.tex': 'a\n', 'b.tex': 'b\n', 'stale.png': png(1) })
    const root = await localFolder({ 'a.tex': 'mine a\n', 'b.tex': 'mine b\n' })
    const plan = await new SyncApi(project.deps()).planSync(PROJECT, root)
    project.beforeWrite = path => {
      if (path === 'a.tex') project.edit('a.tex', 'theirs\n')
      project.beforeWrite = undefined
    }

    const result = await new SyncApi(project.deps()).syncDirectory(PROJECT, root, {
      mode: 'mirror',
      planToken: plan.planToken,
      confirmDeleteCount: 1,
    })

    expect(result.failed).toEqual([
      expect.objectContaining({ destinationPath: 'a.tex', action: 'write', errorCode: 'REVISION_CONFLICT' }),
    ])
    expect(project.entities.get('a.tex')?.content).toBe('theirs\n')
    expect(project.entities.get('b.tex')?.content).toBe('mine b\n')
    expect(result.remaining).toEqual([{ destinationPath: 'stale.png', action: 'delete' }])

    // The token keeps the planned state of the conflicted document, so resuming stops for review.
    await expect(
      new SyncApi(project.deps()).syncDirectory(PROJECT, root, {
        mode: 'mirror',
        planToken: result.planToken,
        confirmDeleteCount: 1,
      })
    ).rejects.toMatchObject({ code: 'REMOTE_DRIFT' })
  })

  test('requires the exact remote-only count in mirror mode and checks it before any change', async () => {
    const project = new FakeProject({ 'stale.png': png(1), 'old/a.png': png(2), 'old/b.png': png(3) })
    const root = await localFolder({ 'new.png': png(4) })
    const api = new SyncApi(project.deps())
    const { planToken } = await api.planSync(PROJECT, root)

    await expect(api.syncDirectory(PROJECT, root, { mode: 'mirror', planToken })).rejects.toMatchObject({
      code: 'CONFIRMATION_MISMATCH',
    })
    // The folder counts once, not three times.
    await expect(
      api.syncDirectory(PROJECT, root, { mode: 'mirror', planToken, confirmDeleteCount: 3 })
    ).rejects.toMatchObject({ code: 'CONFIRMATION_MISMATCH' })
    expect(project.mutations).toEqual([])

    const result = await api.syncDirectory(PROJECT, root, { mode: 'mirror', planToken, confirmDeleteCount: 2 })
    expect(result.status).toBe('complete')
    expect([...project.entities.keys()]).toEqual(['new.png'])
  })

  test('additive mode never deletes and leaves remote-only entries out of remaining', async () => {
    const project = new FakeProject({ 'keep.png': png(1) })
    const root = await localFolder({ 'new.png': png(2) })

    const result = await new SyncApi(project.deps()).syncDirectory(PROJECT, root, { mode: 'additive', unplanned: true })

    expect(result).toMatchObject({ status: 'complete', remaining: [] })
    expect(project.entities.has('keep.png')).toBe(true)
  })

  test('creates each missing folder once and never retries one that failed', async () => {
    const project = new FakeProject({})
    const root = await localFolder({
      'figures/a.png': png(1),
      'figures/b.png': png(2),
      'locked/c.png': png(3),
      'locked/d.png': png(4),
    })
    project.failFolders.add('locked')

    const result = await new SyncApi(project.deps()).syncDirectory(PROJECT, root, { mode: 'additive', unplanned: true })

    expect(project.mutations).toEqual(['create_folder figures', 'upload figures/a.png', 'upload figures/b.png'])
    expect(result.completed[0]).toEqual({
      destinationPath: 'figures',
      action: 'create_folder',
      entityId: project.entities.get('figures')!.id,
    })
    expect(result.failed.map(entry => [entry.destinationPath, entry.action, entry.errorCode])).toEqual([
      ['locked', 'create_folder', 'PERMISSION_DENIED'],
      ['locked/c.png', 'upload', 'PERMISSION_DENIED'],
      ['locked/d.png', 'upload', 'PERMISSION_DENIED'],
    ])
  })

  test('syncs into a destination folder, creating it when the project has none', async () => {
    const project = new FakeProject({ 'main.tex': 'root document' })
    const root = await localFolder({ 'a.png': png(1) })
    const api = new SyncApi(project.deps())
    const plan = await api.planSync(PROJECT, root, { destinationFolderPath: 'assets/figures' })

    const result = await api.syncDirectory(PROJECT, root, {
      mode: 'mirror',
      destinationFolderPath: 'assets/figures',
      planToken: plan.planToken,
      confirmDeleteCount: 0,
    })

    expect(project.mutations).toEqual([
      'create_folder assets',
      'create_folder assets/figures',
      'upload assets/figures/a.png',
    ])
    expect(result.status).toBe('complete')
    expect(project.entities.has('main.tex')).toBe(true)
  })

  test('records text as tracked changes in tracked mode and uploads binaries as usual', async () => {
    const project = new FakeProject({ 'main.tex': 'old\n' })
    const root = await localFolder({ 'main.tex': 'new\n', 'intro.tex': 'intro\n', 'empty.tex': '', 'fig.png': png(1) })
    const api = new SyncApi(project.deps())

    await api.syncDirectory(PROJECT, root, { mode: 'additive', unplanned: true, writeMode: 'tracked' })

    expect(project.mutations).toEqual(['create empty.tex', 'upload fig.png', 'create intro.tex', 'write main.tex'])
    // An empty file has nothing to track; every write with content is tracked.
    expect(project.writeModes).toEqual(['untracked', 'tracked', 'tracked'])

    await expect(
      new SyncApi(project.deps({})).syncDirectory(PROJECT, root, { mode: 'additive', unplanned: true, writeMode: 'tracked' })
    ).rejects.toMatchObject({ code: 'PROTOCOL_UNSUPPORTED' })
  })

  test('reports conflicts as failures and therefore deletes nothing', async () => {
    const project = new FakeProject({ figures: png(1), 'stale.png': png(2) })
    const root = await localFolder({ 'figures/a.png': png(3), 'ok.png': png(4) })

    const api = new SyncApi(project.deps())
    const plan = await api.planSync(PROJECT, root)
    const result = await api.syncDirectory(PROJECT, root, {
      mode: 'mirror',
      planToken: plan.planToken,
      confirmDeleteCount: 1,
    })

    expect(result.failed).toEqual([
      expect.objectContaining({ destinationPath: 'figures', errorCode: 'INVALID_ARGUMENT' }),
    ])
    expect(result.completed.map(entry => entry.destinationPath)).toEqual(['ok.png'])
    expect(result.remaining).toEqual([{ destinationPath: 'stale.png', action: 'delete' }])
    expect(project.entities.has('stale.png')).toBe(true)
  })

  test('treats an upload the tree does not show as failed, and withholds deletes', async () => {
    const project = new FakeProject({ 'stale.png': png(1) })
    const root = await localFolder({ 'ghost.png': png(2) })
    project.dropUploads.add('ghost.png')

    const api = new SyncApi(project.deps())
    const plan = await api.planSync(PROJECT, root)
    const result = await api.syncDirectory(PROJECT, root, {
      mode: 'mirror',
      planToken: plan.planToken,
      confirmDeleteCount: 1,
    })

    expect(result.completed).toEqual([])
    expect(result.failed).toEqual([
      expect.objectContaining({ destinationPath: 'ghost.png', action: 'upload', errorCode: 'REMOTE_ERROR' }),
    ])
    expect(project.entities.has('stale.png')).toBe(true)
  })

  test('leaves a folder in place when its contents changed after the plan', async () => {
    const project = new FakeProject({ 'old/a.png': png(1) })
    const root = await localFolder({ 'new.png': png(2) })
    // A collaborator drops a file into the folder while the sync is uploading.
    project.afterUpload = () => project.put('old/theirs.png', png(3))

    const api = new SyncApi(project.deps())
    const plan = await api.planSync(PROJECT, root)
    const result = await api.syncDirectory(PROJECT, root, {
      mode: 'mirror',
      planToken: plan.planToken,
      confirmDeleteCount: 1,
    })

    expect(result.failed).toEqual([
      expect.objectContaining({ destinationPath: 'old', action: 'delete', errorCode: 'REMOTE_DRIFT' }),
    ])
    expect(project.entities.has('old/theirs.png')).toBe(true)
  })

  test('stops a resumed sync when a collaborator changed something the partial run left alone', async () => {
    const project = new FakeProject({ 'untouched.tex': 'same\n' })
    const root = await localFolder({ 'untouched.tex': 'same\n', 'a.png': png(1), 'b.png': png(2) })
    const api = new SyncApi(project.deps())
    project.failUploads.add('b.png')

    const partial = await api.syncDirectory(PROJECT, root, { mode: 'additive', unplanned: true })
    expect(partial.status).toBe('partial')
    project.edit('untouched.tex', 'edited during the pause\n')
    project.failUploads.clear()

    await expect(
      api.syncDirectory(PROJECT, root, { mode: 'additive', planToken: partial.planToken })
    ).rejects.toMatchObject({ code: 'REMOTE_DRIFT', details: { changed: 'remote' } })
  })

  test('refuses a token issued for other arguments or another project', async () => {
    const project = new FakeProject({})
    const root = await localFolder({ 'a.png': png(1) })
    const api = new SyncApi(project.deps())
    const plan = await api.planSync(PROJECT, root)

    await expect(
      api.syncDirectory(PROJECT, root, { mode: 'additive', planToken: plan.planToken, ignore: ['*.png'] })
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(
      api.syncDirectory('other', root, { mode: 'additive', planToken: plan.planToken })
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(
      api.syncDirectory(PROJECT, root, { mode: 'additive', planToken: 'not-a-token' })
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(project.mutations).toEqual([])
  })

  test('reports progress that only ever increases across reading and applying', async () => {
    const project = new FakeProject({ 'a.tex': 'a\n', 'b.tex': 'b\n' })
    const root = await localFolder({ 'a.tex': 'new a\n', 'b.tex': 'new b\n', 'c.png': png(1) })
    const updates: Array<[number, number]> = []

    await new SyncApi(project.deps()).syncDirectory(PROJECT, root, {
      mode: 'additive',
      unplanned: true,
      onProgress: async (progress, total) => {
        updates.push([progress, total])
      },
    })

    expect(updates).toEqual([
      [1, 2],
      [2, 2],
      [3, 5],
      [4, 5],
      [5, 5],
    ])
  })

  test('does not follow a symbolic link out of the folder', async () => {
    const project = new FakeProject({})
    const outside = await localFolder({ 'secret.png': png(1) })
    const root = await localFolder({ 'a.png': png(2) })
    await symlink(join(outside, 'secret.png'), join(root, 'link.png'))

    await expect(
      new SyncApi(project.deps()).syncDirectory(PROJECT, root, { mode: 'additive', unplanned: true })
    ).rejects.toMatchObject({ code: 'PATH_OUTSIDE_ROOT' })
    expect(project.mutations).toEqual([])
    await rm(outside, { recursive: true })
  })
})

describe('sync_directory without a plan (deprecated, refused from 0.6.0)', () => {
  test('still runs tokenless, reporting planned: false and a deprecation; unplanned says it is on purpose', async () => {
    const project = new FakeProject({})
    const root = await localFolder({ 'a.png': png(1) })
    const api = new SyncApi(project.deps())

    const tokenless = await api.syncDirectory(PROJECT, root, { mode: 'additive' })
    expect(tokenless).toMatchObject({
      status: 'complete',
      planned: false,
      deprecations: [{ parameter: 'planToken', enforcedIn: '0.6.0', message: expect.stringContaining('unplanned') }],
    })

    const unplanned = await api.syncDirectory(PROJECT, root, { mode: 'additive', unplanned: true })
    expect(unplanned.planned).toBe(false)
    expect(unplanned).not.toHaveProperty('deprecations')

    const plan = await api.planSync(PROJECT, root)
    const planned = await api.syncDirectory(PROJECT, root, { mode: 'additive', planToken: plan.planToken })
    expect(planned.planned).toBe(true)
    expect(planned).not.toHaveProperty('deprecations')
  })

  test('refuses unplanned with a planToken or in mirror mode before reading anything', async () => {
    const project = new FakeProject({ 'a.tex': 'a\n' })
    const root = await localFolder({ 'a.tex': 'b\n' })
    const api = new SyncApi(project.deps())
    const { planToken } = await api.planSync(PROJECT, root)
    project.treeReads = 0
    project.documentReads = 0

    await expect(api.syncDirectory(PROJECT, root, { mode: 'additive', unplanned: true, planToken })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    })
    await expect(
      api.syncDirectory(PROJECT, root, { mode: 'mirror', unplanned: true, confirmDeleteCount: 0 })
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(project.treeReads).toBe(0)
    expect(project.documentReads).toBe(0)
    expect(project.mutations).toEqual([])
  })

  test('refuses an upload whose path changed after the plan, per file, and then deletes nothing', async () => {
    const project = new FakeProject({ 'b.png': png(1), 'stale.png': png(2) })
    const root = await localFolder({ 'a.png': png(3), 'b.png': png(4), 'c.png': png(5) })
    const api = new SyncApi(project.deps())
    const plan = await api.planSync(PROJECT, root)
    // After the first upload, a collaborator replaces b.png and adds c.png.
    project.afterUpload = () => {
      project.afterUpload = undefined
      project.put('b.png', png(9))
      project.put('c.png', png(8))
    }

    const result = await api.syncDirectory(PROJECT, root, {
      mode: 'mirror',
      planToken: plan.planToken,
      confirmDeleteCount: 1,
    })

    expect(result.completed.map(entry => entry.destinationPath)).toEqual(['a.png'])
    expect(result.failed.map(entry => [entry.destinationPath, entry.errorCode])).toEqual([
      ['b.png', 'REMOTE_DRIFT'],
      ['c.png', 'REMOTE_DRIFT'],
    ])
    expect(result.remaining).toEqual([{ destinationPath: 'stale.png', action: 'delete' }])
    expect(project.mutations).toEqual(['upload a.png'])
    expect(project.entities.get('b.png')?.hash).toBe(gitBlobHash(png(9)))
  })
})

describe('batch_upload during the transition', () => {
  test('an explicit onConflict replaces binaries silently and reports documents replaced without opting in', async () => {
    const project = new FakeProject({ 'main.tex': 'old\n', 'fig.png': png(1) })
    const root = await localFolder({ 'main.tex': 'new\n', 'fig.png': png(2) })
    const files = [
      { localPath: join(root, 'fig.png'), destinationPath: 'fig.png' },
      { localPath: join(root, 'main.tex'), destinationPath: 'main.tex' },
    ]
    const api = new SyncApi(project.deps())

    const binaryOnly = await api.batchUpload(PROJECT, files.slice(0, 1), { onConflict: 'overwrite' })
    expect(binaryOnly).not.toHaveProperty('deprecations')

    const withDocument = await api.batchUpload(PROJECT, files, { onConflict: 'overwrite' })
    expect(withDocument.deprecations?.map(entry => entry.parameter)).toEqual(['uncheckedDocumentReplace'])

    const optedIn = await api.batchUpload(PROJECT, files, { onConflict: 'overwrite', uncheckedDocumentReplace: true })
    expect(optedIn).not.toHaveProperty('deprecations')

    const defaulted = await api.batchUpload(PROJECT, files)
    expect(defaulted.deprecations?.map(entry => entry.parameter)).toEqual(['onConflict', 'uncheckedDocumentReplace'])
    expect(defaulted.status).toBe('complete')
  })
})

describe('delete_entities', () => {
  test('deletes every listed path once the count is confirmed', async () => {
    const project = new FakeProject({ 'a.png': png(1), 'old/b.png': png(2), 'keep.tex': 'k' })
    const api = new SyncApi(project.deps())

    await expect(api.deleteEntities(PROJECT, ['a.png', 'old'], 1)).rejects.toMatchObject({
      code: 'CONFIRMATION_MISMATCH',
    })
    expect(project.mutations).toEqual([])

    const result = await api.deleteEntities(PROJECT, ['a.png', 'old/'], 2)
    expect(result).toEqual({
      status: 'complete',
      completed: [
        { path: 'a.png', type: 'file', entityId: 'id1' },
        { path: 'old', type: 'folder', entityId: 'id2' },
      ],
      failed: [],
      remaining: [],
    })
    expect([...project.entities.keys()]).toEqual(['keep.tex'])
  })

  test('refuses duplicates, nested paths, and missing paths before deleting anything', async () => {
    const project = new FakeProject({ 'a.png': png(1), 'old/b.png': png(2) })
    const api = new SyncApi(project.deps())

    await expect(api.deleteEntities(PROJECT, ['a.png', 'a.png'], 2)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    })
    await expect(api.deleteEntities(PROJECT, ['old', 'old/b.png'], 2)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    })
    await expect(api.deleteEntities(PROJECT, ['a.png', 'missing.png'], 2)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    await expect(api.deleteEntities(PROJECT, ['/'], 1)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(api.deleteEntities(PROJECT, ['../outside'], 1)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    })
    expect(project.mutations).toEqual([])
  })

  test('continues past a failed delete unless stopOnError is set', async () => {
    const project = new FakeProject({ 'a.png': png(1), 'b.png': png(2), 'c.png': png(3) })
    const base = project.deps()
    const api = new SyncApi({
      ...base,
      manageEntity: async (projectId, action) => {
        if (action.path === 'a.png') throw new McpError('PERMISSION_DENIED', 'Overleaf returned HTTP 403.')
        return await base.manageEntity(projectId, action)
      },
    })

    const stopped = await api.deleteEntities(PROJECT, ['a.png', 'b.png', 'c.png'], 3, { stopOnError: true })
    expect(stopped).toMatchObject({
      status: 'partial',
      failed: [{ path: 'a.png', errorCode: 'PERMISSION_DENIED' }],
      remaining: [{ path: 'b.png' }, { path: 'c.png' }],
    })

    const continued = await api.deleteEntities(PROJECT, ['a.png', 'b.png', 'c.png'], 3)
    expect(continued.completed.map(entry => entry.path)).toEqual(['b.png', 'c.png'])
    expect(continued.failed.map(entry => entry.path)).toEqual(['a.png'])
  })
})

describe('batch_upload', () => {
  test('uploads to explicit paths, creating missing folders parents first, and confirms each in the tree', async () => {
    const project = new FakeProject({ 'main.tex': 'x', 'figures/old.png': png(1) })
    const root = await localFolder({ 'a.png': png(2), 'b.png': png(3), 'c.png': png(4) })
    const oldId = project.entities.get('figures/old.png')!.id

    const result = await new SyncApi(project.deps()).batchUpload(PROJECT, [
      { localPath: join(root, 'a.png'), destinationPath: 'figures/old.png' },
      { localPath: join(root, 'b.png'), destinationPath: 'figures/deep/er/b.png' },
      { localPath: join(root, 'c.png'), destinationPath: 'c.png' },
    ])

    expect(project.mutations).toEqual([
      'upload figures/old.png',
      'create_folder figures/deep',
      'create_folder figures/deep/er',
      'upload figures/deep/er/b.png',
      'upload c.png',
    ])
    expect(result).toEqual({
      status: 'complete',
      onConflict: 'overwrite',
      completed: [
        { destinationPath: 'figures/old.png', action: 'upload', entityId: oldId, entityType: 'file', replaced: true },
        { destinationPath: 'figures/deep', action: 'create_folder', entityId: expect.any(String) },
        { destinationPath: 'figures/deep/er', action: 'create_folder', entityId: expect.any(String) },
        { destinationPath: 'figures/deep/er/b.png', action: 'upload', entityId: expect.any(String), entityType: 'file', replaced: false },
        { destinationPath: 'c.png', action: 'upload', entityId: expect.any(String), entityType: 'file', replaced: false },
      ],
      skipped: [],
      failed: [],
      remaining: [],
      verified: true,
      // The replacement relied on onConflict's default, which 0.6.0 removes.
      deprecations: [{ parameter: 'onConflict', message: expect.stringContaining('0.6.0'), enforcedIn: '0.6.0' }],
    })
    expect(project.entities.get('figures/old.png')).toMatchObject({ id: oldId, hash: gitBlobHash(png(2)) })
  })

  test('skip leaves every existing path untouched and sends nothing for it', async () => {
    const project = new FakeProject({ 'main.tex': 'old\n', 'fig.png': png(1) })
    const root = await localFolder({ 'main.tex': 'new\n', 'fig.png': png(2), 'new.png': png(3) })

    const result = await new SyncApi(project.deps()).batchUpload(
      PROJECT,
      [
        { localPath: join(root, 'main.tex'), destinationPath: 'main.tex' },
        { localPath: join(root, 'fig.png'), destinationPath: 'fig.png' },
        { localPath: join(root, 'new.png'), destinationPath: 'new.png' },
      ],
      { onConflict: 'skip' }
    )

    expect(project.mutations).toEqual(['upload new.png'])
    expect(result.status).toBe('complete')
    expect(result.skipped).toEqual([
      { destinationPath: 'main.tex', localPath: join(root, 'main.tex'), entityType: 'doc' },
      { destinationPath: 'fig.png', localPath: join(root, 'fig.png'), entityType: 'file' },
    ])
    expect(result.completed.map(entry => entry.destinationPath)).toEqual(['new.png'])
    expect(project.entities.get('main.tex')!.content).toBe('old\n')
  })

  test('skip re-checks inside the upload, so a path that appeared after the tree read is not replaced', async () => {
    const project = new FakeProject({ 'main.tex': 'x' })
    const root = await localFolder({ 'a.png': png(1), 'b.png': png(2) })
    project.afterUpload = path => {
      if (path === 'a.png') project.put('b.png', png(9))
    }

    const result = await new SyncApi(project.deps()).batchUpload(
      PROJECT,
      [
        { localPath: join(root, 'a.png'), destinationPath: 'a.png' },
        { localPath: join(root, 'b.png'), destinationPath: 'b.png' },
      ],
      { onConflict: 'skip' }
    )

    expect(project.mutations).toEqual(['upload a.png'])
    expect(result.skipped).toEqual([{ destinationPath: 'b.png', localPath: join(root, 'b.png'), entityType: 'file' }])
    expect(project.entities.get('b.png')!.hash).toBe(gitBlobHash(png(9)))
  })

  test('checks every path before anything is sent', async () => {
    const project = new FakeProject({ 'main.tex': 'x' })
    const root = await localFolder({ 'a.png': png(1) })
    const file = join(root, 'a.png')
    const api = new SyncApi(project.deps())
    const cases: Array<[Array<{ localPath: string; destinationPath: string }>, string]> = [
      [[{ localPath: file, destinationPath: 'x.png' }, { localPath: file, destinationPath: './x.png' }], 'INVALID_ARGUMENT'],
      [[{ localPath: file, destinationPath: 'figs' }, { localPath: file, destinationPath: 'figs/x.png' }], 'INVALID_ARGUMENT'],
      [[{ localPath: file, destinationPath: 'figs/' }], 'INVALID_ARGUMENT'],
      [[{ localPath: file, destinationPath: '.' }], 'INVALID_ARGUMENT'],
      [[{ localPath: file, destinationPath: '../x.png' }], 'INVALID_ARGUMENT'],
      [[{ localPath: file, destinationPath: 'figs/.' }], 'INVALID_ARGUMENT'],
      [[{ localPath: file, destinationPath: 'x/a.png/..' }], 'INVALID_ARGUMENT'],
      [[{ localPath: file, destinationPath: 'a.png' }, { localPath: join(root, 'missing.png'), destinationPath: 'b.png' }], 'NOT_FOUND'],
      [[{ localPath: root, destinationPath: 'a.png' }], 'INVALID_ARGUMENT'],
      [[], 'INVALID_ARGUMENT'],
    ]
    for (const [files, code] of cases) {
      await expect(api.batchUpload(PROJECT, files)).rejects.toMatchObject({ code })
    }
    expect(project.mutations).toEqual([])
    expect(project.treeReads).toBe(0)
  })

  test('fails a file whose path is taken by a folder or sits under a file, and continues with the rest', async () => {
    const project = new FakeProject({ 'main.tex': 'x', 'figures': null })
    const root = await localFolder({ 'a.png': png(1), 'b.png': png(2), 'c.png': png(3) })

    const result = await new SyncApi(project.deps()).batchUpload(PROJECT, [
      { localPath: join(root, 'a.png'), destinationPath: 'figures' },
      { localPath: join(root, 'b.png'), destinationPath: 'main.tex/b.png' },
      { localPath: join(root, 'c.png'), destinationPath: 'c.png' },
    ])

    expect(project.mutations).toEqual(['upload c.png'])
    expect(result.status).toBe('partial')
    expect(result.failed).toEqual([
      { destinationPath: 'figures', action: 'upload', errorCode: 'INVALID_ARGUMENT', message: expect.stringContaining('folder') },
      { destinationPath: 'main.tex/b.png', action: 'upload', errorCode: 'INVALID_ARGUMENT', message: expect.stringContaining('main.tex') },
    ])
    expect(result.completed.map(entry => entry.destinationPath)).toEqual(['c.png'])
  })

  test('continues past a failed upload, or stops with stopOnError and lists the rest as remaining', async () => {
    const files = async () => {
      const root = await localFolder({ 'a.png': png(1), 'b.png': png(2), 'c.png': png(3) })
      return ['a.png', 'b.png', 'c.png'].map(name => ({ localPath: join(root, name), destinationPath: name }))
    }

    const continuing = new FakeProject({ 'main.tex': 'x' })
    continuing.failUploads.add('b.png')
    const continued = await new SyncApi(continuing.deps()).batchUpload(PROJECT, await files())
    expect(continued.status).toBe('partial')
    expect(continued.completed.map(entry => entry.destinationPath)).toEqual(['a.png', 'c.png'])
    expect(continued.failed).toEqual([
      { destinationPath: 'b.png', action: 'upload', errorCode: 'REMOTE_ERROR', message: 'Overleaf returned HTTP 500.' },
    ])
    expect(continued.remaining).toEqual([])

    const stopping = new FakeProject({ 'main.tex': 'x' })
    stopping.failUploads.add('b.png')
    const stopped = await new SyncApi(stopping.deps()).batchUpload(PROJECT, await files(), { stopOnError: true })
    expect(stopping.mutations).toEqual(['upload a.png'])
    expect(stopped.remaining).toEqual([{ destinationPath: 'c.png', action: 'upload' }])
  })

  test('stops sending at RATE_LIMITED even without stopOnError, since every further upload would be refused', async () => {
    const project = new FakeProject({ 'main.tex': 'x' })
    project.rateLimitUploads.add('b.png')
    const root = await localFolder({ 'a.png': png(1), 'b.png': png(2), 'c.png': png(3) })

    const result = await new SyncApi(project.deps()).batchUpload(
      PROJECT,
      ['a.png', 'b.png', 'c.png'].map(name => ({ localPath: join(root, name), destinationPath: name }))
    )

    expect(project.mutations).toEqual(['upload a.png'])
    expect(result.failed.map(entry => [entry.destinationPath, entry.errorCode])).toEqual([['b.png', 'RATE_LIMITED']])
    expect(result.remaining).toEqual([{ destinationPath: 'c.png', action: 'upload' }])
  })

  test('stops at a RATE_LIMITED folder creation too, sending nothing more', async () => {
    const project = new FakeProject({ 'main.tex': 'x' })
    const deps = project.deps()
    let folderCalls = 0
    const api = new SyncApi({
      ...deps,
      manageEntity: async (projectId, action) => {
        if (action.action !== 'create_folder') return await deps.manageEntity(projectId, action)
        folderCalls += 1
        throw new McpError('RATE_LIMITED', 'Overleaf rate-limited this request. Wait before retrying.', { retryable: true })
      },
    })
    const root = await localFolder({ 'a.png': png(1), 'b.png': png(2), 'c.png': png(3) })

    const result = await api.batchUpload(PROJECT, [
      { localPath: join(root, 'a.png'), destinationPath: 'one/a.png' },
      { localPath: join(root, 'b.png'), destinationPath: 'two/b.png' },
      { localPath: join(root, 'c.png'), destinationPath: 'c.png' },
    ])

    expect(folderCalls).toBe(1)
    expect(project.mutations).toEqual([])
    expect(result.failed.map(entry => [entry.destinationPath, entry.errorCode])).toEqual([['one', 'RATE_LIMITED']])
    expect(result.remaining.map(entry => entry.destinationPath)).toEqual(['one/a.png', 'two/b.png', 'c.png'])
  })

  test('never retries a folder that could not be created', async () => {
    const project = new FakeProject({ 'main.tex': 'x' })
    project.failFolders.add('figs')
    const root = await localFolder({ 'a.png': png(1), 'b.png': png(2) })

    const result = await new SyncApi(project.deps()).batchUpload(PROJECT, [
      { localPath: join(root, 'a.png'), destinationPath: 'figs/a.png' },
      { localPath: join(root, 'b.png'), destinationPath: 'figs/sub/b.png' },
    ])

    expect(project.mutations).toEqual([])
    expect(result.failed).toEqual([
      { destinationPath: 'figs', action: 'create_folder', errorCode: 'PERMISSION_DENIED', message: 'Overleaf returned HTTP 403.' },
      { destinationPath: 'figs/a.png', action: 'upload', errorCode: 'PERMISSION_DENIED', message: expect.stringContaining('figs') },
      { destinationPath: 'figs/sub/b.png', action: 'upload', errorCode: 'PERMISSION_DENIED', message: expect.stringContaining('figs/sub') },
    ])
  })

  test('moves an acknowledged upload the tree does not show to failed', async () => {
    const project = new FakeProject({ 'main.tex': 'x' })
    project.dropUploads.add('a.png')
    const root = await localFolder({ 'a.png': png(1) })

    const result = await new SyncApi(project.deps()).batchUpload(PROJECT, [
      { localPath: join(root, 'a.png'), destinationPath: 'a.png' },
    ])

    expect(result.completed).toEqual([])
    expect(result.failed).toEqual([
      { destinationPath: 'a.png', action: 'upload', errorCode: 'REMOTE_ERROR', message: expect.stringContaining('nothing is at this path') },
    ])
    expect(result.verified).toBe(true)
    expect(result.status).toBe('partial')
  })

  test('classifies a timed-out upload from the tree read back afterwards and never resubmits it', async () => {
    const project = new FakeProject({ 'main.tex': 'x', 'same.png': png(5) })
    project.timeoutUploads.set('landed.png', 'landed')
    project.timeoutUploads.set('lost.png', 'lost')
    project.timeoutUploads.set('notes.tex', 'landed')
    project.timeoutUploads.set('same.png', 'landed')
    const root = await localFolder({ 'landed.png': png(1), 'lost.png': png(2), 'notes.tex': 'text\n', 'same.png': png(5) })

    const result = await new SyncApi(project.deps()).batchUpload(
      PROJECT,
      ['landed.png', 'lost.png', 'notes.tex', 'same.png'].map(name => ({ localPath: join(root, name), destinationPath: name }))
    )

    expect(project.mutations).toEqual(['upload landed.png', 'upload lost.png', 'upload notes.tex', 'upload same.png'])
    expect(result.completed).toEqual([
      {
        destinationPath: 'landed.png',
        action: 'upload',
        entityId: project.entities.get('landed.png')!.id,
        entityType: 'file',
        replaced: false,
        recoveredAfterTimeout: true,
      },
      // The project already held these bytes, which is the outcome asked for either way.
      {
        destinationPath: 'same.png',
        action: 'upload',
        entityId: project.entities.get('same.png')!.id,
        entityType: 'file',
        replaced: true,
        recoveredAfterTimeout: true,
      },
    ])
    expect(result.failed).toEqual([
      { destinationPath: 'lost.png', action: 'upload', errorCode: 'TIMEOUT', message: expect.stringContaining('had not landed') },
      { destinationPath: 'notes.tex', action: 'upload', errorCode: 'OUTCOME_UNKNOWN', message: expect.stringContaining('get_project_tree') },
    ])
  })

  test('reports verified false when the tree cannot be read back', async () => {
    const project = new FakeProject({ 'main.tex': 'x' })
    project.failTreeReadsAfter = 1
    const root = await localFolder({ 'a.png': png(1) })

    const result = await new SyncApi(project.deps()).batchUpload(PROJECT, [
      { localPath: join(root, 'a.png'), destinationPath: 'a.png' },
    ])

    expect(result.verified).toBe(false)
    expect(result.completed.map(entry => entry.destinationPath)).toEqual(['a.png'])
  })

  test('reports progress per file and reads the tree only when something was sent', async () => {
    const project = new FakeProject({ 'main.tex': 'x', 'a.png': png(1) })
    const root = await localFolder({ 'a.png': png(2) })
    const progress: Array<[number, number]> = []

    const result = await new SyncApi(project.deps()).batchUpload(
      PROJECT,
      [{ localPath: join(root, 'a.png'), destinationPath: 'a.png' }],
      { onConflict: 'skip', onProgress: async (done, total) => void progress.push([done, total]) }
    )

    expect(result).toMatchObject({ status: 'complete', verified: true, completed: [] })
    expect(progress).toEqual([[1, 1]])
    expect(project.treeReads).toBe(1)
  })
})
