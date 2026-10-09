import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { posix } from 'node:path'

import type { ProgressReporter } from '../contracts/context.js'
import { asMcpError, McpError, type McpErrorCode } from '../core/errors.js'
import { gitBlobHash, gitBlobHashFile } from '../core/hash.js'
import { loadSyncIgnoreRules } from '../core/ignore-rules.js'
import { decodeUtf8Text } from '../core/local-file.js'
import { AccessPolicy } from '../core/policy.js'
import { scanLocalFolder, type IgnoredLocalEntry, type LocalFile } from '../core/local-folder.js'
import { decodeRevision } from '../core/revision.js'
import { normalizeLf } from '../core/text.js'
import type { ReadFileResult, WriteFileResult, WriteMode } from './documents.js'
import type { EntityAction, UploadFileOptions } from './entities.js'
import {
  normalizeProjectPath,
  parentPath,
  resolveProjectPath,
  type EntityType,
  type ProjectEntity,
  type ProjectTree,
} from './tree.js'

/**
 * The primitives a sync is composed from. Every one of them is an existing tool's operation,
 * so a sync inherits their checks: revision-checked, verified document writes, uploads by
 * path, and deletes that re-resolve the path they act on.
 */
export interface SyncDependencies {
  /** A freshly joined tree; a sync never decides anything from a cached one. */
  getProjectTree(projectId: string): Promise<ProjectTree>
  readFile(projectId: string, filePath: string): Promise<ReadFileResult>
  writeFile(
    projectId: string,
    filePath: string,
    revision: string,
    content: string,
    writeMode: WriteMode
  ): Promise<WriteFileResult>
  createFile(projectId: string, filePath: string, content: string, writeMode: WriteMode): Promise<unknown>
  uploadFile(
    projectId: string,
    localPath: string,
    destinationFolderPath: string,
    destinationName: string,
    options?: UploadFileOptions
  ): Promise<Record<string, unknown>>
  manageEntity(projectId: string, action: EntityAction): Promise<Record<string, unknown>>
  /** Tracked writes need the signed-in user's id; without it a tracked sync is refused. */
  currentUserId?: string | undefined
  /** Defaults to allowing everything but ids that are not path-safe. */
  policy?: AccessPolicy | undefined
}

export type SyncMode = 'additive' | 'mirror'
export type SyncAction = 'create_folder' | 'upload' | 'write' | 'create' | 'delete'
export type ConflictReason = 'local_file_remote_folder' | 'local_folder_remote_file' | 'not_utf8_text'

export type { ProgressReporter }

export interface PlannedUpload {
  localPath: string
  destinationPath: string
  reason: 'new' | 'changed'
  /** Absent when nothing could be compared: new files, and binaries stored without a hash. */
  comparedBy?: 'hash' | 'content'
  /** What the project holds at the path today, for changed entries. */
  remoteType?: 'doc' | 'file'
}

export interface RemoteOnlyEntry {
  destinationPath: string
  entityId: string
  type: EntityType
  /** For a folder, how many entities inside it go with it. */
  contains?: number
}

export interface SyncConflict {
  localPath: string
  destinationPath: string
  reason: ConflictReason
  message: string
}

export interface PlanSyncResult {
  planToken: string
  localFolderPath: string
  destinationFolderPath: string
  toUpload: PlannedUpload[]
  identical: { count: number; paths: string[] }
  remoteOnly: RemoteOnlyEntry[]
  conflicts: SyncConflict[]
  ignored: { count: number; entries: IgnoredLocalEntry[] }
}

export interface SyncOutcome {
  destinationPath: string
  action: SyncAction
  entityId?: string
}

export interface SyncFailure {
  destinationPath: string
  action: SyncAction
  errorCode: McpErrorCode
  message: string
}

export interface SyncDirectoryResult {
  status: 'complete' | 'partial'
  mode: SyncMode
  completed: SyncOutcome[]
  failed: SyncFailure[]
  remaining: Array<{ destinationPath: string; action: SyncAction }>
  identicalCount: number
  /** Resume or re-check with this; absent when the result could not be re-read. */
  planToken?: string
}

export interface DeleteEntitiesResult {
  status: 'complete' | 'partial'
  completed: Array<{ path: string; type: EntityType; entityId: string }>
  failed: Array<{ path: string; errorCode: McpErrorCode; message: string }>
  remaining: Array<{ path: string }>
}

export interface BatchUploadFile {
  localPath: string
  /** Full project path of the uploaded file, its name included. */
  destinationPath: string
}

export type BatchUploadConflict = 'skip' | 'overwrite'
export type BatchUploadAction = 'create_folder' | 'upload'

export interface BatchUploadOutcome {
  destinationPath: string
  action: BatchUploadAction
  entityId?: string
  entityType?: 'doc' | 'file'
  /** For an upload: something was already at the path and was replaced. */
  replaced?: boolean
  /** The upload timed out, and the tree read back afterwards shows it landed. */
  recoveredAfterTimeout?: true
}

export interface BatchUploadResult {
  status: 'complete' | 'partial'
  onConflict: BatchUploadConflict
  completed: BatchUploadOutcome[]
  skipped: Array<{ destinationPath: string; localPath: string; entityType: 'doc' | 'file' }>
  failed: Array<{ destinationPath: string; action: BatchUploadAction; errorCode: McpErrorCode; message: string }>
  remaining: Array<{ destinationPath: string; action: BatchUploadAction }>
  /** Whether the tree was read back and confirmed every completed entry; true when nothing was sent. */
  verified: boolean
}

export interface BatchUploadOptions {
  onConflict?: BatchUploadConflict | undefined
  stopOnError?: boolean | undefined
  onProgress?: ProgressReporter | undefined
}

/** The most files one batch_upload call accepts. */
export const BATCH_UPLOAD_LIMIT = 500

export interface PlanSyncOptions {
  destinationFolderPath?: string | undefined
  ignore?: readonly string[] | undefined
  verbose?: boolean | undefined
  onProgress?: ProgressReporter | undefined
}

export interface SyncDirectoryOptions {
  mode: SyncMode
  destinationFolderPath?: string | undefined
  planToken?: string | undefined
  confirmDeleteCount?: number | undefined
  ignore?: readonly string[] | undefined
  writeMode?: WriteMode | undefined
  stopOnError?: boolean | undefined
  onProgress?: ProgressReporter | undefined
}

export interface DeleteEntitiesOptions {
  stopOnError?: boolean | undefined
  onProgress?: ProgressReporter | undefined
}

/** How many identical paths and ignored entries a plan lists unless `verbose` is set. */
export const PLAN_LISTING_LIMIT = 25

/**
 * Extensions and names Overleaf's default configuration treats as editable text. A tracked sync
 * creates new files like these as documents with tracked content; anything else is uploaded,
 * and Overleaf never tracks an upload.
 */
const TEXT_EXTENSIONS = new Set([
  'tex', 'latex', 'sty', 'cls', 'bst', 'bib', 'bibtex', 'txt', 'tikz', 'mtx', 'rtex', 'md',
  'asy', 'lbx', 'bbx', 'cbx', 'm', 'lco', 'dtx', 'ins', 'ist', 'def', 'clo', 'ldf', 'rmd',
  'lua', 'gv', 'mf', 'yml', 'yaml', 'lhs', 'mk', 'xmpdata', 'cfg', 'rnw', 'ltx', 'inc',
])
const TEXT_FILE_NAMES = new Set(['latexmkrc', '.latexmkrc', 'makefile', 'gnumakefile'])

function isTextFileName(name: string): boolean {
  const lower = name.toLowerCase()
  if (TEXT_FILE_NAMES.has(lower)) return true
  const dot = lower.lastIndexOf('.')
  return dot > 0 && TEXT_EXTENSIONS.has(lower.slice(dot + 1))
}

interface FolderMakerHooks {
  /** Called before each creation request, sent or not. */
  onAttempt(): void
  onCreated(folder: string, entityId: string | undefined): void
  onFailed(folder: string, failure: McpError): void
}

interface UploadWork extends PlannedUpload {
  file: LocalFile
  remote?: ProjectEntity
  /** The document revision the plan compared against; the write is checked against it. */
  revision?: string
  /** The compared local text, LF-normalized, for a changed document. */
  text?: string
}

interface DeleteWork extends RemoteOnlyEntry {
  entity: ProjectEntity
  /** Everything inside a folder at plan time, so its contents are re-checked before deleting. */
  inside: ProjectEntity[]
}

interface SnapshotEntry {
  type: EntityType
  id: string
  /** Binary hash, document revision fingerprint, `''` for folders, `-` for unread documents. */
  fingerprint: string
}

interface Plan {
  projectId: string
  root: string
  destination: string
  scopeDigest: string
  localDigest: string
  snapshot: Map<string, SnapshotEntry>
  uploads: UploadWork[]
  identical: string[]
  deletes: DeleteWork[]
  conflicts: SyncConflict[]
  ignored: IgnoredLocalEntry[]
  folders: Set<string>
}

interface PlanTokenPayload {
  v: 1
  /** Project id, in the clear only to name the mismatch when a token is reused elsewhere. */
  p: string
  /** Digest of the arguments that decide what is in the plan. */
  s: string
  /** Digest of the project side: every entity in scope, with its hash or document revision. */
  r: string
  /** Digest of the local side: every included file's blob hash and every included folder. */
  l: string
}

function digest(lines: readonly string[]): string {
  return createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex').slice(0, 32)
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function remoteDigest(snapshot: Map<string, SnapshotEntry>): string {
  return digest(
    [...snapshot.entries()]
      .sort(([left], [right]) => compareStrings(left, right))
      .map(([path, entry]) => JSON.stringify([path, entry.type, entry.id, entry.fingerprint]))
  )
}

function revisionFingerprint(revision: string): string {
  const payload = decodeRevision(revision)
  return `${payload.protocol}:${payload.otVersion}:${payload.sha256}`
}

function encodePlanToken(payload: PlanTokenPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

function decodePlanToken(token: string): PlanTokenPayload {
  try {
    const payload = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as Partial<PlanTokenPayload>
    if (
      payload.v !== 1 ||
      typeof payload.p !== 'string' ||
      typeof payload.s !== 'string' ||
      typeof payload.r !== 'string' ||
      typeof payload.l !== 'string'
    ) {
      throw new Error('invalid fields')
    }
    return payload as PlanTokenPayload
  } catch (error) {
    throw new McpError('INVALID_ARGUMENT', 'planToken is not a token returned by plan_sync or sync_directory.', {
      cause: error,
    })
  }
}

/** A project path that may name a folder with a trailing slash; `""` and `.` are the root. */
function normalizeFolderPath(path: string | undefined): string {
  const trimmed = (path ?? '').replace(/[/\\]+$/u, '')
  if (trimmed === '' || trimmed === '.') return ''
  return normalizeProjectPath(trimmed)
}

/** Every folder above a project path, nearest the root first. */
function ancestorsOf(path: string): string[] {
  const parts = path.split('/')
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'))
}

function describeType(type: EntityType): string {
  return type === 'doc' ? 'text document' : type === 'file' ? 'binary file' : 'folder'
}

function createdEntityId(result: Record<string, unknown>): string | undefined {
  const created = result.created as { _id?: unknown } | undefined
  return typeof created?._id === 'string' ? created._id : undefined
}

function uploadedEntityType(value: unknown): 'doc' | 'file' | undefined {
  return value === 'doc' || value === 'file' ? value : undefined
}

function errnoOf(error: unknown): unknown {
  return (error as NodeJS.ErrnoException | null)?.code
}

/** Local read failures carry the caller's path and a typed code, never a raw errno message. */
function localReadFailure(error: unknown, localPath: string): McpError {
  if (error instanceof McpError) return error
  return new McpError('NOT_FOUND', `Local file could not be read: ${localPath}`, { cause: error })
}

function revisionOf(result: unknown): string | undefined {
  const revision = (result as { revision?: unknown } | null)?.revision
  return typeof revision === 'string' ? revision : undefined
}

function actionFor(work: UploadWork, writeMode: WriteMode): SyncAction {
  if (work.reason === 'changed' && work.remoteType === 'doc') return 'write'
  if (
    work.reason === 'new' &&
    writeMode === 'tracked' &&
    isTextFileName(posix.basename(work.destinationPath))
  ) {
    return 'create'
  }
  return 'upload'
}

const ACTION_VERBS: Record<SyncAction, string> = {
  create_folder: 'Created folder',
  upload: 'Uploaded',
  write: 'Wrote',
  create: 'Created',
  delete: 'Deleted',
}

/**
 * Compares a local folder with a project folder and makes one match the other, composed from
 * the existing tool primitives. It saves tool calls and context, not time: every step still
 * runs through the project's one queue, one after another.
 *
 * A plan token binds a sync to what the caller reviewed. It carries digests of the project
 * side (every entity in scope, with its binary hash or document revision) and of the local
 * side, so a sync refuses with `REMOTE_DRIFT` when either changed since the plan, before it
 * changes anything. The token returned by a sync describes the state that sync left, so it
 * can resume a partial run while still catching a collaborator's edit made in between.
 */
export class SyncApi {
  readonly #deps: SyncDependencies
  readonly #policy: AccessPolicy

  constructor(dependencies: SyncDependencies) {
    this.#deps = dependencies
    this.#policy = dependencies.policy ?? AccessPolicy.permissive
  }

  async planSync(
    projectId: string,
    localFolderPath: string,
    options: PlanSyncOptions = {}
  ): Promise<PlanSyncResult> {
    this.#policy.assertProject(projectId)
    this.#policy.assertEffect('local-read', 'overleaf-read')
    const plan = await this.#plan(projectId, localFolderPath, options)
    const limit = options.verbose === true ? Number.POSITIVE_INFINITY : PLAN_LISTING_LIMIT
    return {
      planToken: this.#token(plan, plan.snapshot),
      localFolderPath: plan.root,
      destinationFolderPath: plan.destination,
      toUpload: plan.uploads.map(upload => ({
        localPath: upload.localPath,
        destinationPath: upload.destinationPath,
        reason: upload.reason,
        ...(upload.comparedBy === undefined ? {} : { comparedBy: upload.comparedBy }),
        ...(upload.remoteType === undefined ? {} : { remoteType: upload.remoteType }),
      })),
      identical: { count: plan.identical.length, paths: plan.identical.slice(0, limit) },
      remoteOnly: plan.deletes.map(entry => ({
        destinationPath: entry.destinationPath,
        entityId: entry.entityId,
        type: entry.type,
        ...(entry.contains === undefined ? {} : { contains: entry.contains }),
      })),
      conflicts: plan.conflicts,
      ignored: { count: plan.ignored.length, entries: plan.ignored.slice(0, limit) },
    }
  }

  async syncDirectory(
    projectId: string,
    localFolderPath: string,
    options: SyncDirectoryOptions
  ): Promise<SyncDirectoryResult> {
    this.#policy.assertProject(projectId)
    // Every effect the sync may need is checked first, so a refusal never leaves it half applied.
    this.#policy.assertEffect('local-read', 'overleaf-read', 'overleaf-write')
    if (options.mode === 'mirror') this.#policy.assertEffect('overleaf-delete')
    const writeMode = options.writeMode ?? 'untracked'
    if (writeMode === 'tracked' && this.#deps.currentUserId === undefined) {
      throw new McpError(
        'PROTOCOL_UNSUPPORTED',
        'Tracked writes require an authenticated Overleaf user ID from the project bootstrap.'
      )
    }
    const token = options.planToken === undefined ? undefined : decodePlanToken(options.planToken)
    if (token !== undefined && token.p !== projectId) {
      throw new McpError('INVALID_ARGUMENT', 'planToken was issued for a different project.')
    }
    if (options.mode === 'mirror' && options.confirmDeleteCount === undefined) {
      throw new McpError(
        'CONFIRMATION_MISMATCH',
        'mirror mode deletes what exists only in the project and requires confirmDeleteCount: the number of remoteOnly entries in plan_sync\'s result, after the user has confirmed them.'
      )
    }

    // MCP progress must only increase, so the apply phase continues where reading left off.
    const onProgress = options.onProgress
    let read = 0
    const plan = await this.#plan(projectId, localFolderPath, {
      ...options,
      onProgress:
        onProgress === undefined
          ? undefined
          : async (progress, total, message) => {
              read = progress
              await onProgress(progress, total, message)
            },
    })
    if (token !== undefined) {
      if (token.s !== plan.scopeDigest) {
        throw new McpError(
          'INVALID_ARGUMENT',
          'planToken was issued for a different localFolderPath, destinationFolderPath, or ignore list. Pass the same values as to plan_sync.'
        )
      }
      const remoteChanged = token.r !== remoteDigest(plan.snapshot)
      const localChanged = token.l !== plan.localDigest
      if (remoteChanged || localChanged) {
        const changed = remoteChanged && localChanged ? 'both' : remoteChanged ? 'remote' : 'local'
        throw new McpError(
          'REMOTE_DRIFT',
          changed === 'local'
            ? 'The local folder changed since the plan, so the plan no longer describes this sync. Nothing was changed; run plan_sync again and review the new plan.'
            : 'The project changed since the plan, so syncing now could overwrite or delete work you have not reviewed. Nothing was changed; run plan_sync again and review the new plan.',
          { details: { changed } }
        )
      }
    }
    if (options.mode === 'mirror' && options.confirmDeleteCount !== plan.deletes.length) {
      throw new McpError(
        'CONFIRMATION_MISMATCH',
        'confirmDeleteCount must equal the number of remoteOnly entries plan_sync reports for this folder, each folder counting once. Nothing was changed.'
      )
    }

    return await this.#apply(
      plan,
      options.mode,
      writeMode,
      options.stopOnError === true,
      onProgress === undefined
        ? undefined
        : async (progress, total, message) => await onProgress(read + progress, read + total, message)
    )
  }

  async deleteEntities(
    projectId: string,
    paths: readonly string[],
    confirmCount: number,
    options: DeleteEntitiesOptions = {}
  ): Promise<DeleteEntitiesResult> {
    this.#policy.assertProject(projectId)
    this.#policy.assertEffect('overleaf-delete')
    const normalized = paths.map(path => {
      const folder = normalizeFolderPath(path)
      if (folder === '') throw new McpError('INVALID_ARGUMENT', 'The project root cannot be deleted.')
      return folder
    })
    const seen = new Set<string>()
    for (const path of normalized) {
      if (seen.has(path)) throw new McpError('INVALID_ARGUMENT', `${path} is listed more than once.`)
      seen.add(path)
    }
    for (const path of normalized) {
      const folder = normalized.find(other => path.startsWith(`${other}/`))
      if (folder !== undefined) {
        throw new McpError(
          'INVALID_ARGUMENT',
          `${path} is inside ${folder}, which is also listed. Deleting a folder removes everything inside it; list only the folder.`
        )
      }
    }
    if (confirmCount !== normalized.length) {
      throw new McpError(
        'CONFIRMATION_MISMATCH',
        'confirmCount must equal the number of paths, after the user has confirmed the list. Nothing was deleted.'
      )
    }

    // Resolve everything first, so one wrong path fails the call before anything is deleted.
    const tree = await this.#deps.getProjectTree(projectId)
    const targets = normalized.map(path => resolveProjectPath(tree.entities, path))

    const result: DeleteEntitiesResult = { status: 'complete', completed: [], failed: [], remaining: [] }
    let halted = false
    for (const [index, entity] of targets.entries()) {
      if (halted) {
        result.remaining.push({ path: entity.path })
        continue
      }
      try {
        await this.#deps.manageEntity(projectId, {
          action: 'delete',
          path: entity.path,
          confirmPath: entity.path,
        })
        result.completed.push({ path: entity.path, type: entity.type, entityId: entity.id })
      } catch (error) {
        const failure = asMcpError(error)
        result.failed.push({ path: entity.path, errorCode: failure.code, message: failure.message })
        if (options.stopOnError === true) halted = true
      }
      await options.onProgress?.(index + 1, targets.length, `Deleted ${index + 1} of ${targets.length}`)
    }
    if (result.failed.length > 0 || result.remaining.length > 0) result.status = 'partial'
    return result
  }

  /**
   * Uploads a list of local files to explicit project paths in one call, composed of the same
   * `uploadFile` and `create_folder` steps `upload_file` and `manage_entity` take. Every path is
   * checked before anything is sent; failures are per file and nothing is retried. A timed-out
   * upload is classified from the tree read back afterwards, never resubmitted.
   */
  async batchUpload(
    projectId: string,
    files: readonly BatchUploadFile[],
    options: BatchUploadOptions = {}
  ): Promise<BatchUploadResult> {
    this.#policy.assertProject(projectId)
    this.#policy.assertEffect('local-read', 'overleaf-write')
    const onConflict = options.onConflict ?? 'overwrite'
    if (files.length === 0 || files.length > BATCH_UPLOAD_LIMIT) {
      throw new McpError('INVALID_ARGUMENT', `files must list between 1 and ${BATCH_UPLOAD_LIMIT} entries.`)
    }
    const entries = files.map(file => {
      if (/[/\\]$/u.test(file.destinationPath)) {
        throw new McpError(
          'INVALID_ARGUMENT',
          `${file.destinationPath} ends with a slash; destinationPath must include the file name.`
        )
      }
      // Checked before normalizing, which would otherwise turn "figs/." or "a.png/.." into another path.
      const segments = file.destinationPath.split(/[/\\]/u)
      if (segments.includes('..') || segments.at(-1) === '.') {
        throw new McpError('INVALID_ARGUMENT', `Invalid destinationPath: ${file.destinationPath}`)
      }
      const destinationPath = normalizeFolderPath(file.destinationPath)
      if (destinationPath === '') {
        throw new McpError('INVALID_ARGUMENT', 'destinationPath must name a file inside the project, not the root.')
      }
      return { localPath: file.localPath, destinationPath }
    })
    const seen = new Set<string>()
    for (const { destinationPath } of entries) {
      if (seen.has(destinationPath)) {
        throw new McpError('INVALID_ARGUMENT', `${destinationPath} is listed more than once.`)
      }
      seen.add(destinationPath)
    }
    for (const { destinationPath } of entries) {
      const inside = entries.find(other => other.destinationPath.startsWith(`${destinationPath}/`))
      if (inside !== undefined) {
        throw new McpError(
          'INVALID_ARGUMENT',
          `${inside.destinationPath} would be inside ${destinationPath}, which is also uploaded as a file.`
        )
      }
    }
    for (const { localPath } of entries) {
      const local = await stat(await this.#policy.resolveLocalRead(localPath)).catch((error: unknown) => {
        throw localReadFailure(error, localPath)
      })
      if (!local.isFile()) throw new McpError('INVALID_ARGUMENT', `${localPath} is not a regular file.`)
    }

    const before = new Map((await this.#deps.getProjectTree(projectId)).entities.map(entity => [entity.path, entity]))
    const result: BatchUploadResult = {
      status: 'complete',
      onConflict,
      completed: [],
      skipped: [],
      failed: [],
      remaining: [],
      verified: true,
    }
    let halted = false
    let attempts = 0
    const record = (failure: BatchUploadResult['failed'][number]): void => {
      result.failed.push(failure)
      if (options.stopOnError === true) halted = true
    }
    const localHashes = new Map<string, string>()
    const timedOut = new Map<string, { localPath: string; localHash: string }>()
    const ensureFolder = this.#folderMaker(
      projectId,
      [...before.values()].filter(entity => entity.type === 'folder').map(entity => entity.path),
      {
        onAttempt: () => {
          attempts += 1
        },
        onCreated: (folder, entityId) => {
          result.completed.push({ destinationPath: folder, action: 'create_folder', ...(entityId === undefined ? {} : { entityId }) })
        },
        onFailed: (folder, failure) => {
          record({ destinationPath: folder, action: 'create_folder', errorCode: failure.code, message: failure.message })
          // Every further request would be refused too, so none is sent.
          if (failure.code === 'RATE_LIMITED') halted = true
        },
      }
    )

    for (const [index, entry] of entries.entries()) {
      const { localPath, destinationPath } = entry
      if (halted) {
        result.remaining.push({ destinationPath, action: 'upload' })
        continue
      }
      const parent = parentPath(destinationPath)
      const existing = before.get(destinationPath)
      const blocker = ancestorsOf(destinationPath)
        .map(folder => before.get(folder))
        .find(entity => entity !== undefined && entity.type !== 'folder')
      if (blocker !== undefined) {
        record({
          destinationPath,
          action: 'upload',
          errorCode: 'INVALID_ARGUMENT',
          message: `The project holds a ${describeType(blocker.type)} at ${blocker.path}, so nothing can be uploaded inside it.`,
        })
      } else if (existing?.type === 'folder') {
        record({
          destinationPath,
          action: 'upload',
          errorCode: 'INVALID_ARGUMENT',
          message: `The project holds a folder at ${destinationPath}. Delete or rename it, or choose another destinationPath.`,
        })
      } else if (existing !== undefined && onConflict === 'skip') {
        result.skipped.push({ destinationPath, localPath, entityType: existing.type })
      } else {
        const folderFailure = await ensureFolder(parent)
        if (folderFailure !== undefined) {
          if (halted) {
            result.remaining.push({ destinationPath, action: 'upload' })
          } else {
            record({
              destinationPath,
              action: 'upload',
              errorCode: folderFailure.code,
              message: `The folder ${parent} could not be created, so nothing was uploaded into it.`,
            })
          }
        } else {
          await this.#batchUploadOne(projectId, entry, existing, onConflict, {
            onAttempt: () => {
              attempts += 1
            },
            onHashed: hash => localHashes.set(destinationPath, hash),
            onSkipped: entityType => result.skipped.push({ destinationPath, localPath, entityType }),
            onUploaded: outcome => result.completed.push(outcome),
            onFailed: (failure, localHash) => {
              if (failure.code === 'TIMEOUT' && localHash !== undefined) {
                timedOut.set(destinationPath, { localPath, localHash })
              }
              record({ destinationPath, action: 'upload', errorCode: failure.code, message: failure.message })
              // Every further upload would be refused too, so none is sent.
              if (failure.code === 'RATE_LIMITED') halted = true
            },
          })
        }
      }
      await options.onProgress?.(index + 1, entries.length, `Handled ${index + 1} of ${entries.length} files`)
    }

    if (attempts > 0) {
      let after: ProjectTree | undefined
      try {
        after = await this.#deps.getProjectTree(projectId)
      } catch {
        result.verified = false
      }
      if (after !== undefined) this.#verifyBatch(result, after, before, localHashes, timedOut)
    }
    if (result.failed.length > 0 || result.remaining.length > 0) result.status = 'partial'
    return result
  }

  async #batchUploadOne(
    projectId: string,
    entry: BatchUploadFile,
    existing: ProjectEntity | undefined,
    onConflict: BatchUploadConflict,
    hooks: {
      onAttempt(): void
      onHashed(hash: string): void
      onSkipped(entityType: 'doc' | 'file'): void
      onUploaded(outcome: BatchUploadOutcome): void
      onFailed(failure: McpError, localHash: string | undefined): void
    }
  ): Promise<void> {
    const { localPath, destinationPath } = entry
    let localHash: string | undefined
    try {
      // Hashed before the upload, so the read-back can tell whether these bytes landed.
      localHash = (await gitBlobHashFile(localPath).catch((error: unknown) => {
        throw localReadFailure(error, localPath)
      })).hash
      hooks.onHashed(localHash)
      hooks.onAttempt()
      const uploaded = await this.#deps.uploadFile(
        projectId,
        localPath,
        parentPath(destinationPath),
        posix.basename(destinationPath),
        { ifExists: onConflict === 'skip' ? 'skip' : 'replace' }
      )
      const entityType = uploadedEntityType(uploaded.entityType)
      if (uploaded.skipped === true) {
        hooks.onSkipped(entityType ?? 'file')
        return
      }
      hooks.onUploaded({
        destinationPath,
        action: 'upload',
        ...(typeof uploaded.entityId === 'string' ? { entityId: uploaded.entityId } : {}),
        ...(entityType === undefined ? {} : { entityType }),
        replaced: typeof uploaded.replaced === 'boolean' ? uploaded.replaced : existing !== undefined,
      })
    } catch (error) {
      // The file can vanish between the hash and the upload's own read.
      const failure =
        !(error instanceof McpError) && typeof errnoOf(error) === 'string'
          ? localReadFailure(error, localPath)
          : asMcpError(error)
      hooks.onFailed(failure, localHash)
    }
  }

  /**
   * Checks every completed entry against the tree read back after the uploads, moving any the
   * tree contradicts to `failed`, and classifies each timed-out upload as landed, not landed, or
   * unknown from the same tree.
   */
  #verifyBatch(
    result: BatchUploadResult,
    after: ProjectTree,
    before: Map<string, ProjectEntity>,
    localHashes: Map<string, string>,
    timedOut: Map<string, { localPath: string; localHash: string }>
  ): void {
    const byPath = new Map(after.entities.map(entity => [entity.path, entity]))
    const verified: BatchUploadOutcome[] = []
    for (const outcome of result.completed) {
      const entity = byPath.get(outcome.destinationPath)
      let problem: string | undefined
      if (entity === undefined) {
        problem = 'Overleaf acknowledged the change, but nothing is at this path in the project tree afterwards.'
      } else if (outcome.action === 'create_folder' && entity.type !== 'folder') {
        problem = `A ${describeType(entity.type)}, not a folder, is at this path afterwards.`
      } else if (outcome.action === 'upload' && entity.type === 'folder') {
        problem = 'A folder, not the uploaded file, is at this path afterwards.'
      } else if (
        outcome.action === 'upload' &&
        entity.type === 'file' &&
        entity.hash !== undefined &&
        entity.hash !== localHashes.get(outcome.destinationPath)
      ) {
        problem = 'The uploaded file in the project does not match the local file; it may have changed during the upload.'
      }
      if (problem !== undefined) {
        result.failed.push({ destinationPath: outcome.destinationPath, action: outcome.action, errorCode: 'REMOTE_ERROR', message: problem })
        continue
      }
      if (outcome.entityId === undefined) outcome.entityId = entity!.id
      if (outcome.action === 'upload' && outcome.entityType === undefined && entity!.type !== 'folder') {
        outcome.entityType = entity!.type
      }
      verified.push(outcome)
    }

    for (const [destinationPath, { localHash }] of timedOut) {
      const index = result.failed.findIndex(
        failure => failure.destinationPath === destinationPath && failure.action === 'upload'
      )
      if (index === -1) continue
      const previous = before.get(destinationPath)
      const now = byPath.get(destinationPath)
      // The path holding exactly these bytes is the outcome the caller asked for, whether this
      // upload put them there or they were already identical.
      if (now?.type === 'file' && now.hash === localHash) {
        result.failed.splice(index, 1)
        verified.push({
          destinationPath,
          action: 'upload',
          entityId: now.id,
          entityType: 'file',
          replaced: previous !== undefined,
          recoveredAfterTimeout: true,
        })
      } else if (
        (previous === undefined && now === undefined) ||
        (previous?.type === 'file' && now?.type === 'file' && now.id === previous.id && now.hash === previous.hash)
      ) {
        result.failed[index]!.message =
          'The upload timed out, and the project read back afterwards shows this path unchanged, so it had not landed. It was not resubmitted; it could still land late, so check get_project_tree before uploading it again.'
      } else {
        result.failed[index] = {
          destinationPath,
          action: 'upload',
          errorCode: 'OUTCOME_UNKNOWN',
          message:
            'The upload timed out, and the project read back afterwards does not show whether it landed. It was not resubmitted; check get_project_tree before uploading it again.',
        }
      }
    }
    result.completed = verified
  }

  /**
   * Creates missing project folders, parents first. A creation that failed once is never
   * attempted again for the next file inside it, and its failure is returned for that file.
   */
  #folderMaker(
    projectId: string,
    existing: Iterable<string>,
    hooks: FolderMakerHooks
  ): (folder: string) => Promise<McpError | undefined> {
    const folders = new Set(existing)
    const failures = new Map<string, McpError>()
    const ensure = async (folder: string): Promise<McpError | undefined> => {
      if (folder === '' || folders.has(folder)) return undefined
      const known = failures.get(folder)
      if (known !== undefined) return known
      const parentFailure = await ensure(parentPath(folder))
      if (parentFailure !== undefined) {
        failures.set(folder, parentFailure)
        return parentFailure
      }
      try {
        hooks.onAttempt()
        const created = await this.#deps.manageEntity(projectId, { action: 'create_folder', path: folder })
        folders.add(folder)
        hooks.onCreated(folder, createdEntityId(created))
        return undefined
      } catch (error) {
        const failure = asMcpError(error)
        failures.set(folder, failure)
        hooks.onFailed(folder, failure)
        return failure
      }
    }
    return ensure
  }

  #token(plan: Plan, snapshot: Map<string, SnapshotEntry>): string {
    return encodePlanToken({
      v: 1,
      p: plan.projectId,
      s: plan.scopeDigest,
      r: remoteDigest(snapshot),
      l: plan.localDigest,
    })
  }

  async #plan(projectId: string, localFolderPath: string, options: PlanSyncOptions): Promise<Plan> {
    const destination = normalizeFolderPath(options.destinationFolderPath)
    const extraIgnore = options.ignore ?? []
    const folder = await this.#policy.resolveLocalRead(localFolderPath)
    const rules = await loadSyncIgnoreRules(folder, extraIgnore)
    const scan = await scanLocalFolder(folder, rules)
    const tree = await this.#deps.getProjectTree(projectId)

    const byPath = new Map(tree.entities.map(entity => [entity.path, entity]))
    const destinationEntity = destination === '' ? undefined : byPath.get(destination)
    if (destinationEntity !== undefined && destinationEntity.type !== 'folder') {
      throw new McpError(
        'INVALID_ARGUMENT',
        `${destination} is a ${describeType(destinationEntity.type)}, not a folder.`
      )
    }
    const prefix = destination === '' ? '' : `${destination}/`
    const inScope = tree.entities
      .filter(entity => entity.path.startsWith(prefix) && entity.path !== destination)
      .sort((left, right) => compareStrings(left.path, right.path))
    const remote = new Map(inScope.map(entity => [entity.path.slice(prefix.length), entity]))
    // An ignore rule protects the project side too: what it matches is never compared or deleted.
    const isProtected = (relative: string, entity: ProjectEntity): boolean =>
      rules.match(relative, entity.type === 'folder') !== undefined

    const localFiles = new Set(scan.files.map(file => file.path))
    const localFolders = new Set(scan.directories)
    const conflicts: SyncConflict[] = []
    const blocked: string[] = []
    const isBlocked = (relative: string): boolean => blocked.some(folder => relative.startsWith(folder))

    for (const folder of scan.directories) {
      if (isBlocked(folder)) continue
      const entity = remote.get(folder)
      if (entity !== undefined && entity.type !== 'folder') {
        conflicts.push({
          localPath: `${folder}/`,
          destinationPath: entity.path,
          reason: 'local_folder_remote_file',
          message: `The project holds a ${describeType(entity.type)} at ${entity.path}, where the local folder has a folder, so nothing inside that folder is compared. Delete or rename one of them, then plan again.`,
        })
        blocked.push(`${folder}/`)
      }
    }

    const uploads: UploadWork[] = []
    const identical: string[] = []
    const documents: Array<{ file: LocalFile; entity: ProjectEntity }> = []
    for (const file of scan.files) {
      if (isBlocked(file.path)) continue
      const destinationPath = `${prefix}${file.path}`
      const entity = remote.get(file.path)
      if (entity === undefined) {
        uploads.push({ localPath: file.path, destinationPath, reason: 'new', file })
      } else if (entity.type === 'folder') {
        conflicts.push({
          localPath: file.path,
          destinationPath,
          reason: 'local_file_remote_folder',
          message: `The project holds a folder at ${destinationPath}, where the local folder has a file, so nothing inside that folder is compared or deleted. Delete or rename one of them, then plan again.`,
        })
        blocked.push(`${file.path}/`)
      } else if (entity.type === 'doc') {
        documents.push({ file, entity })
      } else if (entity.hash === file.hash) {
        identical.push(destinationPath)
      } else {
        uploads.push({
          localPath: file.path,
          destinationPath,
          reason: 'changed',
          ...(entity.hash === undefined ? {} : { comparedBy: 'hash' as const }),
          remoteType: 'file',
          file,
          remote: entity,
        })
      }
    }

    // Remote-only entries collapse to their highest folder, unless something protected sits
    // inside it; then the folder stays and its other contents are listed one by one.
    const deletes: DeleteWork[] = []
    const collapsed: string[] = []
    const remoteEntries = [...remote.entries()]
    for (const [relative, entity] of remoteEntries) {
      if (isProtected(relative, entity) || localFiles.has(relative) || localFolders.has(relative)) continue
      if (isBlocked(relative) || collapsed.some(folder => relative.startsWith(folder))) continue
      if (entity.type !== 'folder') {
        deletes.push({ destinationPath: entity.path, entityId: entity.id, type: entity.type, entity, inside: [] })
        continue
      }
      const inside = remoteEntries.filter(([other]) => other.startsWith(`${relative}/`))
      if (inside.some(([other, child]) => isProtected(other, child))) continue
      collapsed.push(`${relative}/`)
      deletes.push({
        destinationPath: entity.path,
        entityId: entity.id,
        type: 'folder',
        contains: inside.length,
        entity,
        inside: inside.map(([, child]) => child),
      })
    }

    // Documents carry no hash, so each one compared or planned for deletion is read once.
    const deletedDocuments = deletes.flatMap(entry =>
      [entry.entity, ...entry.inside].filter(entity => entity.type === 'doc')
    )
    const fingerprints = new Map<string, string>()
    const total = documents.length + deletedDocuments.length
    let read = 0
    const reportRead = async (): Promise<void> => {
      read += 1
      await options.onProgress?.(read, total, `Read ${read} of ${total} documents`)
    }
    for (const { file, entity } of documents) {
      const bytes = await readFile(file.absolutePath)
      if (gitBlobHash(bytes) !== file.hash) {
        throw new McpError('INVALID_ARGUMENT', `${file.path} changed while the folder was being compared. Try again.`)
      }
      const text = decodeUtf8Text(bytes)
      if (text === undefined) {
        conflicts.push({
          localPath: file.path,
          destinationPath: entity.path,
          reason: 'not_utf8_text',
          message: `${file.path} is not UTF-8 text, but the project holds a text document at ${entity.path}. Convert the file to UTF-8, or delete the document first to replace it with a binary file.`,
        })
        await reportRead()
        continue
      }
      const document = await this.#deps.readFile(projectId, entity.path)
      fingerprints.set(entity.path, revisionFingerprint(document.revision))
      const local = normalizeLf(text)
      if (local === document.content) {
        identical.push(entity.path)
      } else {
        uploads.push({
          localPath: file.path,
          destinationPath: entity.path,
          reason: 'changed',
          comparedBy: 'content',
          remoteType: 'doc',
          file,
          remote: entity,
          revision: document.revision,
          text: local,
        })
      }
      await reportRead()
    }
    for (const entity of deletedDocuments) {
      fingerprints.set(entity.path, revisionFingerprint((await this.#deps.readFile(projectId, entity.path)).revision))
      await reportRead()
    }

    const snapshot = new Map<string, SnapshotEntry>()
    for (const entity of destinationEntity === undefined ? inScope : [destinationEntity, ...inScope]) {
      snapshot.set(entity.path, {
        type: entity.type,
        id: entity.id,
        fingerprint:
          entity.type === 'file'
            ? (entity.hash ?? '')
            : entity.type === 'doc'
              ? (fingerprints.get(entity.path) ?? '-')
              : '',
      })
    }

    return {
      projectId,
      root: scan.root,
      destination,
      scopeDigest: digest([JSON.stringify([projectId, scan.root, destination, extraIgnore])]),
      localDigest: digest([
        JSON.stringify(['olignore', rules.olignore ?? null]),
        ...scan.directories.map(folder => JSON.stringify(['folder', folder])),
        ...scan.files.map(file => JSON.stringify(['file', file.path, file.hash])),
      ]),
      snapshot,
      uploads: uploads.sort((left, right) => compareStrings(left.destinationPath, right.destinationPath)),
      identical: identical.sort(compareStrings),
      deletes,
      conflicts: conflicts.sort((left, right) => compareStrings(left.destinationPath, right.destinationPath)),
      ignored: scan.ignored,
      folders: new Set(tree.entities.filter(entity => entity.type === 'folder').map(entity => entity.path)),
    }
  }

  async #apply(
    plan: Plan,
    mode: SyncMode,
    writeMode: WriteMode,
    stopOnError: boolean,
    onProgress: ProgressReporter | undefined
  ): Promise<SyncDirectoryResult> {
    const { projectId } = plan
    let completed: SyncOutcome[] = []
    const failed: SyncFailure[] = []
    const remaining: Array<{ destinationPath: string; action: SyncAction }> = []
    const writtenRevisions = new Map<string, string>()
    const uploadedHashes = new Map<string, string>()
    let halted = false
    // Counts calls that may have changed the project, applied or not, to know what to re-read.
    let attempts = 0
    const record = (failure: SyncFailure): void => {
      failed.push(failure)
      if (stopOnError) halted = true
    }
    const total = plan.uploads.length + (mode === 'mirror' ? plan.deletes.length : 0)
    let done = 0
    const report = async (action: SyncAction): Promise<void> => {
      done += 1
      await onProgress?.(done, total, `${ACTION_VERBS[action]} ${done} of ${total}`)
    }

    const ensureFolder = this.#folderMaker(projectId, plan.folders, {
      onAttempt: () => {
        attempts += 1
      },
      onCreated: (folder, entityId) => {
        completed.push({ destinationPath: folder, action: 'create_folder', ...(entityId === undefined ? {} : { entityId }) })
      },
      onFailed: (folder, failure) => {
        record({ destinationPath: folder, action: 'create_folder', errorCode: failure.code, message: failure.message })
      },
    })

    for (const conflict of plan.conflicts) {
      record({
        destinationPath: conflict.destinationPath,
        action: 'upload',
        errorCode: 'INVALID_ARGUMENT',
        message: conflict.message,
      })
    }

    for (const work of plan.uploads) {
      const action = actionFor(work, writeMode)
      if (halted) {
        remaining.push({ destinationPath: work.destinationPath, action })
        continue
      }
      const parent = parentPath(work.destinationPath)
      const folderFailure = await ensureFolder(parent)
      if (folderFailure !== undefined) {
        if (halted) {
          remaining.push({ destinationPath: work.destinationPath, action })
        } else {
          record({
            destinationPath: work.destinationPath,
            action,
            errorCode: folderFailure.code,
            message: `The folder ${parent} could not be created, so nothing was uploaded into it.`,
          })
        }
        continue
      }
      try {
        attempts += 1
        const entityId = await this.#applyUpload(projectId, work, action, writeMode, writtenRevisions, uploadedHashes)
        completed.push({ destinationPath: work.destinationPath, action, ...(entityId === undefined ? {} : { entityId }) })
      } catch (error) {
        const failure = asMcpError(error)
        record({ destinationPath: work.destinationPath, action, errorCode: failure.code, message: failure.message })
      }
      await report(action)
    }

    // Uploads are confirmed against the tree before anything is deleted, because a delete must
    // never follow an upload that did not land.
    let tree: ProjectTree | undefined
    let observed = true
    const observe = async (): Promise<void> => {
      try {
        tree = await this.#deps.getProjectTree(projectId)
        completed = this.#verify(completed, tree, uploadedHashes, failed)
      } catch {
        observed = false
      }
    }
    if (attempts > 0) await observe()

    if (mode === 'mirror') {
      const deletesAllowed = observed && failed.length === 0 && !halted
      const attemptsBeforeDeletes = attempts
      for (const work of plan.deletes) {
        if (!deletesAllowed || halted) {
          remaining.push({ destinationPath: work.destinationPath, action: 'delete' })
          continue
        }
        try {
          attempts += 1
          await this.#deleteIfUnchanged(projectId, work)
          completed.push({ destinationPath: work.destinationPath, action: 'delete', entityId: work.entityId })
        } catch (error) {
          const failure = asMcpError(error)
          record({ destinationPath: work.destinationPath, action: 'delete', errorCode: failure.code, message: failure.message })
        }
        await report('delete')
      }
      if (attempts > attemptsBeforeDeletes) await observe()
    }

    let planToken: string | undefined
    if (observed) {
      try {
        planToken = this.#token(
          plan,
          tree === undefined
            ? plan.snapshot
            : await this.#expectedSnapshot(plan, completed, tree, writtenRevisions)
        )
      } catch {
        planToken = undefined
      }
    }

    return {
      status: failed.length === 0 && remaining.length === 0 ? 'complete' : 'partial',
      mode,
      completed,
      failed,
      remaining,
      identicalCount: plan.identical.length,
      ...(planToken === undefined ? {} : { planToken }),
    }
  }

  async #applyUpload(
    projectId: string,
    work: UploadWork,
    action: SyncAction,
    writeMode: WriteMode,
    writtenRevisions: Map<string, string>,
    uploadedHashes: Map<string, string>
  ): Promise<string | undefined> {
    const path = work.destinationPath
    if (action === 'write') {
      // The revision the plan compared against, so a concurrent edit is a REVISION_CONFLICT.
      const written = await this.#deps.writeFile(projectId, path, work.revision!, work.text!, writeMode)
      writtenRevisions.set(path, written.revision)
      return work.remote?.id
    }
    if (action === 'create') {
      const text = decodeUtf8Text(await readFile(work.file.absolutePath))
      if (text === undefined) {
        throw new McpError(
          'INVALID_ARGUMENT',
          `${work.localPath} is not UTF-8 text, so it cannot be created as a tracked change. Convert it to UTF-8, or sync with writeMode untracked.`
        )
      }
      // An empty file has nothing to track; it is created as an empty document.
      const created = await this.#deps.createFile(projectId, path, text, text === '' ? 'untracked' : 'tracked')
      const revision = revisionOf(created)
      if (revision !== undefined) writtenRevisions.set(path, revision)
      return undefined
    }
    const uploaded = await this.#deps.uploadFile(
      projectId,
      work.file.absolutePath,
      parentPath(path),
      posix.basename(path)
    )
    uploadedHashes.set(path, work.file.hash)
    return typeof uploaded.entityId === 'string' ? uploaded.entityId : undefined
  }

  /** Moves every outcome the tree contradicts from `completed` to `failed`. */
  #verify(
    completed: SyncOutcome[],
    tree: ProjectTree,
    uploadedHashes: Map<string, string>,
    failed: SyncFailure[]
  ): SyncOutcome[] {
    const byPath = new Map(tree.entities.map(entity => [entity.path, entity]))
    const verified: SyncOutcome[] = []
    for (const outcome of completed) {
      const entity = byPath.get(outcome.destinationPath)
      let problem: string | undefined
      if (outcome.action === 'delete') {
        if (entity !== undefined && entity.id === outcome.entityId) {
          problem = 'Overleaf acknowledged the delete, but the entity is still in the project tree.'
        }
      } else if (entity === undefined) {
        problem = 'Overleaf acknowledged the change, but nothing is at this path in the project tree afterwards.'
      } else if (outcome.action === 'create_folder' && entity.type !== 'folder') {
        problem = `A ${describeType(entity.type)}, not a folder, is at this path afterwards.`
      } else if (
        outcome.action === 'upload' &&
        entity.type === 'file' &&
        entity.hash !== undefined &&
        entity.hash !== uploadedHashes.get(outcome.destinationPath)
      ) {
        problem = 'The uploaded file in the project does not match the local file; it may have changed during the upload.'
      }
      if (problem === undefined) {
        if (outcome.entityId === undefined && entity !== undefined) outcome.entityId = entity.id
        verified.push(outcome)
      } else {
        failed.push({
          destinationPath: outcome.destinationPath,
          action: outcome.action,
          errorCode: 'REMOTE_ERROR',
          message: problem,
        })
      }
    }
    return verified
  }

  async #deleteIfUnchanged(projectId: string, work: DeleteWork): Promise<void> {
    const drift = new McpError(
      'REMOTE_DRIFT',
      `${work.destinationPath} changed after it was planned for deletion, so it was left in place. Run plan_sync again.`
    )
    const tree = await this.#deps.getProjectTree(projectId)
    const live = tree.entities.find(entity => entity.path === work.destinationPath)
    if (live === undefined || live.id !== work.entityId || live.type !== work.type) throw drift
    if (live.type === 'file' && live.hash !== work.entity.hash) throw drift
    if (live.type === 'folder') {
      const signature = (entities: ProjectEntity[]): string =>
        entities
          .map(entity => JSON.stringify([entity.path, entity.id, entity.type, entity.hash ?? '']))
          .sort(compareStrings)
          .join('\n')
      const inside = tree.entities.filter(entity => entity.path.startsWith(`${work.destinationPath}/`))
      if (signature(inside) !== signature(work.inside)) throw drift
    }
    await this.#deps.manageEntity(projectId, {
      action: 'delete',
      path: work.destinationPath,
      confirmPath: work.destinationPath,
    })
  }

  /**
   * The project state a resumed sync should find: the plan's snapshot, with what this sync
   * changed replaced by what the tree now shows. Anything it did not touch keeps its planned
   * state, so a collaborator's change made during the sync still stops the resumed run.
   */
  async #expectedSnapshot(
    plan: Plan,
    completed: SyncOutcome[],
    tree: ProjectTree,
    writtenRevisions: Map<string, string>
  ): Promise<Map<string, SnapshotEntry>> {
    const expected = new Map(plan.snapshot)
    const byPath = new Map(tree.entities.map(entity => [entity.path, entity]))
    const prefix = plan.destination === '' ? '' : `${plan.destination}/`
    for (const outcome of completed) {
      const path = outcome.destinationPath
      if (outcome.action === 'delete') {
        for (const key of [...expected.keys()]) {
          if (key === path || key.startsWith(`${path}/`)) expected.delete(key)
        }
        continue
      }
      // Folders created above the destination are outside what the plan covers.
      if (path !== plan.destination && !path.startsWith(prefix)) continue
      const entity = byPath.get(path)
      if (entity === undefined) continue
      let fingerprint: string
      if (entity.type === 'doc') {
        const revision =
          writtenRevisions.get(path) ?? (await this.#deps.readFile(plan.projectId, path)).revision
        fingerprint = revisionFingerprint(revision)
      } else {
        fingerprint = entity.type === 'file' ? (entity.hash ?? '') : ''
      }
      expected.set(path, { type: entity.type, id: entity.id, fingerprint })
    }
    return expected
  }
}
