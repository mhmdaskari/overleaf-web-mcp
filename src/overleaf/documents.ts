import { asMcpError, McpError } from '../core/errors.js'
import { assertDocumentSize, assertUpdateSize } from '../core/limits.js'
import { AccessPolicy } from '../core/policy.js'
import type { FifoQueue } from '../core/queue.js'
import {
  assertRevisionMatches,
  contentHash,
  createRevision,
  type OtProtocol,
} from '../core/revision.js'
import { normalizeLf } from '../core/text.js'
import {
  buildHistoryTextOperation,
  buildShareJsOperation,
  makeUpdate,
  type HistorySnapshot,
} from '../protocol/ot.js'
import type { JoinedDocument } from '../protocol/project-connection.js'
import { resolveProjectPath, type ProjectEntity } from './tree.js'

interface DocumentConnection {
  queue: FifoQueue
  getTree(): ProjectEntity[]
  joinDocument(docId: string): Promise<JoinedDocument>
  leaveDocument(docId: string): Promise<void>
  submitUpdate(docId: string, update: Record<string, unknown>): Promise<void>
  trackChangesActive: boolean
}

interface ConnectionProvider {
  withConnection<T>(
    projectId: string,
    operation: (connection: DocumentConnection) => Promise<T>
  ): Promise<T>
  invalidate?(projectId: string): Promise<void>
}

export interface ReadFileResult {
  content: string
  revision: string
  newline: 'LF'
  protocol: OtProtocol
  trackChangesActive: boolean
}

export interface WriteFileResult {
  revision: string
  protocol: OtProtocol
  trackChangesActive: boolean
  writeMode: WriteMode
  recoveredAfterTimeout?: boolean
}

export type WriteMode = 'untracked' | 'tracked'

interface SubmitResult {
  before: JoinedDocument
  live?: JoinedDocument
  trackChangesActive: boolean
  submitError?: unknown
}

export interface DocumentsApiOptions {
  maxDocLength?: number
  maxUpdateChars?: number
  recoveryTimeoutMs?: number
  recoveryPollIntervalMs?: number
  currentUserId?: string
  /** Defaults to allowing everything but ids that are not path-safe. */
  policy?: AccessPolicy
}

async function safelyLeave(connection: DocumentConnection, docId: string): Promise<void> {
  try {
    await connection.leaveDocument(docId)
  } catch {
    // Verification or the primary write error is more actionable than cleanup failure.
  }
}

function resultFor(
  projectId: string,
  document: JoinedDocument,
  trackChangesActive: boolean,
  writeMode: WriteMode,
  recoveredAfterTimeout = false
): WriteFileResult {
  return {
    revision: createRevision({
      projectId,
      docId: document.docId,
      protocol: document.protocol,
      otVersion: document.version,
      content: document.content,
    }),
    protocol: document.protocol,
    trackChangesActive,
    writeMode,
    ...(recoveredAfterTimeout ? { recoveredAfterTimeout: true } : {}),
  }
}

/**
 * Reads and writes collaborative documents through revision-checked, minimal OT updates.
 * Successful mutations are rejoined and hash-verified before a new revision is returned.
 */
export class DocumentsApi {
  readonly #connections: ConnectionProvider
  readonly #maxDocLength: number
  readonly #maxUpdateChars: number
  readonly #recoveryTimeoutMs: number
  readonly #recoveryPollIntervalMs: number
  readonly #currentUserId: string | undefined
  readonly #policy: AccessPolicy

  constructor(
    connections: ConnectionProvider,
    options: DocumentsApiOptions = {}
  ) {
    this.#connections = connections
    this.#maxDocLength = options.maxDocLength ?? 2 * 1024 * 1024
    this.#maxUpdateChars = options.maxUpdateChars ?? 7 * 1024 * 1024
    this.#recoveryTimeoutMs = options.recoveryTimeoutMs ?? 30_000
    this.#recoveryPollIntervalMs = options.recoveryPollIntervalMs ?? 250
    this.#currentUserId = options.currentUserId
    this.#policy = options.policy ?? AccessPolicy.permissive
  }

  async readFile(projectId: string, filePath: string): Promise<ReadFileResult> {
    this.#policy.assertProject(projectId)
    this.#policy.assertEffect('overleaf-read')
    return await this.#connections.withConnection(projectId, async connection =>
      await connection.queue.run(async () => {
        const entity = resolveProjectPath(connection.getTree(), filePath, 'doc')
        const document = await connection.joinDocument(entity.id)
        await safelyLeave(connection, entity.id)
        const content = normalizeLf(document.content)
        return {
          content,
          revision: createRevision({
            projectId,
            docId: entity.id,
            protocol: document.protocol,
            otVersion: document.version,
            content,
          }),
          newline: 'LF',
          protocol: document.protocol,
          trackChangesActive: connection.trackChangesActive,
        }
      })
    )
  }

  async writeFile(
    projectId: string,
    filePath: string,
    revision: string,
    content: string,
    writeMode: WriteMode = 'untracked'
  ): Promise<WriteFileResult> {
    this.#policy.assertProject(projectId)
    this.#policy.assertEffect('overleaf-write')
    if (writeMode === 'tracked' && this.#currentUserId === undefined) {
      throw new McpError(
        'PROTOCOL_UNSUPPORTED',
        'Tracked writes require an authenticated Overleaf user ID from the project bootstrap.'
      )
    }
    const target = normalizeLf(content)
    assertDocumentSize(target, this.#maxDocLength)

    const submitted = await this.#connections.withConnection(projectId, async connection =>
      await connection.queue.run(async (): Promise<SubmitResult> => {
        const entity = resolveProjectPath(connection.getTree(), filePath, 'doc')
        const before = await connection.joinDocument(entity.id)
        assertRevisionMatches(revision, {
          projectId,
          docId: entity.id,
          protocol: before.protocol,
          otVersion: before.version,
          content: before.content,
        })

        const tracking =
          writeMode === 'tracked'
            ? { userId: this.#currentUserId!, timestamp: new Date().toISOString() }
            : undefined
        const operation = before.protocol === 'sharejs'
          ? buildShareJsOperation(before.content, target)
          : buildHistoryTextOperation(before.rawSnapshot as HistorySnapshot, target, tracking)
        if (operation.length === 0) {
          await safelyLeave(connection, entity.id)
          return {
            before,
            live: before,
            trackChangesActive: connection.trackChangesActive,
          }
        }
        const update = makeUpdate(
          entity.id,
          before.version,
          operation,
          before.protocol,
          writeMode === 'tracked' && before.protocol === 'sharejs'
            ? { tc: this.#currentUserId }
            : undefined
        )
        assertUpdateSize(update, this.#maxUpdateChars)

        let submitError: unknown
        try {
          await connection.submitUpdate(entity.id, update)
        } catch (error) {
          submitError = error
        }
        await safelyLeave(connection, entity.id)
        if (submitError instanceof McpError && submitError.code === 'TIMEOUT') {
          return { before, trackChangesActive: connection.trackChangesActive, submitError }
        }
        if (submitError) throw asMcpError(submitError)

        const live = await connection.joinDocument(entity.id)
        await safelyLeave(connection, entity.id)
        return { before, live, trackChangesActive: connection.trackChangesActive }
      })
    )

    if (submitted.live) {
      // An acknowledgement alone is insufficient: the rejoined snapshot must equal the target.
      if (submitted.live.protocol !== submitted.before.protocol) {
        throw new McpError('PROTOCOL_UNSUPPORTED', 'Document protocol changed during write verification.')
      }
      if (contentHash(submitted.live.content) !== contentHash(target)) {
        throw new McpError('REVISION_CONFLICT', 'Verified live content differs from the intended result.', {
          details: {
            outcome: 'unknown',
            liveRevision: createRevision({
              projectId,
              docId: submitted.live.docId,
              protocol: submitted.live.protocol,
              otVersion: submitted.live.version,
              content: submitted.live.content,
            }),
          },
        })
      }
      return resultFor(projectId, submitted.live, submitted.trackChangesActive, writeMode)
    }

    // Never retry an ambiguous write: observe whether the target, original, or a third state is live.
    await this.#connections.invalidate?.(projectId)
    const deadline = Date.now() + this.#recoveryTimeoutMs
    let unchangedRecovery: { live: JoinedDocument; trackChangesActive: boolean } | undefined
    let observationError: unknown
    do {
      try {
        const recovery = await this.#connections.withConnection(projectId, async connection =>
          await connection.queue.run(async () => {
            const entity = resolveProjectPath(connection.getTree(), filePath, 'doc')
            const live = await connection.joinDocument(entity.id)
            await safelyLeave(connection, entity.id)
            return { live, trackChangesActive: connection.trackChangesActive }
          })
        )
        observationError = undefined
        // The intended hash proves the timed-out submission was applied.
        if (contentHash(recovery.live.content) === contentHash(target)) {
          return resultFor(projectId, recovery.live, recovery.trackChangesActive, writeMode, true)
        }
        const unchanged =
          recovery.live.protocol === submitted.before.protocol &&
          recovery.live.version === submitted.before.version &&
          contentHash(recovery.live.content) === contentHash(submitted.before.content)
        if (!unchanged) {
          // Any third state may include concurrent work and must be reported as a conflict.
          throw new McpError('REVISION_CONFLICT', 'Live content changed after the write timed out.', {
            retryable: false,
            details: {
              outcome: 'unknown',
              liveRevision: createRevision({
                projectId,
                docId: recovery.live.docId,
                protocol: recovery.live.protocol,
                otVersion: recovery.live.version,
                content: recovery.live.content,
              }),
            },
          })
        }
        unchangedRecovery = recovery
      } catch (error) {
        if (error instanceof McpError && error.code === 'REVISION_CONFLICT') throw error
        observationError = error
      }
      if (Date.now() >= deadline) break
      await new Promise<void>(resolve => setTimeout(resolve, this.#recoveryPollIntervalMs))
    } while (Date.now() <= deadline)

    if (unchangedRecovery) {
      // Seeing the original revision through the full recovery window proves no application was observed.
      throw new McpError('TIMEOUT', 'The write timed out and the original revision is still live.', {
        retryable: false,
        details: { outcome: 'not_applied' },
      })
    }
    throw new McpError('OUTCOME_UNKNOWN', 'Could not observe live content after a timed-out write.', {
      cause: observationError,
    })
  }
}
