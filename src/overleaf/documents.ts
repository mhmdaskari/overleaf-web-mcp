import { asMcpError, McpError } from '../core/errors.js'
import { createOutsideBmpPreservingEdits, type TextEdit } from '../core/diff.js'
import { chooseEdits, createRangeLayout, type RangeLayout, type TextSpan } from '../core/edit-placement.js'
import { assertDocumentSize, assertUpdateSize } from '../core/limits.js'
import { AccessPolicy } from '../core/policy.js'
import type { FifoQueue } from '../core/queue.js'
import { assertRevisionMatches, contentHash, createRevision, type OtProtocol } from '../core/revision.js'
import { normalizeLf } from '../core/text.js'
import {
  buildHistoryTextOperation,
  buildShareJsOperation,
  generateIdSeed,
  historyRangeLayout,
  historyVisibleContent,
  makeUpdate,
  type HistoryOperation,
  type HistorySnapshot,
  type ShareJsComponent,
} from '../protocol/ot.js'
import type { JoinedDocument } from '../protocol/project-connection.js'
import { parseShareJsChanges, trackedWriteCoverage } from '../protocol/tracked-changes.js'
import {
  isUnchangedDocument,
  isUnconfirmedWriteError,
  notAppliedError,
  observeUnconfirmedWrite,
  refusedUpdateReason,
} from './recovery.js'
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
  withConnection<T>(projectId: string, operation: (connection: DocumentConnection) => Promise<T>): Promise<T>
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
  recoveredAfterTimeout?: true
}

export type WriteMode = 'untracked' | 'tracked'

interface SubmitResult {
  before: JoinedDocument
  live?: JoinedDocument
  trackChangesActive: boolean
  submitError?: unknown
  /** The operation sent; absent for a no-op write, which sends nothing. */
  operation?: unknown[]
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

/**
 * The 1-based line in `target` of the first character outside the BMP that a ShareJS write would
 * have to send. The write edits around one the document already holds, so only a character the
 * target adds, or moves past another, counts.
 */
function insertedOutsideBmpLine(current: string, target: string): number | undefined {
  const plan = createOutsideBmpPreservingEdits(current, target)
  if (!('insertedAt' in plan)) return undefined
  return target.slice(0, plan.insertedAt).split('\n').length
}

/**
 * Overleaf's document updater refuses an update that would leave a document with more than this
 * many tracked changes (`MAX_CHANGES` in its RangesManager), with `too many comments or tracked
 * changes`.
 */
export const MAX_TRACKED_CHANGES = 2000

/** How many tracked changes the document holds before the write. */
function existingTrackedChanges(document: JoinedDocument): number {
  if (document.protocol === 'history-ot') {
    const snapshot = document.rawSnapshot as HistorySnapshot
    return Array.isArray(snapshot.trackedChanges) ? snapshot.trackedChanges.length : 0
  }
  const ranges = document.ranges
  if (typeof ranges !== 'object' || ranges === null) return 0
  const changes = (ranges as { changes?: unknown }).changes
  return Array.isArray(changes) ? changes.length : 0
}

function shareJsComments(ranges: unknown): TextSpan[] {
  const comments = (ranges as { comments?: unknown } | null | undefined)?.comments
  if (!Array.isArray(comments)) return []
  return comments.flatMap(entry => {
    const op = (entry as { op?: { p?: unknown; c?: unknown } } | null)?.op
    return typeof op?.p === 'number' && typeof op.c === 'string' ? [{ start: op.p, end: op.p + op.c.length }] : []
  })
}

/** Where a document's comments and tracked changes sit in its visible text. */
function documentRanges(document: JoinedDocument): RangeLayout {
  if (document.protocol === 'history-ot') return historyRangeLayout(document.rawSnapshot as HistorySnapshot)
  const changes = parseShareJsChanges(document.ranges)
  return createRangeLayout(
    changes.filter(change => change.type === 'delete').map(change => change.position),
    [
      ...changes
        .filter(change => change.type === 'insert')
        .map(change => ({ start: change.position, end: change.position + change.length })),
      ...shareJsComments(document.ranges),
    ]
  )
}

/**
 * Whether a ShareJS document holds tracked deletions that share a point, or touching insertions by
 * one author. After any untracked delete Overleaf merges each such pair, wherever it is in the
 * document, the first one's author keeping a merged deletion. Editing never leaves one; a document
 * converted from history-OT can.
 */
function holdsMergeablePairs(document: JoinedDocument): boolean {
  if (document.protocol !== 'sharejs') return false
  const changes = parseShareJsChanges(document.ranges)
  const deletionPoints = new Set<number>()
  const insertEnds = new Set<string>()
  for (const change of changes) {
    if (change.type === 'delete') {
      if (deletionPoints.has(change.position)) return true
      deletionPoints.add(change.position)
    } else {
      insertEnds.add(`${change.authorId}\u0000${change.position + change.length}`)
    }
  }
  return changes.some(
    change => change.type === 'insert' && insertEnds.has(`${change.authorId}\u0000${change.position}`)
  )
}

/**
 * The tracked changes `edits` add: for a tracked write, one per deletion and one per insertion.
 * Edits that touch no tracked change neither split nor fold one, and an untracked write records
 * none.
 */
function addedTrackedChanges(edits: readonly TextEdit[], tracked: boolean): number {
  if (!tracked) return 0
  return edits.reduce((added, edit) => added + (edit.deleteText === '' ? 0 : 1) + (edit.insertText === '' ? 0 : 1), 0)
}

/**
 * The edits a write sends, chosen by `chooseEdits` around the document's comments and tracked
 * changes: one per changed group of words where none of them touches one of those ranges, then one
 * per changed run of lines on the same terms, and failing both one span, as before. A plan whose
 * changes, as `addedTrackedChanges` counts them, would take the document past Overleaf's limit is
 * passed over too, and so is every plan of an untracked write to a document that
 * `holdsMergeablePairs`, so that what Overleaf merges is what the span always merged. The line
 * search runs once for every attempt.
 */
export function planEdits(
  document: JoinedDocument,
  visibleBefore: string,
  target: string,
  tracked: { userId: string } | undefined
): TextEdit[] {
  const existing = existingTrackedChanges(document)
  const spanOnly = tracked === undefined && holdsMergeablePairs(document)
  return chooseEdits(
    visibleBefore,
    target,
    documentRanges(document),
    edits => !spanOnly && existing + addedTrackedChanges(edits, tracked !== undefined) <= MAX_TRACKED_CHANGES
  )
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
 * Reads and writes collaborative documents through revision-checked OT updates that change only
 * the words that differ.
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

  constructor(connections: ConnectionProvider, options: DocumentsApiOptions = {}) {
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
    return await this.#connections.withConnection(
      projectId,
      async connection =>
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

    const submitted = await this.#connections.withConnection(
      projectId,
      async connection =>
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
          if (before.protocol === 'sharejs') {
            // The legacy editor replaces each such character with U+FFFD, so the write could never verify.
            const line = insertedOutsideBmpLine(before.content, target)
            if (line !== undefined) {
              await safelyLeave(connection, entity.id)
              throw new McpError(
                'INVALID_ARGUMENT',
                "Overleaf's legacy editor cannot store characters outside the Basic Multilingual Plane, such as emoji, and would replace each with U+FFFD. Replace them, for example with a LaTeX command, and write again. Nothing was sent.",
                { details: { line } }
              )
            }
          }

          const tracking =
            writeMode === 'tracked' ? { userId: this.#currentUserId!, timestamp: new Date().toISOString() } : undefined
          const visibleBefore =
            before.protocol === 'sharejs'
              ? before.content
              : historyVisibleContent(before.rawSnapshot as HistorySnapshot)
          const edits = planEdits(before, visibleBefore, target, tracking)
          const operation =
            before.protocol === 'sharejs'
              ? buildShareJsOperation(before.content, target, edits)
              : buildHistoryTextOperation(before.rawSnapshot as HistorySnapshot, target, tracking, edits)
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
            writeMode === 'tracked' && before.protocol === 'sharejs' ? { tc: generateIdSeed() } : undefined
          )
          assertUpdateSize(update, this.#maxUpdateChars)

          let submitError: unknown
          try {
            await connection.submitUpdate(entity.id, update)
          } catch (error) {
            submitError = error
          }
          await safelyLeave(connection, entity.id)
          // OUTCOME_UNKNOWN means the socket failed after the update was sent, or Overleaf reported
          // an error on the document after it, so it may have applied.
          if (isUnconfirmedWriteError(submitError)) {
            return { before, trackChangesActive: connection.trackChangesActive, submitError, operation }
          }
          if (submitError) throw asMcpError(submitError)

          let live: JoinedDocument
          try {
            live = await connection.joinDocument(entity.id)
          } catch (error) {
            // The update applied, so a failed verification read is settled by observation, never a resend.
            return { before, trackChangesActive: connection.trackChangesActive, submitError: error, operation }
          }
          await safelyLeave(connection, entity.id)
          return { before, live, trackChangesActive: connection.trackChangesActive, operation }
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
      this.#assertTracked(projectId, writeMode, submitted, submitted.live)
      return resultFor(projectId, submitted.live, submitted.trackChangesActive, writeMode)
    }

    // Never retry an ambiguous write: observe whether the target, original, or a third state is live.
    const timedOut = submitted.submitError instanceof McpError && submitted.submitError.code === 'TIMEOUT'
    const reason = refusedUpdateReason(submitted.submitError)
    const unconfirmed = timedOut ? 'timed out' : reason !== undefined ? 'met an Overleaf error' : 'lost its socket'
    await this.#connections.invalidate?.(projectId)
    const observation = await observeUnconfirmedWrite({
      observe: async () =>
        await this.#connections.withConnection(
          projectId,
          async connection =>
            await connection.queue.run(async () => {
              const entity = resolveProjectPath(connection.getTree(), filePath, 'doc')
              const live = await connection.joinDocument(entity.id)
              await safelyLeave(connection, entity.id)
              return { live, trackChangesActive: connection.trackChangesActive }
            })
        ),
      // The intended hash proves the unconfirmed submission was applied.
      classify: recovery =>
        contentHash(recovery.live.content) === contentHash(target)
          ? 'target'
          : isUnchangedDocument(recovery.live, submitted.before)
            ? 'original'
            : 'other',
      timeoutMs: this.#recoveryTimeoutMs,
      pollIntervalMs: this.#recoveryPollIntervalMs,
      // Any third state may include concurrent work and must be reported as a conflict.
      onOther: recovery =>
        new McpError('REVISION_CONFLICT', `Live content changed after the write ${unconfirmed}.`, {
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
        }),
      onUnobserved: cause =>
        new McpError('OUTCOME_UNKNOWN', `Could not observe live content after the write ${unconfirmed}.`, { cause }),
    })
    if (observation.state === 'target') {
      this.#assertTracked(projectId, writeMode, submitted, observation.observed.live)
      return resultFor(projectId, observation.observed.live, observation.observed.trackChangesActive, writeMode, true)
    }
    // Seeing the original revision through the full recovery window proves no application was observed.
    throw notAppliedError(
      submitted.submitError,
      `The write ${unconfirmed} and the original revision is still live.`,
      reason === undefined ? {} : { reason }
    )
  }

  /**
   * Refuses a tracked write that Overleaf applied without recording it as tracked changes by this
   * account. It is live, so it is reported and never reverted: a revert would be another write.
   */
  #assertTracked(projectId: string, writeMode: WriteMode, submitted: SubmitResult, live: JoinedDocument): void {
    const operation = submitted.operation
    if (writeMode !== 'tracked' || operation === undefined || operation.length === 0) return
    const liveRevision = createRevision({
      projectId,
      docId: live.docId,
      protocol: live.protocol,
      otVersion: live.version,
      content: live.content,
    })
    // The operation's positions describe the document only right after it. Another update since,
    // even one that kept the text, such as a decision on a tracked change, may have moved or
    // removed the ranges, so whether this write was tracked can no longer be told.
    if (live.version !== submitted.before.version + 1) {
      throw new McpError(
        'REVISION_CONFLICT',
        'The write applied, but another update followed it before it could be checked that Overleaf recorded it as tracked changes by this account. Read the file and list its tracked changes before writing again.',
        { retryable: false, details: { outcome: 'unknown', liveRevision } }
      )
    }
    const userId = this.#currentUserId!
    const coverage =
      live.protocol === 'history-ot'
        ? trackedWriteCoverage({
            protocol: 'history-ot',
            after: live.rawSnapshot as HistorySnapshot,
            operation: operation as HistoryOperation[],
            userId,
          })
        : trackedWriteCoverage({
            protocol: 'sharejs',
            beforeContent: submitted.before.content,
            beforeRanges: submitted.before.ranges,
            afterRanges: live.ranges,
            operation: operation as ShareJsComponent[],
            userId,
          })
    if (coverage.uncoveredInserts === 0 && coverage.uncoveredDeletes === 0) return
    throw new McpError(
      'PROTOCOL_UNSUPPORTED',
      'The write applied, but Overleaf did not record all of it as tracked changes by this account. It is live and was not reverted: read the file and review the text before writing again.',
      {
        retryable: false,
        details: { kind: 'applied_untracked', liveRevision },
      }
    )
  }
}
