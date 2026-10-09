import { randomBytes } from 'node:crypto'

import { asMcpError, McpError } from '../core/errors.js'
import { assertUpdateSize } from '../core/limits.js'
import { AccessPolicy, assertPathSafeId } from '../core/policy.js'
import type { FifoQueue } from '../core/queue.js'
import {
  assertRevisionMatches,
  contentHash,
  createRevision,
  type OtProtocol,
} from '../core/revision.js'
import { lineColumnToOffset, normalizeLf, offsetToLineColumn, type LineColumn } from '../core/text.js'
import {
  buildCommentOperation,
  buildStatusOperation,
  makeUpdate,
  snapshotToVisibleOffset,
  visibleToSnapshotOffset,
  type HistorySnapshot,
} from '../protocol/ot.js'
import type { JoinedDocument } from '../protocol/project-connection.js'
import { resolveProjectPath, type ProjectEntity } from './tree.js'

interface CommentHttp {
  getJson(path: string): Promise<unknown>
  postJson(path: string, body?: unknown): Promise<unknown>
  deleteJson(path: string): Promise<unknown>
}

interface CommentConnection {
  queue: FifoQueue
  getTree(): ProjectEntity[]
  joinDocument(docId: string): Promise<JoinedDocument>
  leaveDocument(docId: string): Promise<void>
  submitUpdate(docId: string, update: Record<string, unknown>): Promise<void>
  trackChangesActive: boolean
}

interface CommentConnections {
  withConnection<T>(
    projectId: string,
    operation: (connection: CommentConnection) => Promise<T>
  ): Promise<T>
  invalidate(projectId: string): Promise<void>
}

interface ThreadMessage {
  id?: string
  content?: string
  timestamp?: string | number
  user_id?: string
  user?: { id?: string; name?: string; email?: string; [key: string]: unknown }
  [key: string]: unknown
}

interface ThreadData {
  messages?: ThreadMessage[]
  resolved?: boolean
  [key: string]: unknown
}

type ThreadsResponse = Record<string, ThreadData>

interface LocatedRange {
  threadId: string
  docId: string
  start: number
  end: number
  quotedText?: string
  resolved?: boolean
}

export interface ListedComment extends ThreadData {
  id: string
  status: 'open' | 'resolved'
  filePath?: string
  start?: LineColumn
  end?: LineColumn
  quotedText?: string
  unlocated?: boolean
}

export interface AddCommentInput {
  projectId: string
  filePath: string
  revision: string
  start: LineColumn
  end: LineColumn
  expectedText: string
  content: string
}

export interface CommentsApiOptions {
  currentUserId?: string
  maxUpdateChars?: number
  threadIdFactory?: () => string
  now?: () => number
  recoveryTimeoutMs?: number
  recoveryPollIntervalMs?: number
  /** Defaults to allowing everything but ids that are not path-safe. */
  policy?: AccessPolicy
}

function generateThreadId(): string {
  const timestamp = Math.floor(Date.now() / 1000).toString(16).padStart(8, '0')
  return `${timestamp}${randomBytes(5).toString('hex')}000001`.slice(0, 24)
}

function legacyRange(docId: string, value: unknown): LocatedRange | undefined {
  if (!value || typeof value !== 'object') return undefined
  const entry = value as {
    id?: unknown
    op?: { p?: unknown; c?: unknown; t?: unknown }
    resolved?: unknown
  }
  const threadId = typeof entry.op?.t === 'string' ? entry.op.t : typeof entry.id === 'string' ? entry.id : undefined
  const start = entry.op?.p
  const text = entry.op?.c
  if (!threadId || typeof start !== 'number' || typeof text !== 'string') return undefined
  return {
    threadId,
    docId,
    start,
    end: start + text.length,
    quotedText: text,
    ...(typeof entry.resolved === 'boolean' ? { resolved: entry.resolved } : {}),
  }
}

function rangesFromDocument(document: JoinedDocument): LocatedRange[] {
  if (document.protocol === 'history-ot') {
    const snapshot = document.rawSnapshot as HistorySnapshot
    return (snapshot.comments ?? []).flatMap(comment => {
      const range = comment.ranges[0]
      if (!range) return []
      const start = snapshotToVisibleOffset(snapshot, range.pos)
      const end = snapshotToVisibleOffset(snapshot, range.pos + range.length)
      return [{
        threadId: comment.id,
        docId: document.docId,
        start,
        end,
        quotedText: document.content.slice(start, end),
        ...(comment.resolved === undefined ? {} : { resolved: comment.resolved }),
      }]
    })
  }
  const comments = (document.ranges as { comments?: unknown[] } | undefined)?.comments ?? []
  return comments.flatMap(value => {
    const range = legacyRange(document.docId, value)
    return range ? [range] : []
  })
}

function projectRanges(value: unknown): LocatedRange[] {
  if (!Array.isArray(value)) return []
  const output: LocatedRange[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const entry = item as { id?: unknown; ranges?: { comments?: unknown[] } }
    if (typeof entry.id !== 'string') continue
    for (const comment of entry.ranges?.comments ?? []) {
      const range = legacyRange(entry.id, comment)
      if (range) output.push(range)
    }
  }
  return output
}

function authorMatches(thread: ThreadData, filter: string): boolean {
  const needle = filter.toLocaleLowerCase()
  return (thread.messages ?? []).some(message => {
    const values = [message.user_id, message.user?.id, message.user?.name, message.user?.email]
    return values.some(value => value?.toLocaleLowerCase().includes(needle))
  })
}

async function leaveQuietly(connection: CommentConnection, docId: string): Promise<void> {
  try {
    await connection.leaveDocument(docId)
  } catch {
    // A subsequent connection refresh will clean up the room.
  }
}

function attachment(document: JoinedDocument, threadId: string): LocatedRange | undefined {
  return rangesFromDocument(document).find(range => range.threadId === threadId)
}

/**
 * Combines REST thread messages with OT-backed ranges and status metadata.
 * Mutations verify the resulting thread or document state before reporting success.
 */
export class CommentsApi {
  readonly #http: CommentHttp
  readonly #connections: CommentConnections
  readonly #currentUserId: string | undefined
  readonly #maxUpdateChars: number
  readonly #threadIdFactory: () => string
  readonly #now: () => number
  readonly #recoveryTimeoutMs: number
  readonly #recoveryPollIntervalMs: number
  readonly #policy: AccessPolicy

  constructor(http: CommentHttp, connections: CommentConnections, options: CommentsApiOptions = {}) {
    this.#http = http
    this.#connections = connections
    this.#currentUserId = options.currentUserId
    this.#maxUpdateChars = options.maxUpdateChars ?? 7 * 1024 * 1024
    this.#threadIdFactory = options.threadIdFactory ?? generateThreadId
    this.#now = options.now ?? Date.now
    this.#recoveryTimeoutMs = options.recoveryTimeoutMs ?? 30_000
    this.#recoveryPollIntervalMs = options.recoveryPollIntervalMs ?? 250
    this.#policy = options.policy ?? AccessPolicy.permissive
  }

  async getThreads(projectId: string): Promise<ThreadsResponse> {
    this.#policy.assertProject(projectId)
    this.#policy.assertEffect('overleaf-read')
    return await this.#http.getJson(`/project/${encodeURIComponent(projectId)}/threads`) as ThreadsResponse
  }

  async listComments(
    projectId: string,
    options: { filePath?: string; status?: 'open' | 'resolved' | 'all'; author?: string } = {}
  ): Promise<{ threads: ListedComment[]; positionsUnavailable: boolean }> {
    this.#policy.assertProject(projectId)
    const threads = await this.getThreads(projectId)
    const status = options.status ?? 'open'
    const filtered = Object.entries(threads).filter(([, thread]) => {
      const resolved = thread.resolved === true
      if (status === 'open' && resolved) return false
      if (status === 'resolved' && !resolved) return false
      return options.author ? authorMatches(thread, options.author) : true
    })

    let indexedRanges: LocatedRange[] = []
    let positionsUnavailable = false
    if (!options.filePath) {
      // The project index selects relevant documents; its absence must never trigger a join-all scan.
      try {
        indexedRanges = projectRanges(
          await this.#http.getJson(`/project/${encodeURIComponent(projectId)}/ranges`)
        )
      } catch (error) {
        if (
          error instanceof McpError &&
          ['NOT_FOUND', 'REMOTE_ERROR', 'PROTOCOL_UNSUPPORTED'].includes(error.code)
        ) {
          positionsUnavailable = true
        } else {
          throw error
        }
      }
    }

    if (positionsUnavailable) {
      return {
        positionsUnavailable: true,
        threads: filtered.map(([id, thread]) => ({
          ...thread,
          id,
          status: thread.resolved === true ? 'resolved' : 'open',
          unlocated: true,
        })),
      }
    }

    return await this.#connections.withConnection(projectId, async connection =>
      await connection.queue.run(async () => {
        const tree = connection.getTree()
        const documentsById = new Map<string, JoinedDocument>()
        if (options.filePath) {
          const entity = resolveProjectPath(tree, options.filePath, 'doc')
          const document = await connection.joinDocument(entity.id)
          indexedRanges = rangesFromDocument(document)
          documentsById.set(entity.id, document)
          await leaveQuietly(connection, entity.id)
        }

        const filteredIds = new Set(filtered.map(([id]) => id))
        const documentIds = [...new Set(
          indexedRanges
            .filter(range => filteredIds.has(range.threadId))
            .map(range => range.docId)
        )]
        const liveByThread = new Map<string, { range: LocatedRange; document: JoinedDocument }>()
        for (const docId of documentIds) {
          const cached = documentsById.get(docId)
          const document = cached ?? await connection.joinDocument(docId)
          for (const range of rangesFromDocument(document)) {
            if (filteredIds.has(range.threadId)) liveByThread.set(range.threadId, { range, document })
          }
          if (!cached) await leaveQuietly(connection, docId)
        }

        const pathById = new Map(tree.map(entity => [entity.id, entity.path]))
        const listed: ListedComment[] = []
        for (const [id, thread] of filtered) {
          const live = liveByThread.get(id)
          const fallback = indexedRanges.find(range => range.threadId === id)
          const range = live?.range ?? fallback
          if (options.filePath && range?.docId !== resolveProjectPath(tree, options.filePath, 'doc').id) {
            continue
          }
          if (!range || !live) {
            listed.push({
              ...thread,
              id,
              status: thread.resolved === true ? 'resolved' : 'open',
              unlocated: true,
            })
            continue
          }
          const start = range.start
          const end = range.end
          listed.push({
            ...thread,
            id,
            status: thread.resolved === true ? 'resolved' : 'open',
            ...(pathById.get(range.docId) === undefined
              ? {}
              : { filePath: pathById.get(range.docId)! }),
            start: offsetToLineColumn(live.document.content, start),
            end: offsetToLineColumn(live.document.content, end),
            quotedText: live.document.content.slice(start, end),
          })
        }
        return { threads: listed, positionsUnavailable: false }
      })
    )
  }

  async replyToComment(
    projectId: string,
    threadId: string,
    content: string
  ): Promise<{
    threadId: string
    thread: ThreadData
    trackChangesActive: boolean
    writeMode: 'untracked'
    recoveredAfterTimeout?: boolean
  }> {
    this.#policy.assertProject(projectId)
    assertPathSafeId(threadId, 'threadId')
    this.#policy.assertEffect('overleaf-write')
    const normalized = normalizeLf(content)
    const started = this.#now()
    try {
      await this.#http.postJson(`/project/${encodeURIComponent(projectId)}/thread/${encodeURIComponent(threadId)}/messages`, {
        content: normalized,
      })
    } catch (error) {
      if (!(error instanceof McpError) || !['TIMEOUT', 'OUTCOME_UNKNOWN'].includes(error.code)) {
        throw error
      }
      const thread = (await this.getThreads(projectId))[threadId]
      // A timed-out POST is accepted only when author, content, and request window identify one reply.
      const matched = thread?.messages?.some(message => {
        const timestamp = new Date(message.timestamp ?? 0).getTime()
        return (
          this.#currentUserId !== undefined &&
          message.user_id === this.#currentUserId &&
          message.content === normalized &&
          timestamp >= started - 1_000 &&
          timestamp <= this.#now() + 60_000
        )
      })
      if (thread && matched) {
        const disclosure = await this.#mutationDisclosure(projectId)
        return { threadId, thread, ...disclosure, recoveredAfterTimeout: true }
      }
      throw new McpError(
        'OUTCOME_UNKNOWN',
        'The reply request timed out and no uniquely matching message could be confirmed. Do not retry blindly.',
        { details: { threadId } }
      )
    }
    const thread = (await this.getThreads(projectId))[threadId]
    if (!thread) throw new McpError('OUTCOME_UNKNOWN', 'Reply succeeded but the thread could not be refreshed.')
    return { threadId, thread, ...await this.#mutationDisclosure(projectId) }
  }

  async #mutationDisclosure(projectId: string): Promise<{
    trackChangesActive: boolean
    writeMode: 'untracked'
  }> {
    return await this.#connections.withConnection(projectId, connection =>
      Promise.resolve({
        trackChangesActive: connection.trackChangesActive,
        writeMode: 'untracked',
      })
    )
  }

  async addComment(input: AddCommentInput): Promise<{
    threadId: string
    thread?: ThreadData
    revision: string
    protocol: OtProtocol
    trackChangesActive: boolean
    writeMode: 'untracked'
    recoveredAfterTimeout?: boolean
  }> {
    this.#policy.assertProject(input.projectId)
    this.#policy.assertEffect('overleaf-write')
    const expectedText = normalizeLf(input.expectedText)
    const messageContent = normalizeLf(input.content)
    const threadId = this.#threadIdFactory()
    assertPathSafeId(threadId, 'threadId')
    const project = encodeURIComponent(input.projectId)

    const submit = await this.#connections.withConnection(input.projectId, async connection =>
      await connection.queue.run(async () => {
        const entity = resolveProjectPath(connection.getTree(), input.filePath, 'doc')
        const before = await connection.joinDocument(entity.id)
        assertRevisionMatches(input.revision, {
          projectId: input.projectId,
          docId: entity.id,
          protocol: before.protocol,
          otVersion: before.version,
          content: before.content,
        })
        const visibleStart = lineColumnToOffset(before.content, input.start)
        const visibleEnd = lineColumnToOffset(before.content, input.end)
        if (visibleEnd <= visibleStart) {
          throw new McpError('INVALID_ARGUMENT', 'Comment range must not be empty.')
        }
        if (before.content.slice(visibleStart, visibleEnd) !== expectedText) {
          throw new McpError('REVISION_CONFLICT', 'expectedText does not match the live selection.')
        }

        // Overleaf creates the REST thread first; a separate OT update anchors it to the document.
        try {
          await this.#http.postJson(
            `/project/${project}/thread/${encodeURIComponent(threadId)}/messages`,
            { content: messageContent }
          )
        } catch (error) {
          if (!(error instanceof McpError) || !['TIMEOUT', 'OUTCOME_UNKNOWN'].includes(error.code)) {
            throw asMcpError(error)
          }
          const thread = (await this.getThreads(input.projectId))[threadId]
          const created = thread?.messages?.some(message => message.content === messageContent)
          if (!created) {
            throw new McpError('OUTCOME_UNKNOWN', 'Could not confirm creation of the comment thread.', {
              details: { threadId },
            })
          }
        }

        let start = visibleStart
        let end = visibleEnd
        if (before.protocol === 'history-ot') {
          const snapshot = before.rawSnapshot as HistorySnapshot
          start = visibleToSnapshotOffset(snapshot, visibleStart)
          end = visibleToSnapshotOffset(snapshot, visibleEnd)
        }
        const operation = buildCommentOperation(
          before.protocol,
          threadId,
          start,
          end,
          expectedText
        )
        const update = makeUpdate(entity.id, before.version, operation, before.protocol)
        assertUpdateSize(update, this.#maxUpdateChars)
        let submitError: unknown
        try {
          await connection.submitUpdate(entity.id, update)
        } catch (error) {
          submitError = error
        }
        await leaveQuietly(connection, entity.id)
        if (submitError instanceof McpError && submitError.code === 'TIMEOUT') {
          return {
            entity,
            before,
            visibleStart,
            visibleEnd,
            trackChangesActive: connection.trackChangesActive,
            submitError,
          }
        }
        if (submitError) {
          // A definite OT failure proves no attachment applied, so deleting the orphan is safe.
          try {
            await this.#http.deleteJson(
              `/project/${project}/doc/${encodeURIComponent(entity.id)}/thread/${encodeURIComponent(threadId)}`
            )
          } catch (cleanupError) {
            throw new McpError('PARTIAL_CLEANUP', 'Comment attachment failed and orphan cleanup also failed.', {
              cause: cleanupError,
              details: { threadId },
            })
          }
          throw asMcpError(submitError)
        }
        const live = await connection.joinDocument(entity.id)
        await leaveQuietly(connection, entity.id)
        return {
          entity,
          before,
          visibleStart,
          visibleEnd,
          live,
          trackChangesActive: connection.trackChangesActive,
        }
      })
    )

    let live = submit.live
    let recoveredAfterTimeout = false
    if (!live) {
      // An ambiguous attachment is recovered by observing the generated thread ID and exact range.
      await this.#connections.invalidate(input.projectId)
      const deadline = Date.now() + this.#recoveryTimeoutMs
      let observationError: unknown
      do {
        try {
          live = await this.#connections.withConnection(input.projectId, async connection =>
            await connection.queue.run(async () => {
              const entity = resolveProjectPath(connection.getTree(), input.filePath, 'doc')
              const document = await connection.joinDocument(entity.id)
              await leaveQuietly(connection, entity.id)
              return document
            })
          )
          observationError = undefined
          const range = attachment(live, threadId)
          if (range?.start === submit.visibleStart && range.end === submit.visibleEnd) break
          const unchanged =
            live.protocol === submit.before.protocol &&
            live.version === submit.before.version &&
            contentHash(live.content) === contentHash(submit.before.content)
          if (!unchanged) {
            throw new McpError(
              'OUTCOME_UNKNOWN',
              'The document changed while the timed-out comment attachment remained unconfirmed.',
              { details: { threadId } }
            )
          }
        } catch (error) {
          if (error instanceof McpError && error.code === 'OUTCOME_UNKNOWN') throw error
          live = undefined
          observationError = error
        }
        if (Date.now() >= deadline) break
        await new Promise<void>(resolve => setTimeout(resolve, this.#recoveryPollIntervalMs))
      } while (Date.now() <= deadline)
      if (!live) {
        throw new McpError('OUTCOME_UNKNOWN', 'Could not verify comment attachment after timeout.', {
          cause: observationError,
          details: { threadId },
        })
      }
      recoveredAfterTimeout = true
    }

    const verifiedRange = attachment(live, threadId)
    if (
      verifiedRange?.start !== submit.visibleStart ||
      verifiedRange.end !== submit.visibleEnd
    ) {
      const unchanged =
        live.protocol === submit.before.protocol &&
        live.version === submit.before.version &&
        contentHash(live.content) === contentHash(submit.before.content)
      if (!recoveredAfterTimeout || !unchanged) {
        throw new McpError(
          'OUTCOME_UNKNOWN',
          'The comment thread exists but its exact range could not be verified.',
          { details: { threadId } }
        )
      }
      // Cleanup is permitted only after the unchanged document proves the range was not attached.
      try {
        await this.#http.deleteJson(
          `/project/${project}/doc/${encodeURIComponent(submit.entity.id)}/thread/${encodeURIComponent(threadId)}`
        )
      } catch (error) {
        throw new McpError('PARTIAL_CLEANUP', 'The comment range is absent and orphan cleanup failed.', {
          cause: error,
          details: { threadId },
        })
      }
      throw new McpError('TIMEOUT', 'The comment range attachment was not applied.', {
        details: { threadId, outcome: 'not_applied' },
      })
    }

    const thread = (await this.getThreads(input.projectId))[threadId]
    return {
      threadId,
      ...(thread === undefined ? {} : { thread }),
      revision: createRevision({
        projectId: input.projectId,
        docId: live.docId,
        protocol: live.protocol,
        otVersion: live.version,
        content: live.content,
      }),
      protocol: live.protocol,
      trackChangesActive: submit.trackChangesActive,
      writeMode: 'untracked',
      ...(recoveredAfterTimeout ? { recoveredAfterTimeout: true } : {}),
    }
  }

  async setCommentStatus(input: {
    projectId: string
    filePath: string
    revision: string
    threadId: string
    status: 'open' | 'resolved'
  }): Promise<{
    threadId: string
    status: 'open' | 'resolved'
    revision: string
    trackChangesActive: boolean
    writeMode: 'untracked'
    recoveredAfterTimeout?: boolean
  }> {
    this.#policy.assertProject(input.projectId)
    assertPathSafeId(input.threadId, 'threadId')
    this.#policy.assertEffect('overleaf-write')
    const resolved = input.status === 'resolved'
    const submission = await this.#connections.withConnection(input.projectId, async connection =>
      await connection.queue.run(async () => {
        const entity = resolveProjectPath(connection.getTree(), input.filePath, 'doc')
        const before = await connection.joinDocument(entity.id)
        assertRevisionMatches(input.revision, {
          projectId: input.projectId,
          docId: entity.id,
          protocol: before.protocol,
          otVersion: before.version,
          content: before.content,
        })
        let submitError: unknown
        try {
          // History-OT stores status in its snapshot; ShareJS exposes dedicated REST actions.
          if (before.protocol === 'history-ot') {
            const update = makeUpdate(
              entity.id,
              before.version,
              buildStatusOperation(before.protocol, input.threadId, resolved),
              before.protocol
            )
            assertUpdateSize(update, this.#maxUpdateChars)
            await connection.submitUpdate(entity.id, update)
          } else {
            await this.#http.postJson(
              `/project/${encodeURIComponent(input.projectId)}/doc/${encodeURIComponent(entity.id)}/thread/${encodeURIComponent(input.threadId)}/${resolved ? 'resolve' : 'reopen'}`,
              {}
            )
          }
        } catch (error) {
          submitError = error
        }
        await leaveQuietly(connection, entity.id)
        if (
          submitError instanceof McpError &&
          ['TIMEOUT', 'OUTCOME_UNKNOWN'].includes(submitError.code)
        ) {
          return {
            before,
            entity,
            trackChangesActive: connection.trackChangesActive,
            submitError,
          }
        }
        if (submitError) throw asMcpError(submitError)
        const live = await connection.joinDocument(entity.id)
        await leaveQuietly(connection, entity.id)
        return { before, entity, live, trackChangesActive: connection.trackChangesActive }
      })
    )

    let live = submission.live
    let recoveredAfterTimeout = false
    if (!live) {
      await this.#connections.invalidate(input.projectId)
      const deadline = Date.now() + this.#recoveryTimeoutMs
      let observedUnapplied = false
      let observationError: unknown
      do {
        try {
          live = await this.#connections.withConnection(input.projectId, async connection =>
            await connection.queue.run(async () => {
              const entity = resolveProjectPath(connection.getTree(), input.filePath, 'doc')
              const document = await connection.joinDocument(entity.id)
              await leaveQuietly(connection, entity.id)
              return document
            })
          )
          observationError = undefined
          if (live.protocol !== submission.before.protocol) {
            throw new McpError(
              'PROTOCOL_UNSUPPORTED',
              'Document protocol changed during comment-status recovery.'
            )
          }
          if (await this.#statusMatches(input.projectId, live, input.threadId, resolved)) break
          observedUnapplied = true
        } catch (error) {
          if (error instanceof McpError && error.code === 'PROTOCOL_UNSUPPORTED') throw error
          live = undefined
          observationError = error
        }
        if (Date.now() >= deadline) break
        await new Promise<void>(resolve => setTimeout(resolve, this.#recoveryPollIntervalMs))
      } while (Date.now() <= deadline)

      if (!live) {
        throw new McpError('OUTCOME_UNKNOWN', 'Could not observe comment status after timeout.', {
          cause: observationError,
          details: { threadId: input.threadId },
        })
      }
      if (!(await this.#statusMatches(input.projectId, live, input.threadId, resolved))) {
        throw new McpError(
          observedUnapplied ? 'TIMEOUT' : 'OUTCOME_UNKNOWN',
          'The comment status request timed out and the requested state is not live.',
          { details: { threadId: input.threadId, outcome: 'not_applied' } }
        )
      }
      recoveredAfterTimeout = true
    } else if (!(await this.#statusMatches(input.projectId, live, input.threadId, resolved))) {
      throw new McpError('OUTCOME_UNKNOWN', 'Could not verify the requested comment status.', {
        details: { threadId: input.threadId },
      })
    }

    return {
      threadId: input.threadId,
      status: input.status,
      revision: createRevision({
        projectId: input.projectId,
        docId: live.docId,
        protocol: live.protocol,
        otVersion: live.version,
        content: live.content,
      }),
      trackChangesActive: submission.trackChangesActive,
      writeMode: 'untracked',
      ...(recoveredAfterTimeout ? { recoveredAfterTimeout: true } : {}),
    }
  }

  async #statusMatches(
    projectId: string,
    document: JoinedDocument,
    threadId: string,
    resolved: boolean
  ): Promise<boolean> {
    const range = attachment(document, threadId)
    if (range?.resolved !== undefined) return range.resolved === resolved
    const thread = (await this.getThreads(projectId))[threadId]
    return thread !== undefined && (thread.resolved === true) === resolved
  }
}
