import { McpError } from '../core/errors.js'
import { FifoQueue } from '../core/queue.js'
import type { OtProtocol } from '../core/revision.js'
import { normalizeLf } from '../core/text.js'
import {
  flattenProjectTree,
  type ProjectEntity,
  type RawEntity,
  type RawFolder,
} from '../overleaf/tree.js'
import { historyVisibleContent, type HistorySnapshot } from './ot.js'
import { upstreamReason } from './upstream-reason.js'

export interface SocketPeerLike {
  on(event: string, listener: (...args: any[]) => void): this
  once(event: string, listener: (...args: any[]) => void): this
  removeListener(event: string, listener: (...args: any[]) => void): this
  call(name: string, args: unknown[], timeoutMs: number): Promise<unknown[]>
  close(): void
}

export interface JoinProjectData {
  publicId: string
  project: {
    _id: string
    rootFolder: RawFolder[]
    trackChangesState?: boolean | Record<string, boolean | undefined>
    rootDoc_id?: string
    compiler?: string
    imageName?: string
    spellCheckLanguage?: string
    [key: string]: unknown
  }
  permissionsLevel: string
  protocolVersion: number
}

export interface JoinedDocument {
  docId: string
  protocol: OtProtocol
  version: number
  content: string
  ranges: unknown
  rawSnapshot: string | HistorySnapshot
}

export interface ProjectConnectionOptions {
  projectId: string
  peer: SocketPeerLike
  join: JoinProjectData
  supportedProtocolVersions: number[]
  currentUserId?: string
  callTimeoutMs?: number
  applyTimeoutMs?: number
}

function decodeLegacyLine(line: string): string {
  const decoded = Buffer.from(line, 'latin1').toString('utf8')
  return decoded.includes('\uFFFD') ? line : decoded
}

function effectiveTrackChanges(
  state: boolean | Record<string, boolean | undefined> | undefined,
  userId?: string
): boolean {
  if (state === true) return true
  if (!state || typeof state === 'boolean') return false
  if (userId) return state[userId] === true
  return state.__guests__ === true
}

function findFolder(folders: RawFolder[], folderId: string): RawFolder | undefined {
  for (const folder of folders) {
    if (folder._id === folderId) return folder
    const nested = findFolder(folder.folders ?? [], folderId)
    if (nested) return nested
  }
  return undefined
}

function renameEntity(folders: RawFolder[], entityId: string, name: string): boolean {
  for (const folder of folders) {
    const entity = [folder, ...(folder.docs ?? []), ...(folder.fileRefs ?? [])]
      .find(candidate => candidate._id === entityId)
    if (entity) {
      entity.name = name
      return true
    }
    if (renameEntity(folder.folders ?? [], entityId, name)) return true
  }
  return false
}

type RemovedEntity =
  | { type: 'doc'; value: RawEntity }
  | { type: 'file'; value: RawEntity }
  | { type: 'folder'; value: RawFolder }

function takeEntity(folders: RawFolder[], entityId: string): RemovedEntity | undefined {
  for (const folder of folders) {
    const docIndex = (folder.docs ?? []).findIndex(entity => entity._id === entityId)
    if (docIndex >= 0) {
      const value = folder.docs?.splice(docIndex, 1)[0]
      if (value) return { type: 'doc', value }
    }
    const fileIndex = (folder.fileRefs ?? []).findIndex(entity => entity._id === entityId)
    if (fileIndex >= 0) {
      const value = folder.fileRefs?.splice(fileIndex, 1)[0]
      if (value) return { type: 'file', value }
    }
    const folderIndex = (folder.folders ?? []).findIndex(entity => entity._id === entityId)
    if (folderIndex >= 0) {
      const value = folder.folders?.splice(folderIndex, 1)[0]
      if (value) return { type: 'folder', value }
    }
    const nested = takeEntity(folder.folders ?? [], entityId)
    if (nested) return nested
  }
  return undefined
}

function insertEntity(folder: RawFolder, entity: RemovedEntity): void {
  if (entity.type === 'doc') (folder.docs ??= []).push(entity.value)
  else if (entity.type === 'file') (folder.fileRefs ??= []).push(entity.value)
  else (folder.folders ??= []).push(entity.value)
}

/**
 * Owns one joined project socket and its collaboration state.
 * A project-wide FIFO protects Overleaf's client-wide join/leave epoch across all documents.
 */
export class ProjectConnection {
  readonly projectId: string
  readonly peer: SocketPeerLike
  readonly project: JoinProjectData['project']
  readonly permissionsLevel: string
  readonly protocolVersion: number
  readonly publicId: string
  readonly trackChangesActive: boolean
  readonly queue = new FifoQueue()
  readonly #callTimeoutMs: number
  readonly #applyTimeoutMs: number

  constructor(options: ProjectConnectionOptions) {
    if (!options.supportedProtocolVersions.includes(options.join.protocolVersion)) {
      options.peer.close()
      throw new McpError(
        'PROTOCOL_UNSUPPORTED',
        `Overleaf protocol version ${options.join.protocolVersion} is unsupported.`,
        {
          details: {
            actual: options.join.protocolVersion,
            supported: options.supportedProtocolVersions,
          },
        }
      )
    }
    if (options.join.project._id !== options.projectId) {
      options.peer.close()
      throw new McpError('PROTOCOL_UNSUPPORTED', 'joinProject returned a different project.')
    }
    this.projectId = options.projectId
    this.peer = options.peer
    this.project = structuredClone(options.join.project)
    this.permissionsLevel = options.join.permissionsLevel
    this.protocolVersion = options.join.protocolVersion
    this.publicId = options.join.publicId
    this.trackChangesActive = effectiveTrackChanges(
      options.join.project.trackChangesState,
      options.currentUserId
    )
    this.#callTimeoutMs = options.callTimeoutMs ?? 30_000
    this.#applyTimeoutMs = options.applyTimeoutMs ?? this.#callTimeoutMs

    // The `recive*` spelling is part of Overleaf's wire protocol and must not be corrected locally.
    this.peer.on('reciveEntityRename', (entityId: unknown, name: unknown) => {
      if (typeof entityId === 'string' && typeof name === 'string') {
        renameEntity(this.project.rootFolder, entityId, name)
      }
    })
    this.peer.on('removeEntity', (entityId: unknown) => {
      if (typeof entityId === 'string') takeEntity(this.project.rootFolder, entityId)
    })
    this.peer.on('reciveEntityMove', (entityId: unknown, folderId: unknown) => {
      if (typeof entityId !== 'string' || typeof folderId !== 'string') return
      const destination = findFolder(this.project.rootFolder, folderId)
      if (!destination) return
      const entity = takeEntity(this.project.rootFolder, entityId)
      if (!entity) return
      insertEntity(destination, entity)
    })
    this.peer.on('reciveNewFolder', (folderId: unknown, folder: unknown) => {
      if (typeof folderId !== 'string' || !folder || typeof folder !== 'object') return
      const destination = findFolder(this.project.rootFolder, folderId)
      const value = folder as RawFolder
      if (destination && typeof value._id === 'string' && typeof value.name === 'string') {
        ;(destination.folders ??= []).push(value)
      }
    })
    this.peer.on('reciveNewDoc', (folderId: unknown, doc: unknown) => {
      if (typeof folderId !== 'string' || !doc || typeof doc !== 'object') return
      const destination = findFolder(this.project.rootFolder, folderId)
      const value = doc as RawEntity
      if (destination && typeof value._id === 'string' && typeof value.name === 'string') {
        ;(destination.docs ??= []).push(value)
      }
    })
    this.peer.on('reciveNewFile', (folderId: unknown, file: unknown) => {
      if (typeof folderId !== 'string' || !file || typeof file !== 'object') return
      const destination = findFolder(this.project.rootFolder, folderId)
      const value = file as RawEntity
      if (destination && typeof value._id === 'string' && typeof value.name === 'string') {
        ;(destination.fileRefs ??= []).push(value)
      }
    })
  }

  get rootFolderId(): string {
    const id = this.project.rootFolder[0]?._id
    if (!id) throw new McpError('PROTOCOL_UNSUPPORTED', 'Project has no root folder.')
    return id
  }

  /**
   * The root document Overleaf compiles by default, as declared in the joinProject payload.
   *
   * Callers that compile without naming a root would otherwise silently build whatever stub
   * a blank project shipped with, even when the real manuscript lives elsewhere.
   */
  get rootDocId(): string | undefined {
    const id = this.project.rootDoc_id
    return typeof id === 'string' && id !== '' ? id : undefined
  }

  get compiler(): string | undefined {
    const compiler = this.project.compiler
    return typeof compiler === 'string' && compiler !== '' ? compiler : undefined
  }

  get imageName(): string | undefined {
    const imageName = this.project.imageName
    return typeof imageName === 'string' && imageName !== '' ? imageName : undefined
  }

  /** Spell-check language code, absent when Overleaf reports none or spell checking is off. */
  get spellCheckLanguage(): string | undefined {
    const language = this.project.spellCheckLanguage
    return typeof language === 'string' && language !== '' ? language : undefined
  }

  getTree(): ProjectEntity[] {
    return flattenProjectTree(this.project.rootFolder)
  }

  async withDocument<T>(
    docId: string,
    operation: (document: JoinedDocument) => Promise<T>
  ): Promise<T> {
    // Documents are joined only for one queued operation, avoiding stale client-side snapshots.
    return await this.queue.run(async () => {
      const document = await this.joinDocument(docId)
      let result: T
      try {
        result = await operation(document)
      } catch (error) {
        try {
          await this.leaveDocument(docId)
        } catch {
          // Preserve the primary error; the socket will be recycled if needed.
        }
        throw error
      }
      try {
        await this.leaveDocument(docId)
      } catch (error) {
        throw new McpError('PARTIAL_CLEANUP', 'Document operation succeeded but leaveDoc failed.', {
          cause: error,
        })
      }
      return result
    })
  }

  async joinDocument(docId: string): Promise<JoinedDocument> {
    const args = await this.peer.call(
      'joinDoc',
      [docId, { encodeRanges: true, supportsHistoryOT: true }],
      this.#callTimeoutMs
    )
    const [error, rawLines, rawVersion, , ranges, rawType = 'sharejs-text-ot'] = args
    if (error) {
      throw new McpError('REMOTE_ERROR', 'Overleaf refused to open the document.', {
        details: { event: 'joinDoc', reason: upstreamReason(error) },
      })
    }
    if (!Number.isInteger(rawVersion)) {
      throw new McpError('PROTOCOL_UNSUPPORTED', 'joinDoc returned an invalid version.')
    }

    if (rawType === 'history-ot') {
      if (
        !rawLines ||
        typeof rawLines !== 'object' ||
        typeof (rawLines as HistorySnapshot).content !== 'string'
      ) {
        throw new McpError('PROTOCOL_UNSUPPORTED', 'Invalid history-OT snapshot.')
      }
      const snapshot = rawLines as HistorySnapshot
      return {
        docId,
        protocol: 'history-ot',
        version: rawVersion as number,
        content: normalizeLf(historyVisibleContent(snapshot)),
        ranges,
        rawSnapshot: snapshot,
      }
    }

    if (rawType !== 'sharejs-text-ot' && rawType !== 'sharejs') {
      throw new McpError('PROTOCOL_UNSUPPORTED', `Unsupported document protocol ${String(rawType)}.`)
    }
    if (!Array.isArray(rawLines) || rawLines.some(line => typeof line !== 'string')) {
      throw new McpError('PROTOCOL_UNSUPPORTED', 'Invalid ShareJS snapshot.')
    }
    const content = normalizeLf((rawLines as string[]).map(decodeLegacyLine).join('\n'))
    return {
      docId,
      protocol: 'sharejs',
      version: rawVersion as number,
      content,
      ranges,
      rawSnapshot: content,
    }
  }

  async leaveDocument(docId: string): Promise<void> {
    const [error] = await this.peer.call('leaveDoc', [docId], this.#callTimeoutMs)
    if (error) {
      throw new McpError('REMOTE_ERROR', 'Overleaf refused to close the document.', {
        details: { event: 'leaveDoc', reason: upstreamReason(error) },
      })
    }
  }

  async submitUpdate(docId: string, update: Record<string, unknown>): Promise<void> {
    const version = update.v
    if (!Number.isInteger(version)) {
      throw new McpError('INVALID_ARGUMENT', 'OT update requires an integer version.')
    }

    let appliedTimer: NodeJS.Timeout | undefined
    let onApplied: ((message: unknown) => void) | undefined
    let onUpdateError: ((error: unknown, message?: unknown) => void) | undefined
    const cleanup = (): void => {
      if (appliedTimer) clearTimeout(appliedTimer)
      if (onApplied) this.peer.removeListener('otUpdateApplied', onApplied)
      if (onUpdateError) this.peer.removeListener('otUpdateError', onUpdateError)
    }
    const applied = new Promise<void>((resolve, reject) => {
      onApplied = message => {
        if (
          message &&
          typeof message === 'object' &&
          (message as { doc?: unknown }).doc === docId &&
          (message as { v?: unknown }).v === version
        ) {
          cleanup()
          resolve()
        }
      }
      onUpdateError = (error, message) => {
        const metadata = message as { doc_id?: unknown } | undefined
        if (metadata?.doc_id !== undefined && metadata.doc_id !== docId) return
        cleanup()
        // The event can quote the rejected update, document text included, so only a reason is kept.
        reject(
          new McpError('REMOTE_ERROR', 'Overleaf rejected the OT update.', {
            details: { reason: upstreamReason(error) },
          })
        )
      }
      this.peer.on('otUpdateApplied', onApplied)
      this.peer.on('otUpdateError', onUpdateError)
      appliedTimer = setTimeout(() => {
        cleanup()
        reject(new McpError('TIMEOUT', 'Timed out waiting for otUpdateApplied.'))
      }, this.#applyTimeoutMs)
    })

    try {
      // The callback acknowledges receipt; only the matching event confirms application.
      const [error] = await this.peer.call(
        'applyOtUpdate',
        [docId, update],
        this.#applyTimeoutMs
      )
      if (error) {
        throw new McpError('REMOTE_ERROR', 'Overleaf refused the OT update.', {
          details: { event: 'applyOtUpdate', reason: upstreamReason(error) },
        })
      }
      await applied
    } catch (error) {
      cleanup()
      void applied.catch(() => undefined)
      throw error
    }
  }

  close(): void {
    this.peer.close()
  }
}
