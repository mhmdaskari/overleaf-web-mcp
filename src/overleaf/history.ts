import { z } from 'zod'

import { McpError } from '../core/errors.js'
import { AccessPolicy, assertPathSafeId } from '../core/policy.js'
import { normalizeLf } from '../core/text.js'
import type { ReadFileResult } from './documents.js'
import { isUnconfirmedWriteError } from './recovery.js'
import { normalizeProjectPath } from './tree.js'

export interface HistoryJsonGetter {
  getJson(path: string): Promise<unknown>
}

/** A reader alone serves monitor_project_history; the history writes also need `postJson`. */
export interface HistoryHttp extends HistoryJsonGetter {
  postJson?(path: string, body?: unknown): Promise<unknown>
}

/** What restoring a file reads besides history: the live tree and the restored document. */
export interface HistoryFiles {
  /** Every entity's id, path, and type, from a fresh join. */
  listEntities(projectId: string): Promise<ReadonlyArray<{ id: string; path: string; type: string }>>
  /** Reads a document as read_file does, from a fresh join. */
  readFile(projectId: string, filePath: string): Promise<ReadFileResult>
}

/** The longest label comment accepted. */
export const MAX_LABEL_COMMENT_LENGTH = 1_000

/** A version named directly, or through the label that marks it. */
export type VersionSelector = { version: number; labelId?: undefined } | { labelId: string; version?: undefined }

export interface CreatedLabel {
  action: 'create_label'
  label: { id: string; comment: string; version: number; createdAt: string }
  verified: boolean
  recoveredAfterTimeout?: true
}

export interface FileVersion {
  filePath: string
  version: number
  content: string
  newline: 'LF'
}

export interface RestoredFile {
  action: 'restore_file'
  filePath: string
  version: number
  docId: string
  previousDocId: string | null
  revision: string
  protocol: ReadFileResult['protocol']
  trackChangesActive: boolean
  contentMatches: boolean
  recoveredAfterTimeout?: true
}

export interface HistoryAuthor {
  id: string
  displayName: string
}

export type HistoryProjectOperation =
  | { type: 'add'; atVersion: number; path: string }
  | { type: 'rename'; atVersion: number; path: string; newPath: string }
  | { type: 'remove'; atVersion: number; path: string }

export interface HistoryLabel {
  id: string
  comment: string
  version: number
  createdAt: string
  userId: string | null
  userDisplayName: string | null
}

export interface HistoryOrigin {
  kind: string
  path?: string
  timestamp?: string
  version?: number
}

export interface ProjectHistoryUpdate {
  fromVersion: number
  toVersion: number
  startedAt: string
  endedAt: string
  authors: Array<HistoryAuthor | null>
  paths: string[]
  projectOperations: HistoryProjectOperation[]
  labels: HistoryLabel[]
  origin: HistoryOrigin | null
}

export interface ProjectHistoryMonitorResult {
  projectId: string
  currentVersion: number | null
  nextSinceVersion: number | null
  hasEarlierHistory: boolean
  gapDetected: boolean
  updates: ProjectHistoryUpdate[]
}

const userSchema = z.object({
  id: z.string(),
  first_name: z.string(),
  last_name: z.string(),
  email: z.string(),
})

const originSchema = z.object({
  kind: z.string(),
  path: z.string().optional(),
  // A milliseconds count, or for a file restore an ISO string (RestoreManager.revertFile).
  timestamp: z.union([z.number().finite(), z.string()]).optional(),
  version: z.number().int().nonnegative().optional(),
})

const metaSchema = z.object({
  users: z.array(userSchema.nullable()),
  start_ts: z.number().finite(),
  end_ts: z.number().finite(),
  origin: originSchema.optional(),
  source: z.string().optional(),
  type: z.string().optional(),
})

const labelSchema = z.object({
  id: z.string(),
  comment: z.string(),
  version: z.number().int().nonnegative(),
  created_at: z.string(),
  user_id: z.string().nullable().optional(),
  user_display_name: z.string().nullable().optional(),
})

const projectOperationSchema = z.union([
  z
    .object({
      atV: z.number().int().nonnegative(),
      add: z.object({ pathname: z.string() }),
    })
    .strict(),
  z
    .object({
      atV: z.number().int().nonnegative(),
      rename: z.object({ pathname: z.string(), newPathname: z.string() }),
    })
    .strict(),
  z
    .object({
      atV: z.number().int().nonnegative(),
      remove: z.object({ pathname: z.string() }),
    })
    .strict(),
])

const updateSchema = z.object({
  fromV: z.number().int().nonnegative(),
  toV: z.number().int().nonnegative(),
  meta: metaSchema,
  labels: z.array(labelSchema),
  pathnames: z.array(z.string()),
  project_ops: z.array(projectOperationSchema),
})

const responseSchema = z.object({
  updates: z.array(updateSchema),
  nextBeforeTimestamp: z.number().finite().optional(),
})

const labelListSchema = z.array(labelSchema)

const createdLabelSchema = labelSchema.pick({ id: true, comment: true, version: true, created_at: true })

const diffSchema = z.object({
  diff: z.union([
    z.object({ binary: z.literal(true) }),
    z.array(z.object({ u: z.string().optional(), i: z.string().optional(), d: z.string().optional() })),
  ]),
})

const restoreSchema = z.object({ type: z.enum(['doc', 'file']), id: z.string() })

const fileTreeSchema = z.object({
  diff: z.array(z.object({ pathname: z.string(), editable: z.boolean().optional(), operation: z.string().optional() })),
})

function unsupported(message: string, cause: unknown): McpError {
  return new McpError('PROTOCOL_UNSUPPORTED', message, { cause })
}

function isoTimestamp(value: number | string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) throw new TypeError('Invalid history timestamp.')
  return date.toISOString()
}

function normalizeProjectOperation(operation: z.infer<typeof projectOperationSchema>): HistoryProjectOperation {
  if ('add' in operation) {
    return { type: 'add', atVersion: operation.atV, path: operation.add.pathname }
  }
  if ('rename' in operation) {
    return {
      type: 'rename',
      atVersion: operation.atV,
      path: operation.rename.pathname,
      newPath: operation.rename.newPathname,
    }
  }
  return { type: 'remove', atVersion: operation.atV, path: operation.remove.pathname }
}

function normalizeOrigin(meta: z.infer<typeof metaSchema>): HistoryOrigin | null {
  if (meta.origin !== undefined) {
    return {
      kind: meta.origin.kind,
      ...(meta.origin.path === undefined ? {} : { path: meta.origin.path }),
      ...(meta.origin.timestamp === undefined ? {} : { timestamp: isoTimestamp(meta.origin.timestamp) }),
      ...(meta.origin.version === undefined ? {} : { version: meta.origin.version }),
    }
  }
  if (meta.source !== undefined) return { kind: meta.source }
  if (meta.type !== undefined) return { kind: meta.type }
  return null
}

function normalizeUpdate(update: z.infer<typeof updateSchema>): ProjectHistoryUpdate {
  if (update.toV < update.fromV) throw new TypeError('Invalid history version range.')
  return {
    fromVersion: update.fromV,
    toVersion: update.toV,
    startedAt: isoTimestamp(update.meta.start_ts),
    endedAt: isoTimestamp(update.meta.end_ts),
    authors: update.meta.users.map(user =>
      user === null
        ? null
        : {
            id: user.id,
            displayName: `${user.first_name} ${user.last_name}`.trim(),
          }
    ),
    paths: update.pathnames,
    projectOperations: update.project_ops.map(normalizeProjectOperation),
    labels: update.labels.map(label => ({
      id: label.id,
      comment: label.comment,
      version: label.version,
      createdAt: isoTimestamp(label.created_at),
      userId: label.user_id ?? null,
      userDisplayName: label.user_display_name ?? null,
    })),
    origin: normalizeOrigin(update.meta),
  }
}

function publicLabel(label: z.infer<typeof createdLabelSchema>): CreatedLabel['label'] {
  return { id: label.id, comment: label.comment, version: label.version, createdAt: isoTimestamp(label.created_at) }
}

export class HistoryApi {
  readonly #http: HistoryHttp
  readonly #policy: AccessPolicy
  readonly #files: HistoryFiles | undefined

  constructor(http: HistoryHttp, policy: AccessPolicy = AccessPolicy.permissive, files?: HistoryFiles) {
    this.#http = http
    this.#policy = policy
    this.#files = files
  }

  async monitorProjectHistory(projectId: string, sinceVersion?: number): Promise<ProjectHistoryMonitorResult> {
    this.#policy.assertProject(projectId)
    this.#policy.assertEffect('overleaf-read')
    if (sinceVersion !== undefined && (!Number.isInteger(sinceVersion) || sinceVersion < 0)) {
      throw new McpError('INVALID_ARGUMENT', 'sinceVersion must be a non-negative integer.')
    }

    const path = `/project/${encodeURIComponent(projectId)}/updates?min_count=25`
    const response = await this.#http.getJson(path)
    let parsed: z.infer<typeof responseSchema>
    try {
      parsed = responseSchema.parse(response)
    } catch (error) {
      throw new McpError('PROTOCOL_UNSUPPORTED', 'Overleaf returned an unsupported project history response.', {
        cause: error,
      })
    }

    try {
      const normalized = parsed.updates
        .map(normalizeUpdate)
        .sort((left, right) => right.toVersion - left.toVersion || right.fromVersion - left.fromVersion)
      const currentVersion = normalized.length === 0 ? null : Math.max(...normalized.map(update => update.toVersion))
      if (sinceVersion !== undefined && currentVersion !== null && sinceVersion > currentVersion) {
        throw new McpError(
          'INVALID_ARGUMENT',
          `sinceVersion ${sinceVersion} is newer than project version ${currentVersion}.`
        )
      }
      const hasEarlierHistory = parsed.nextBeforeTimestamp !== undefined
      const oldestReturnedVersion =
        normalized.length === 0 ? null : Math.min(...normalized.map(update => update.fromVersion))

      return {
        projectId,
        currentVersion,
        nextSinceVersion: currentVersion ?? sinceVersion ?? null,
        hasEarlierHistory,
        gapDetected:
          sinceVersion !== undefined &&
          hasEarlierHistory &&
          oldestReturnedVersion !== null &&
          sinceVersion < oldestReturnedVersion,
        updates:
          sinceVersion === undefined
            ? normalized
            : normalized
                .filter(update => update.toVersion > sinceVersion)
                // Overleaf re-merges a group between polls, so one that straddles the cursor
                // still holds operations already reported. An operation at atVersion produced
                // atVersion + 1, so one at the cursor itself is new.
                .map(update => ({
                  ...update,
                  projectOperations: update.projectOperations.filter(operation => operation.atVersion >= sinceVersion),
                })),
      }
    } catch (error) {
      if (error instanceof McpError) throw error
      throw new McpError('PROTOCOL_UNSUPPORTED', 'Overleaf returned invalid project history values.', { cause: error })
    }
  }

  /**
   * Labels the project's current version, read just before the write. A lost answer is observed
   * through the label list, never resent: the one new label with this comment and version is it.
   */
  async createLabel(projectId: string, comment: string): Promise<CreatedLabel> {
    this.#policy.assertProject(projectId)
    this.#policy.assertEffect('overleaf-read', 'overleaf-write')
    if (comment.trim() === '' || comment.length > MAX_LABEL_COMMENT_LENGTH) {
      throw new McpError('INVALID_ARGUMENT', `comment must hold text, at most ${MAX_LABEL_COMMENT_LENGTH} characters.`)
    }
    const version = await this.#currentVersion(projectId)
    const before = new Set((await this.#labels(projectId)).map(label => label.id))
    const readBack = async (): Promise<Array<z.infer<typeof labelSchema>>> => {
      try {
        return await this.#labels(projectId)
      } catch (error) {
        throw new McpError(
          'OUTCOME_UNKNOWN',
          'The label was sent but the labels could not be read back to confirm it. Do not retry; list the history first.',
          { cause: error, details: { version, outcome: 'unknown' } }
        )
      }
    }
    let created: z.infer<typeof createdLabelSchema>
    try {
      const response = await this.#post(`/project/${encodeURIComponent(projectId)}/labels`, {
        comment,
        version,
      })
      created = createdLabelSchema.parse(response)
    } catch (error) {
      // An answer in an unknown shape leaves the label's fate unknown, as a lost one does.
      if (!isUnconfirmedWriteError(error) && !(error instanceof z.ZodError)) throw error
      const matches = (await readBack()).filter(
        label => !before.has(label.id) && label.comment === comment && label.version === version
      )
      if (matches.length !== 1) {
        throw new McpError(
          'OUTCOME_UNKNOWN',
          'The label request was not answered and no single new label could be confirmed. Do not retry; list the history first.',
          { details: { version, outcome: 'unknown' } }
        )
      }
      return { action: 'create_label', label: publicLabel(matches[0]!), verified: true, recoveredAfterTimeout: true }
    }
    const verified = (await readBack()).some(label => label.id === created.id)
    return { action: 'create_label', label: publicLabel(created), verified }
  }

  /** The text a document held at a version, from Overleaf's history. */
  async readFileVersion(projectId: string, filePath: string, selector: VersionSelector): Promise<FileVersion> {
    this.#policy.assertProject(projectId)
    this.#policy.assertEffect('overleaf-read')
    const path = normalizeProjectPath(filePath)
    const version = await this.#resolveVersion(projectId, selector)
    const content = await this.#textAtVersion(projectId, path, version)
    return { filePath: path, version, content, newline: 'LF' }
  }

  /**
   * Puts a document back as it was at a version. Overleaf deletes the live file and creates a new
   * document with the old text, its tracked changes, and its comments, so the document gets a new
   * id and every revision of the old one stops working. A lost or failed answer is observed,
   * never resent.
   */
  async restoreFile(
    projectId: string,
    filePath: string,
    selector: VersionSelector,
    confirmPath: string | undefined
  ): Promise<RestoredFile> {
    this.#policy.assertProject(projectId)
    this.#policy.assertEffect('overleaf-read', 'overleaf-write', 'overleaf-delete')
    const files = this.#files
    if (files === undefined) throw new McpError('PROTOCOL_UNSUPPORTED', 'This backend cannot restore files.')
    if (confirmPath !== filePath) {
      throw new McpError(
        'CONFIRMATION_MISMATCH',
        'confirmPath must exactly match filePath before a file is restored.',
        {
          details: { filePath },
        }
      )
    }
    const path = normalizeProjectPath(filePath)
    const version = await this.#resolveVersion(projectId, selector)
    // Read first: it refuses a path the version did not have, or a binary file, before anything is sent.
    const expected = await this.#textAtVersion(projectId, path, version)
    const live = (await files.listEntities(projectId)).find(entity => entity.path === path)
    if (live !== undefined && live.type !== 'doc' && live.type !== 'file') {
      throw new McpError('INVALID_ARGUMENT', `${path} is a ${live.type}, not a file.`, { details: { filePath: path } })
    }
    const previousDocId = live?.id ?? null
    const details = { filePath: path, version }

    const observe = async (): Promise<{ id: string; read: ReadFileResult } | undefined> => {
      const entity = (await files.listEntities(projectId)).find(item => item.path === path)
      if (entity === undefined || entity.type !== 'doc' || entity.id === previousDocId) return undefined
      return { id: entity.id, read: await files.readFile(projectId, path) }
    }

    let restoredId: string
    let recoveredAfterTimeout = false
    try {
      const response = await this.#post(`/project/${encodeURIComponent(projectId)}/revert_file`, {
        version,
        pathname: path,
      })
      const parsed = restoreSchema.safeParse(response)
      restoredId = parsed.success ? parsed.data.id : ''
    } catch (error) {
      const refused =
        error instanceof McpError &&
        (error.code === 'PERMISSION_DENIED' ||
          error.code === 'NOT_FOUND' ||
          error.code === 'AUTH_EXPIRED' ||
          error.code === 'RATE_LIMITED' ||
          error.code === 'POLICY_DENIED' ||
          (error.code === 'REMOTE_ERROR' &&
            typeof error.details?.status === 'number' &&
            error.details.status >= 300 &&
            error.details.status < 500))
      // Overleaf refused before acting: nothing changed.
      if (refused) throw error
      // Overleaf deletes the live file before it creates the restored one, so a failure can leave either.
      let seen: Awaited<ReturnType<typeof observe>>
      let present: boolean
      try {
        seen = await observe()
        present = (await files.listEntities(projectId)).some(entity => entity.path === path)
      } catch (observeError) {
        throw new McpError(
          'OUTCOME_UNKNOWN',
          'The restore was sent but the project could not be read back. Do not retry; read the project tree first.',
          { cause: observeError, details: { ...details, outcome: 'unknown' } }
        )
      }
      if (seen === undefined) {
        // Only an error Overleaf answered with has finished: after a lost answer it may still act.
        const answered = error instanceof McpError && typeof error.details?.status === 'number'
        if (answered && (present || previousDocId === null)) {
          throw new McpError(
            'REMOTE_ERROR',
            'Overleaf failed the restore, and the file is unchanged. Read it before deciding to restore again.',
            { retryable: false, details: { ...details, outcome: 'not_applied' } }
          )
        }
        if (present || previousDocId === null) {
          throw new McpError(
            'OUTCOME_UNKNOWN',
            'The restore was not answered, and has not applied yet, but Overleaf may still apply it. Do not retry; read the project tree first.',
            { cause: error, details: { ...details, outcome: 'unknown' } }
          )
        }
        throw new McpError(
          'OUTCOME_UNKNOWN',
          'The restore was not answered, and nothing is at filePath now: Overleaf removes the file before it restores it. Do not retry; read the project tree first.',
          { details: { ...details, outcome: 'unknown' } }
        )
      }
      restoredId = seen.id
      recoveredAfterTimeout = true
    }

    let seen: Awaited<ReturnType<typeof observe>>
    try {
      seen = await observe()
    } catch (error) {
      throw new McpError(
        'OUTCOME_UNKNOWN',
        'Overleaf restored the file but it could not be read back. Do not retry; read it with read_file.',
        { cause: error, details: { ...details, outcome: 'unknown' } }
      )
    }
    if (seen === undefined || (restoredId !== '' && seen.id !== restoredId)) {
      throw new McpError(
        'OUTCOME_UNKNOWN',
        'Overleaf answered the restore, but no new document is at filePath. Do not retry; read the project tree first.',
        { details: { ...details, outcome: 'unknown' } }
      )
    }
    return {
      action: 'restore_file',
      filePath: path,
      version,
      docId: seen.id,
      previousDocId,
      revision: seen.read.revision,
      protocol: seen.read.protocol,
      trackChangesActive: seen.read.trackChangesActive,
      contentMatches: seen.read.content === expected,
      ...(recoveredAfterTimeout ? { recoveredAfterTimeout: true as const } : {}),
    }
  }

  async #post(path: string, body: unknown): Promise<unknown> {
    if (this.#http.postJson === undefined)
      throw new McpError('PROTOCOL_UNSUPPORTED', 'This backend cannot write history.')
    return await this.#http.postJson(path, body)
  }

  async #labels(projectId: string): Promise<Array<z.infer<typeof labelSchema>>> {
    const response = await this.#http.getJson(`/project/${encodeURIComponent(projectId)}/labels`)
    try {
      return labelListSchema.parse(response)
    } catch (error) {
      throw unsupported('Overleaf returned an unsupported label list.', error)
    }
  }

  async #currentVersion(projectId: string): Promise<number> {
    const response = await this.#http.getJson(`/project/${encodeURIComponent(projectId)}/updates?min_count=1`)
    let parsed: z.infer<typeof responseSchema>
    try {
      parsed = responseSchema.parse(response)
    } catch (error) {
      throw unsupported('Overleaf returned an unsupported project history response.', error)
    }
    if (parsed.updates.length === 0) {
      throw new McpError('INVALID_ARGUMENT', 'The project has no history yet, so there is no version to label.', {
        details: { kind: 'no_history' },
      })
    }
    return Math.max(...parsed.updates.map(update => update.toV))
  }

  async #resolveVersion(projectId: string, selector: VersionSelector): Promise<number> {
    if (selector.labelId === undefined) {
      if (!Number.isInteger(selector.version) || selector.version < 0) {
        throw new McpError('INVALID_ARGUMENT', 'version must be a non-negative integer.')
      }
      return selector.version
    }
    assertPathSafeId(selector.labelId, 'labelId')
    const label = (await this.#labels(projectId)).find(item => item.id === selector.labelId)
    if (label === undefined) {
      throw new McpError('NOT_FOUND', 'No history label has this labelId.', { details: { labelId: selector.labelId } })
    }
    return label.version
  }

  /**
   * The text of a document at a version. Overleaf answers a version past the current one, or a
   * path the version lacks, with HTTP 500, so both are checked first: the current version, then
   * the file list at that version.
   */
  async #textAtVersion(projectId: string, filePath: string, version: number): Promise<string> {
    const current = await this.#currentVersion(projectId)
    if (version > current) {
      throw new McpError('INVALID_ARGUMENT', `Version ${version} is newer than the project's version ${current}.`, {
        details: { kind: 'version_ahead', version, currentVersion: current },
      })
    }
    const range = new URLSearchParams({ from: String(version), to: String(version) })
    let listed: z.infer<typeof fileTreeSchema>
    try {
      listed = fileTreeSchema.parse(
        await this.#http.getJson(`/project/${encodeURIComponent(projectId)}/filetree/diff?${range.toString()}`)
      )
    } catch (error) {
      if (error instanceof McpError) throw error
      throw unsupported('Overleaf returned an unsupported history file list.', error)
    }
    const file = listed.diff.find(entry => entry.pathname === filePath && entry.operation !== 'removed')
    if (file === undefined) {
      throw new McpError('NOT_FOUND', `${filePath} was not in the project at version ${version}.`, {
        details: { filePath, version },
      })
    }
    if (file.editable === false) {
      throw new McpError(
        'INVALID_ARGUMENT',
        `${filePath} was a binary file at version ${version}, not a text document.`,
        {
          details: { kind: 'binary_file', filePath, version },
        }
      )
    }
    const query = new URLSearchParams({ pathname: filePath, from: String(version), to: String(version) })
    const response = await this.#http.getJson(`/project/${encodeURIComponent(projectId)}/diff?${query.toString()}`)
    let parsed: z.infer<typeof diffSchema>
    try {
      parsed = diffSchema.parse(response)
    } catch (error) {
      throw unsupported('Overleaf returned an unsupported history diff.', error)
    }
    if (!Array.isArray(parsed.diff)) {
      throw new McpError(
        'INVALID_ARGUMENT',
        `${filePath} was a binary file at version ${version}, not a text document.`,
        {
          details: { kind: 'binary_file', filePath, version },
        }
      )
    }
    // Unchanged and inserted text make up the text at `to`; with from equal to to there is only unchanged text.
    return normalizeLf(parsed.diff.map(part => part.u ?? part.i ?? '').join(''))
  }
}
