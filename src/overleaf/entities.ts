import { readFile, writeFile } from 'node:fs/promises'
import { basename, posix } from 'node:path'

import { McpError } from '../core/errors.js'
import { gitBlobHash } from '../core/hash.js'
import { AccessPolicy } from '../core/policy.js'
import type { FifoQueue } from '../core/queue.js'
import {
  normalizeProjectPath,
  parentPath,
  resolveProjectPath,
  TREE_HASH_NOTE,
  type ProjectEntity,
  type ProjectTree,
} from './tree.js'

interface EntityHttp {
  postJson(path: string, body?: unknown): Promise<unknown>
  deleteJson(path: string): Promise<unknown>
  postForm(path: string, form: FormData): Promise<unknown>
  getBytes(path: string): Promise<Uint8Array>
}

interface TreeConnection {
  queue: FifoQueue
  getTree(): ProjectEntity[]
  rootFolderId: string
  trackChangesActive: boolean
  rootDocId?: string | undefined
  compiler?: string | undefined
  imageName?: string | undefined
  spellCheckLanguage?: string | undefined
}

/** Overleaf reports every upload rejection as HTTP 422 with a machine-readable code. */
const UPLOAD_ERRORS: Record<string, string> = {
  duplicate_file_name:
    'Overleaf already holds an entity with this name in the destination folder that an upload cannot replace, usually a folder. Delete or rename it first.',
  invalid_filename:
    'Overleaf rejected the file name. Names are limited to 150 characters and may not use reserved names or path separators.',
  project_has_too_many_files: 'The project has reached its file-count limit.',
  folder_not_found: 'The destination folder no longer exists in the project tree.',
}

interface UploadResponse {
  success?: boolean
  error?: string
  entity_id?: string
  entity_type?: string
  hash?: string
}

function parseUploadResponse(value: unknown): UploadResponse {
  const body: unknown = Array.isArray(value) ? value[0] : value
  return body !== null && typeof body === 'object' ? body : {}
}

function uploadFailure(code: string | undefined): McpError {
  const detail = code === undefined ? undefined : UPLOAD_ERRORS[code]
  return new McpError(
    'INVALID_ARGUMENT',
    detail ?? 'Overleaf rejected the upload.',
    code === undefined ? {} : { details: { overleafError: code } }
  )
}

interface EntityConnections {
  withConnection<T>(projectId: string, operation: (connection: TreeConnection) => Promise<T>): Promise<T>
  invalidate(projectId: string): Promise<void>
}

export interface UploadFileOptions {
  /**
   * `skip` leaves an entity already at the destination path untouched and sends nothing. It is
   * checked inside the upload's queue job, so nothing this process does can slip in between.
   */
  ifExists?: 'replace' | 'skip' | undefined
}

export type EntityAction =
  | { action: 'create_folder'; path: string }
  | { action: 'rename'; path: string; newName: string }
  | { action: 'move'; path: string; destinationFolderPath: string }
  | { action: 'delete'; path: string; confirmPath: string }

function endpointType(entity: ProjectEntity): string {
  return entity.type === 'file' ? 'file' : entity.type
}

function validateName(name: string): void {
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    throw new McpError('INVALID_ARGUMENT', `Invalid entity name: ${name}`)
  }
}

function resolveFolderId(connection: TreeConnection, path: string): string {
  if (path === '') return connection.rootFolderId
  return resolveProjectPath(connection.getTree(), path, 'folder').id
}

export class EntitiesApi {
  readonly #http: EntityHttp
  readonly #connections: EntityConnections
  readonly #policy: AccessPolicy

  constructor(http: EntityHttp, connections: EntityConnections, policy: AccessPolicy = AccessPolicy.permissive) {
    this.#http = http
    this.#connections = connections
    this.#policy = policy
  }

  async getProjectTree(projectId: string): Promise<ProjectTree> {
    this.#policy.assertProject(projectId)
    this.#policy.assertEffect('overleaf-read')
    return await this.#connections.withConnection(projectId, async connection =>
      await connection.queue.run(() => {
        const entities = connection.getTree()
        const rootDocPath =
          connection.rootDocId === undefined
            ? undefined
            : entities.find(entity => entity.id === connection.rootDocId)?.path
        return {
          entities,
          ...(rootDocPath === undefined ? {} : { rootDocPath }),
          ...(connection.compiler === undefined ? {} : { compiler: connection.compiler }),
          ...(connection.imageName === undefined ? {} : { imageName: connection.imageName }),
          ...(connection.spellCheckLanguage === undefined
            ? {}
            : { spellCheckLanguage: connection.spellCheckLanguage }),
          trackChangesActive: connection.trackChangesActive,
          hashNote: TREE_HASH_NOTE,
        }
      })
    )
  }

  /** Resolves the project's configured root document, used when a compile names no root. */
  async getRootDocument(projectId: string): Promise<ProjectEntity | undefined> {
    this.#policy.assertProject(projectId)
    return await this.#connections.withConnection(projectId, async connection =>
      await connection.queue.run(() => {
        if (connection.rootDocId === undefined) return undefined
        return connection.getTree().find(entity => entity.id === connection.rootDocId)
      })
    )
  }

  async createEmptyFile(projectId: string, filePath: string): Promise<unknown> {
    this.#policy.assertProject(projectId)
    this.#policy.assertEffect('overleaf-write')
    const normalized = normalizeProjectPath(filePath)
    const name = posix.basename(normalized)
    validateName(name)
    const created = await this.#connections.withConnection(projectId, async connection =>
      await connection.queue.run(async () => {
        const parentFolderId = resolveFolderId(connection, parentPath(normalized))
        return await this.#http.postJson(`/project/${encodeURIComponent(projectId)}/doc`, {
          parent_folder_id: parentFolderId,
          name,
        })
      })
    )
    await this.#connections.invalidate(projectId)
    return created
  }

  async manageEntity(projectId: string, input: EntityAction): Promise<Record<string, unknown>> {
    this.#policy.assertProject(projectId)
    this.#policy.assertEffect(input.action === 'delete' ? 'overleaf-delete' : 'overleaf-write')
    const normalized = normalizeProjectPath(input.path)
    const project = encodeURIComponent(projectId)
    const result = await this.#connections.withConnection(projectId, async connection =>
      await connection.queue.run(async () => {
        if (input.action === 'create_folder') {
          const name = posix.basename(normalized)
          validateName(name)
          const parentFolderId = resolveFolderId(connection, parentPath(normalized))
          const created = await this.#http.postJson(`/project/${project}/folder`, {
            parent_folder_id: parentFolderId,
            name,
          })
          return {
            action: input.action,
            created,
            trackChangesActive: connection.trackChangesActive,
            writeMode: 'untracked',
          }
        }

        const entity = resolveProjectPath(connection.getTree(), normalized)
        const route = `/project/${project}/${endpointType(entity)}/${encodeURIComponent(entity.id)}`
        if (input.action === 'rename') {
          validateName(input.newName)
          await this.#http.postJson(`${route}/rename`, {
            name: input.newName,
          })
          return {
            action: input.action,
            id: entity.id,
            trackChangesActive: connection.trackChangesActive,
            writeMode: 'untracked',
          }
        }
        if (input.action === 'move') {
          const folderId = resolveFolderId(
            connection,
            input.destinationFolderPath === ''
              ? ''
              : normalizeProjectPath(input.destinationFolderPath)
          )
          await this.#http.postJson(`${route}/move`, {
            folder_id: folderId,
          })
          return {
            action: input.action,
            id: entity.id,
            trackChangesActive: connection.trackChangesActive,
            writeMode: 'untracked',
          }
        }
        if (normalizeProjectPath(input.confirmPath) !== normalized || input.confirmPath !== input.path) {
          throw new McpError(
            'CONFIRMATION_MISMATCH',
            'confirmPath must exactly match path before an entity can be deleted.'
          )
        }
        await this.#http.deleteJson(route)
        return {
          action: input.action,
          id: entity.id,
          trackChangesActive: connection.trackChangesActive,
          writeMode: 'untracked',
        }
      })
    )
    await this.#connections.invalidate(projectId)
    return result
  }

  /**
   * Uploads a local file, replacing any entity already at the destination path.
   *
   * Overleaf upserts by name inside the destination folder. Per its source, a text document
   * replaced by text keeps its `entity_id`; a replaced binary, or a change between document and
   * binary, gets a new one. Overleaf, not the caller, decides whether the result is a text `doc`
   * or a binary `file`, by extension and UTF-8 validity. Replacing a `doc` this way is a blind
   * write with no revision check, so a collaborator's concurrent edit is overwritten; Overleaf
   * records it as tracked changes when track changes is on for this user, which the
   * `writeMode: 'untracked'` in the result does not reflect yet. Use `write_file` when that
   * matters.
   */
  async uploadFile(
    projectId: string,
    localPath: string,
    destinationFolderPath = '',
    destinationName?: string,
    options: UploadFileOptions = {}
  ): Promise<Record<string, unknown>> {
    this.#policy.assertProject(projectId)
    this.#policy.assertEffect('overleaf-write')
    const bytes = await readFile(await this.#policy.resolveLocalRead(localPath))
    const name = destinationName ?? basename(localPath)
    validateName(name)
    const folderPath = destinationFolderPath === '' ? '' : normalizeProjectPath(destinationFolderPath)
    const path = folderPath === '' ? name : normalizeProjectPath(posix.join(folderPath, name))
    const localHash = gitBlobHash(bytes)

    const result = await this.#connections.withConnection(projectId, async connection =>
      await connection.queue.run(async () => {
        const folderId = resolveFolderId(connection, folderPath)
        // Captured before the upload, because afterwards the entity always exists.
        const existing = connection.getTree().find(entity => entity.path === path)
        if (existing !== undefined && options.ifExists === 'skip') {
          if (existing.type === 'folder') {
            throw new McpError('INVALID_ARGUMENT', `The project holds a folder at ${path}.`)
          }
          return { path, skipped: true, entityId: existing.id, entityType: existing.type }
        }
        const replaced = existing !== undefined
        // Replacing a document this way has no revision check.
        if (existing?.type === 'doc') this.#policy.assertEffect('unchecked-replace')
        const form = new FormData()
        form.append('qqfile', new Blob([bytes]), name)
        form.append('name', name)
        let raw: unknown
        try {
          raw = await this.#http.postForm(
            `/project/${encodeURIComponent(projectId)}/upload?folder_id=${encodeURIComponent(folderId)}`,
            form
          )
        } catch (error) {
          // Every Overleaf upload rejection is a 422 carrying a machine-readable code.
          if (
            error instanceof McpError &&
            (error.details as { status?: number } | undefined)?.status === 422
          ) {
            throw uploadFailure((error.details as { overleafError?: string }).overleafError)
          }
          throw error
        }
        const body = parseUploadResponse(raw)
        if (body.success === false) throw uploadFailure(body.error)
        const entityType = body.entity_type
        // Only binary file entities have a hash; Overleaf stores none for documents.
        const hash =
          body.hash ?? (entityType === undefined || entityType === 'file' ? localHash : undefined)
        return {
          ...(body.entity_id === undefined ? {} : { entityId: body.entity_id }),
          ...(entityType === undefined ? {} : { entityType }),
          path,
          replaced,
          ...(hash === undefined ? {} : { hash }),
          trackChangesActive: connection.trackChangesActive,
          writeMode: 'untracked',
        }
      })
    )
    await this.#connections.invalidate(projectId)
    return result
  }

  async downloadFile(
    projectId: string,
    filePath: string,
    localPath: string,
    overwrite = false
  ): Promise<{ bytes: number; localPath: string }> {
    this.#policy.assertProject(projectId)
    this.#policy.assertEffect('overleaf-read')
    // Checked before anything is fetched, so a refused path costs no request.
    const writePath = await this.#policy.resolveLocalWrite(localPath)
    const bytes = await this.#connections.withConnection(projectId, async connection =>
      await connection.queue.run(async () => {
        const entity = resolveProjectPath(connection.getTree(), filePath)
        if (entity.type === 'folder') {
          throw new McpError('INVALID_ARGUMENT', 'Folders cannot be downloaded with download_file.')
        }
        const project = encodeURIComponent(projectId)
        const route =
          entity.type === 'doc'
            ? `/Project/${project}/doc/${encodeURIComponent(entity.id)}/download`
            : `/Project/${project}/file/${encodeURIComponent(entity.id)}`
        return await this.#http.getBytes(route)
      })
    )
    try {
      // 'wx' fails rather than truncating a file the caller did not mean to replace.
      await writeFile(writePath, bytes, overwrite ? undefined : { flag: 'wx' })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new McpError(
          'INVALID_ARGUMENT',
          `${localPath} already exists. Pass overwrite: true to replace it.`,
          { cause: error }
        )
      }
      throw error
    }
    return { bytes: bytes.byteLength, localPath }
  }
}
