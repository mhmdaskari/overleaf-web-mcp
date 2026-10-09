import { z } from 'zod'

import { McpError } from '../core/errors.js'
import { AccessPolicy } from '../core/policy.js'

export interface HistoryJsonGetter {
  getJson(path: string): Promise<unknown>
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
  timestamp: z.number().finite().optional(),
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
  z.object({
    atV: z.number().int().nonnegative(),
    add: z.object({ pathname: z.string() }),
  }).strict(),
  z.object({
    atV: z.number().int().nonnegative(),
    rename: z.object({ pathname: z.string(), newPathname: z.string() }),
  }).strict(),
  z.object({
    atV: z.number().int().nonnegative(),
    remove: z.object({ pathname: z.string() }),
  }).strict(),
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

function isoTimestamp(value: number | string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) throw new TypeError('Invalid history timestamp.')
  return date.toISOString()
}

function normalizeProjectOperation(
  operation: z.infer<typeof projectOperationSchema>
): HistoryProjectOperation {
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
      ...(meta.origin.timestamp === undefined
        ? {}
        : { timestamp: isoTimestamp(meta.origin.timestamp) }),
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

export class HistoryApi {
  readonly #http: HistoryJsonGetter
  readonly #policy: AccessPolicy

  constructor(http: HistoryJsonGetter, policy: AccessPolicy = AccessPolicy.permissive) {
    this.#http = http
    this.#policy = policy
  }

  async monitorProjectHistory(
    projectId: string,
    sinceVersion?: number
  ): Promise<ProjectHistoryMonitorResult> {
    this.#policy.assertProject(projectId)
    this.#policy.assertEffect('overleaf-read')
    if (
      sinceVersion !== undefined &&
      (!Number.isInteger(sinceVersion) || sinceVersion < 0)
    ) {
      throw new McpError('INVALID_ARGUMENT', 'sinceVersion must be a non-negative integer.')
    }

    const path = `/project/${encodeURIComponent(projectId)}/updates?min_count=25`
    const response = await this.#http.getJson(path)
    let parsed: z.infer<typeof responseSchema>
    try {
      parsed = responseSchema.parse(response)
    } catch (error) {
      throw new McpError(
        'PROTOCOL_UNSUPPORTED',
        'Overleaf returned an unsupported project history response.',
        { cause: error }
      )
    }

    try {
      const normalized = parsed.updates
        .map(normalizeUpdate)
        .sort((left, right) =>
          right.toVersion - left.toVersion || right.fromVersion - left.fromVersion
        )
      const currentVersion = normalized.length === 0
        ? null
        : Math.max(...normalized.map(update => update.toVersion))
      if (
        sinceVersion !== undefined &&
        currentVersion !== null &&
        sinceVersion > currentVersion
      ) {
        throw new McpError(
          'INVALID_ARGUMENT',
          `sinceVersion ${sinceVersion} is newer than project version ${currentVersion}.`
        )
      }
      const hasEarlierHistory = parsed.nextBeforeTimestamp !== undefined
      const oldestReturnedVersion = normalized.length === 0
        ? null
        : Math.min(...normalized.map(update => update.fromVersion))

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
        updates: normalized.filter(
          update => sinceVersion === undefined || update.toVersion > sinceVersion
        ),
      }
    } catch (error) {
      if (error instanceof McpError) throw error
      throw new McpError(
        'PROTOCOL_UNSUPPORTED',
        'Overleaf returned invalid project history values.',
        { cause: error }
      )
    }
  }
}
