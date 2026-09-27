import { z } from 'zod'

import { asMcpError, McpError } from '../core/errors.js'
import { resolveTextContent } from '../core/local-file.js'
import {
  DEFAULT_PROJECT_LIMIT,
  MAX_PROJECT_LIMIT,
  type AccountApi,
  type ListProjectsOptions,
} from '../overleaf/account.js'
import type { AddCommentInput, CommentsApi } from '../overleaf/comments.js'
import type { CompileApi } from '../overleaf/compile.js'
import type { DocumentsApi, WriteMode } from '../overleaf/documents.js'
import type { EntitiesApi, EntityAction } from '../overleaf/entities.js'
import type { HistoryApi } from '../overleaf/history.js'
import {
  COMPILERS,
  type ProjectAction,
  type ProjectsApi,
  type ProjectTemplate,
} from '../overleaf/projects.js'
import type { SectionsApi } from '../overleaf/sections-api.js'
import type { ProgressReporter, SyncApi, SyncMode } from '../overleaf/sync.js'

export const TOOL_NAMES = [
  'auth_status',
  'list_projects',
  'create_project',
  'clone_project',
  'import_project_zip',
  'manage_project',
  'update_project_settings',
  'get_project_tree',
  'read_file',
  'write_file',
  'create_file',
  'manage_entity',
  'upload_file',
  'download_file',
  'plan_sync',
  'sync_directory',
  'delete_entities',
  'get_sections',
  'get_section_content',
  'write_section',
  'compile_project',
  'stop_compile',
  'list_comments',
  'reply_to_comment',
  'add_comment',
  'set_comment_status',
  'monitor_project_history',
] as const

export interface OverleafToolRuntime {
  authStatus(): Promise<Record<string, unknown>>
  account: Pick<AccountApi, 'listProjects'>
  projects: Pick<
    ProjectsApi,
    'createProject' | 'cloneProject' | 'importProjectZip' | 'manageProject' | 'updateProjectSettings'
  >
  entities: Pick<
    EntitiesApi,
    'getProjectTree' | 'manageEntity' | 'uploadFile' | 'downloadFile'
  >
  documents: Pick<DocumentsApi, 'readFile' | 'writeFile'>
  createFile(
    projectId: string,
    filePath: string,
    content?: string,
    writeMode?: WriteMode
  ): Promise<unknown>
  sections: Pick<SectionsApi, 'getSections' | 'getSectionContent' | 'writeSection'>
  compile: Pick<CompileApi, 'compileProject' | 'stopCompile'>
  comments: Pick<
    CommentsApi,
    'listComments' | 'replyToComment' | 'addComment' | 'setCommentStatus'
  >
  history: Pick<HistoryApi, 'monitorProjectHistory'>
  sync: Pick<SyncApi, 'planSync' | 'syncDirectory' | 'deleteEntities'>
}

/** The part of the SDK's per-request context a tool uses: the progress token and a notifier. */
export interface ToolCallExtra {
  _meta?: { progressToken?: string | number | undefined } | undefined
  sendNotification?: (notification: {
    method: 'notifications/progress'
    params: { progressToken: string | number; progress: number; total?: number; message?: string }
  }) => Promise<void>
}

interface ToolRegistrar {
  registerTool(
    name: string,
    config: Record<string, unknown>,
    handler: (args: any, extra?: any) => Promise<Record<string, unknown>>
  ): unknown
}

const projectId = z.string().min(1).describe('Overleaf project ID')
const filePath = z.string().min(1).describe('Project-relative path using forward slashes')
const revision = z.string().min(1).describe('Opaque revision returned by a prior read or write')
const writeMode = z.enum(['untracked', 'tracked']).default('untracked').describe(
  'Use tracked to record inserted and deleted text as Overleaf tracked changes; defaults to untracked'
)
const position = z.object({
  line: z.number().int().positive(),
  column: z.number().int().positive(),
})

function success(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  }
}

function failure(error: unknown): Record<string, unknown> {
  const normalized = asMcpError(error)
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(normalized.toJSON(), null, 2) }],
  }
}

function handler<T>(operation: (args: T) => Promise<unknown>): (args: T) => Promise<Record<string, unknown>> {
  return async args => {
    try {
      return success(await operation(args))
    } catch (error) {
      return failure(error)
    }
  }
}

/**
 * Like `handler`, for tools that declare an `outputSchema`: the result is returned both as
 * `structuredContent` and as the JSON text block older clients read.
 */
function structured<T>(
  operation: (args: T, extra?: ToolCallExtra) => Promise<Record<string, unknown>>
): (args: T, extra?: ToolCallExtra) => Promise<Record<string, unknown>> {
  return async (args, extra) => {
    try {
      const value = await operation(args, extra)
      return { ...success(value), structuredContent: value }
    } catch (error) {
      return failure(error)
    }
  }
}

/**
 * Sends `notifications/progress` when the client asked for them with a progress token.
 * Progress is advisory, so a notification that cannot be delivered never fails the call.
 */
function progressReporter(extra: ToolCallExtra | undefined): ProgressReporter | undefined {
  const progressToken = extra?._meta?.progressToken
  const send = extra?.sendNotification
  if (progressToken === undefined || send === undefined) return undefined
  return async (progress, total, message) => {
    try {
      await send({
        method: 'notifications/progress',
        params: { progressToken, progress, total, message },
      })
    } catch {
      // The call's own result is what matters.
    }
  }
}

const localFolderPath = z
  .string()
  .min(1)
  .describe("Local folder on the server's own disk, synced as a whole")
const destinationFolderPath = z
  .string()
  .default('')
  .describe('Project folder the local folder corresponds to; "" (the default) is the project root')
const ignorePatterns = z
  .array(z.string().min(1).max(500))
  .max(200)
  .optional()
  .describe(
    'Extra gitignore-style patterns, applied after the defaults (hidden files and folders, __MACOSX/, and LaTeX build output: *.aux, *.log, *.bbl, *.blg, *.out, *.toc, *.synctex.gz, *.fdb_latexmk, *.fls) and after any .olignore file in the folder; "!pattern" re-includes, for example "!.latexmkrc". Ignored paths are never uploaded, compared, or deleted, on either side.'
  )
const entityTypeSchema = z.enum(['doc', 'file', 'folder'])
const syncActionSchema = z.enum(['create_folder', 'upload', 'write', 'create', 'delete'])
const errorCodeSchema = z.string()

const projectSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  accessLevel: z.string(),
  lastUpdated: z.string().optional(),
  archived: z.boolean(),
  trashed: z.boolean(),
})

const projectName = z
  .string()
  .min(1)
  .max(150)
  .describe('Project name, 1 to 150 characters without slashes')

const createdProjectSchema = {
  projectId: z.string(),
  name: z.string(),
  url: z.string(),
}

export function registerOverleafTools(server: ToolRegistrar, runtime: OverleafToolRuntime): void {
  server.registerTool(
    'auth_status',
    {
      description:
        'Verify the saved Overleaf web session without exposing cookies. sessionExpiresAt is when the session lapses unless a request refreshes it first; Overleaf sessions last five days from their last use, and the CLI command `overleaf-web-mcp keepalive` can be scheduled to refresh them.',
      outputSchema: {
        authenticated: z.literal(true),
        baseUrl: z.string(),
        userId: z.string().optional(),
        projectCount: z.number().int().nonnegative(),
        sessionExpiresAt: z.string().optional(),
        permissionsUnchecked: z.boolean(),
        warning: z.string().optional(),
        socketPresenceNotice: z.string(),
      },
      annotations: { readOnlyHint: true },
    },
    structured(async () => await runtime.authStatus())
  )
  server.registerTool(
    'list_projects',
    {
      description:
        'List the projects the account can access, newest first by default. Archived and trashed projects are hidden unless includeArchived or includeTrashed is set. Returns projects with id, name, accessLevel, lastUpdated, archived, and trashed, plus totalMatched (before limit) and totalProjects (everything the account can access).',
      inputSchema: {
        query: z
          .string()
          .min(1)
          .optional()
          .describe('Case-insensitive substring of the project name'),
        includeArchived: z.boolean().default(false),
        includeTrashed: z.boolean().default(false),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_PROJECT_LIMIT)
          .default(DEFAULT_PROJECT_LIMIT)
          .describe(`Maximum projects returned, at most ${MAX_PROJECT_LIMIT}`),
        sort: z
          .enum(['lastUpdated', 'name'])
          .default('lastUpdated')
          .describe('lastUpdated is newest first; name is alphabetical'),
      },
      outputSchema: {
        projects: z.array(projectSummarySchema),
        totalMatched: z.number().int(),
        totalProjects: z.number().int(),
      },
      annotations: { readOnlyHint: true },
    },
    structured(async (args: ListProjectsOptions) => ({
      ...(await runtime.account.listProjects(args)),
    }))
  )
  server.registerTool(
    'create_project',
    {
      description:
        'Create a new Overleaf project and return its projectId, url, and rootDocPath. A "blank" project still contains Overleaf\'s stub main.tex as its root document; after importing your own manuscript, point the project at it with update_project_settings or delete the stub with manage_entity. "example" seeds Overleaf\'s example paper.',
      inputSchema: {
        name: projectName,
        template: z.enum(['blank', 'example']).default('blank'),
      },
      outputSchema: { ...createdProjectSchema, rootDocPath: z.string().optional() },
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    structured(async (args: { name: string; template: ProjectTemplate }) => ({
      ...(await runtime.projects.createProject(args.name, args.template)),
    }))
  )
  server.registerTool(
    'clone_project',
    {
      description:
        'Copy an existing project, including its files and settings, into a new project with the given name. Use it to start from a lab or journal template project.',
      inputSchema: { sourceProjectId: projectId.describe('Project to copy'), name: projectName },
      outputSchema: createdProjectSchema,
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    structured(async (args: { sourceProjectId: string; name: string }) => ({
      ...(await runtime.projects.cloneProject(args.sourceProjectId, args.name)),
    }))
  )
  server.registerTool(
    'import_project_zip',
    {
      description:
        'Create a new project from a local .zip archive of LaTeX sources. name defaults to the archive file name. Overleaf caps archives at about 50 MB and rate-limits this route: RATE_LIMITED means wait details.retryAfterMs before trying again, and nothing was created. Set the root document afterwards with update_project_settings if the archive has more than one .tex file at the top level.',
      inputSchema: {
        localZipPath: z.string().min(1).describe('Local path of a .zip archive'),
        name: projectName.optional(),
      },
      outputSchema: createdProjectSchema,
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    structured(async (args: { localZipPath: string; name?: string }) => ({
      ...(await runtime.projects.importProjectZip(args.localZipPath, args.name)),
    }))
  )
  server.registerTool(
    'manage_project',
    {
      description:
        'Rename, trash, restore, archive, unarchive, or permanently delete a project. trash, archive, and delete require confirmName to equal the current project name exactly, else CONFIRMATION_MISMATCH and nothing changes. trash is the normal way to remove a project and is reversible with restore or in the web UI. delete is permanent and only succeeds on a project that is already trashed. Confirm with the user before trashing or deleting.',
      inputSchema: {
        projectId,
        action: z.enum(['rename', 'trash', 'restore', 'archive', 'unarchive', 'delete']),
        newName: projectName.optional().describe('New name, for rename'),
        confirmName: z
          .string()
          .optional()
          .describe('Current project name, repeated exactly, for trash, archive, and delete'),
      },
      outputSchema: {
        action: z.enum(['rename', 'trash', 'restore', 'archive', 'unarchive', 'delete']),
        projectId: z.string(),
        name: z.string(),
      },
      annotations: { destructiveHint: true, idempotentHint: false },
    },
    structured(async (args: {
      projectId: string
      action: ProjectAction['action']
      newName?: string
      confirmName?: string
    }) => {
      let action: ProjectAction
      if (args.action === 'rename' && args.newName !== undefined) {
        action = { action: args.action, newName: args.newName }
      } else if (
        (args.action === 'trash' || args.action === 'archive' || args.action === 'delete') &&
        args.confirmName !== undefined
      ) {
        action = { action: args.action, confirmName: args.confirmName }
      } else if (args.action === 'restore' || args.action === 'unarchive') {
        action = { action: args.action }
      } else {
        throw new McpError('INVALID_ARGUMENT', `Missing fields for ${args.action}.`)
      }
      return { ...(await runtime.projects.manageProject(args.projectId, action)) }
    })
  )
  server.registerTool(
    'update_project_settings',
    {
      description:
        "Persist the project's root document, TeX engine, TeX Live image, or spell-check language in Overleaf's own project settings, so the web UI's Recompile follows the change. rootFilePath must name an existing text document. Returns the settings as re-read from the project. Provide at least one field.",
      inputSchema: {
        projectId,
        rootFilePath: filePath.optional().describe('Document Overleaf should compile by default'),
        compiler: z.enum(COMPILERS).optional(),
        imageName: z.string().min(1).optional().describe('TeX Live image, as shown in Overleaf\'s menu'),
        spellCheckLanguage: z
          .string()
          .optional()
          .describe('Overleaf language code such as en or de; an empty string turns spell checking off'),
      },
      outputSchema: {
        projectId: z.string(),
        rootDocPath: z.string().optional(),
        compiler: z.string().optional(),
        imageName: z.string().optional(),
        spellCheckLanguage: z.string().optional(),
      },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    structured(async (args: {
      projectId: string
      rootFilePath?: string
      compiler?: (typeof COMPILERS)[number]
      imageName?: string
      spellCheckLanguage?: string
    }) => ({
      ...(await runtime.projects.updateProjectSettings(args.projectId, {
        rootFilePath: args.rootFilePath,
        compiler: args.compiler,
        imageName: args.imageName,
        spellCheckLanguage: args.spellCheckLanguage,
      })),
    }))
  )
  server.registerTool(
    'get_project_tree',
    {
      description:
        'Return the project file/folder tree with entity IDs and paths, plus the root document, compiler, TeX Live image, and spell-check language Overleaf uses. Each binary file entity carries hash, a git blob hash equal to `git hash-object <file>`; text documents have no hash and must be compared by reading their content.',
      inputSchema: { projectId },
      annotations: { readOnlyHint: true },
    },
    handler(async ({ projectId }: { projectId: string }) =>
      await runtime.entities.getProjectTree(projectId)
    )
  )
  server.registerTool(
    'read_file',
    {
      description: 'Read a text document as LF-normalized content and return its opaque revision.',
      inputSchema: { projectId, filePath },
      annotations: { readOnlyHint: true },
    },
    handler(async (args: { projectId: string; filePath: string }) =>
      await runtime.documents.readFile(args.projectId, args.filePath)
    )
  )
  server.registerTool(
    'write_file',
    {
      description:
        'Replace a text document using a minimal verified OT edit, optionally recorded as tracked changes. Supply the new text either inline through content or from disk through localPath, never both; localPath keeps a whole-file replacement revision-checked without sending the file through the tool call.',
      inputSchema: {
        projectId,
        filePath,
        revision,
        content: z.string().optional().describe('Complete replacement text, mutually exclusive with localPath'),
        localPath: z
          .string()
          .min(1)
          .optional()
          .describe('Local UTF-8 text file holding the complete replacement, mutually exclusive with content'),
        writeMode,
      },
      annotations: { destructiveHint: true, idempotentHint: false },
    },
    handler(async (args: {
      projectId: string
      filePath: string
      revision: string
      content?: string
      localPath?: string
      writeMode: WriteMode
    }) =>
      await runtime.documents.writeFile(
        args.projectId,
        args.filePath,
        args.revision,
        await resolveTextContent(args),
        args.writeMode
      )
    )
  )
  server.registerTool(
    'create_file',
    {
      description:
        'Create a text document and optionally record non-empty initial content as tracked changes.',
      inputSchema: { projectId, filePath, content: z.string().optional(), writeMode },
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    handler(async (args: {
      projectId: string
      filePath: string
      content?: string
      writeMode: WriteMode
    }) =>
      await runtime.createFile(args.projectId, args.filePath, args.content, args.writeMode)
    )
  )
  server.registerTool(
    'manage_entity',
    {
      description:
        'Create a folder, rename, move, or delete an entity. Deletion requires confirmPath to exactly equal path.',
      inputSchema: {
        projectId,
        action: z.enum(['create_folder', 'rename', 'move', 'delete']),
        path: filePath,
        newName: z.string().min(1).optional(),
        destinationFolderPath: z.string().optional(),
        confirmPath: z.string().optional(),
      },
      annotations: { destructiveHint: true, idempotentHint: false },
    },
    handler(async (args: {
      projectId: string
      action: EntityAction['action']
      path: string
      newName?: string
      destinationFolderPath?: string
      confirmPath?: string
    }) => {
      let action: EntityAction
      if (args.action === 'create_folder') action = { action: args.action, path: args.path }
      else if (args.action === 'rename' && args.newName !== undefined) {
        action = { action: args.action, path: args.path, newName: args.newName }
      } else if (args.action === 'move' && args.destinationFolderPath !== undefined) {
        action = {
          action: args.action,
          path: args.path,
          destinationFolderPath: args.destinationFolderPath,
        }
      } else if (args.action === 'delete' && args.confirmPath !== undefined) {
        action = { action: args.action, path: args.path, confirmPath: args.confirmPath }
      } else {
        throw new McpError('INVALID_ARGUMENT', `Missing fields for ${args.action}.`)
      }
      return await runtime.entities.manageEntity(args.projectId, action)
    })
  )
  server.registerTool(
    'upload_file',
    {
      description:
        'Upload a local file into a project folder, replacing any entity already at that path in place and keeping its entity ID. Works for text documents as well as binaries; Overleaf decides which by extension and UTF-8 validity. Replacing a document this way is a blind write with no revision check that is never tracked, so prefer write_file when a collaborator may be editing.',
      inputSchema: {
        projectId,
        localPath: z.string().min(1),
        destinationFolderPath: z.string().default(''),
        destinationName: z
          .string()
          .min(1)
          .optional()
          .describe('Name to store the file under; defaults to the local file name'),
      },
      annotations: { destructiveHint: true, idempotentHint: false },
    },
    handler(async (args: {
      projectId: string
      localPath: string
      destinationFolderPath: string
      destinationName?: string
    }) =>
      await runtime.entities.uploadFile(
        args.projectId,
        args.localPath,
        args.destinationFolderPath,
        args.destinationName
      )
    )
  )
  server.registerTool(
    'download_file',
    {
      description:
        'Download one Overleaf document or binary file to an explicit local path. Refuses to replace an existing local file unless overwrite is set.',
      inputSchema: {
        projectId,
        filePath,
        localPath: z.string().min(1),
        overwrite: z.boolean().default(false).describe('Replace localPath if it already exists'),
      },
      annotations: { readOnlyHint: true },
    },
    handler(async (args: {
      projectId: string
      filePath: string
      localPath: string
      overwrite: boolean
    }) =>
      await runtime.entities.downloadFile(
        args.projectId,
        args.filePath,
        args.localPath,
        args.overwrite
      )
    )
  )
  server.registerTool(
    'plan_sync',
    {
      description:
        "Compare a local folder with a project folder and report what sync_directory would do, changing nothing. Binary files compare by git blob hash at no cost; each text document with a local counterpart, or present only in the project, is read once through the project's queue, so this suits tens of documents, not thousands. Returns toUpload (new or changed), identical (a count and the first 25 paths unless verbose), remoteOnly (what mirror mode would delete, each folder collapsed to one entry that includes its contents), conflicts (a file where the other side has a folder, or non-UTF-8 text where the project has a document; sync_directory cannot apply these), ignored, and planToken. Show the plan to the user before syncing. localFolderPath is on the server's disk; a symbolic link that leads outside it fails with PATH_OUTSIDE_ROOT.",
      inputSchema: {
        projectId,
        localFolderPath,
        destinationFolderPath,
        ignore: ignorePatterns,
        verbose: z
          .boolean()
          .default(false)
          .describe('List every identical path and ignored entry instead of the first 25'),
      },
      outputSchema: {
        planToken: z.string(),
        localFolderPath: z.string(),
        destinationFolderPath: z.string(),
        toUpload: z.array(
          z.object({
            localPath: z.string(),
            destinationPath: z.string(),
            reason: z.enum(['new', 'changed']),
            comparedBy: z.enum(['hash', 'content']).optional(),
            remoteType: z.enum(['doc', 'file']).optional(),
          })
        ),
        identical: z.object({ count: z.number().int(), paths: z.array(z.string()) }),
        remoteOnly: z.array(
          z.object({
            destinationPath: z.string(),
            entityId: z.string(),
            type: entityTypeSchema,
            contains: z.number().int().optional(),
          })
        ),
        conflicts: z.array(
          z.object({
            localPath: z.string(),
            destinationPath: z.string(),
            reason: z.enum(['local_file_remote_folder', 'local_folder_remote_file', 'not_utf8_text']),
            message: z.string(),
          })
        ),
        ignored: z.object({
          count: z.number().int(),
          entries: z.array(
            z.object({
              localPath: z.string(),
              matchedPattern: z.string().optional(),
              reason: z.string().optional(),
            })
          ),
        }),
      },
      annotations: { readOnlyHint: true },
    },
    structured(async (args: {
      projectId: string
      localFolderPath: string
      destinationFolderPath: string
      ignore?: string[]
      verbose: boolean
    }, extra) => ({
      ...(await runtime.sync.planSync(args.projectId, args.localFolderPath, {
        destinationFolderPath: args.destinationFolderPath,
        ignore: args.ignore,
        verbose: args.verbose,
        onProgress: progressReporter(extra),
      })),
    }))
  )
  server.registerTool(
    'sync_directory',
    {
      description:
        "Make a project folder match a local folder: upload new and changed files, and in mirror mode also delete what exists only in the project. Call plan_sync first, confirm the plan with the user, and pass its planToken; if the project or the folder changed since, REMOTE_DRIFT is returned and nothing changes. Changed text documents are replaced through revision-checked write_file edits, recorded as tracked changes when writeMode is tracked, so a concurrent edit fails that file with REVISION_CONFLICT rather than being overwritten. Binaries and new files are uploaded; with writeMode tracked, new .tex, .bib, and similar text files are created with tracked content instead. Missing folders are created. Uploads and writes run first. Deletes run only in mirror mode, only when confirmDeleteCount equals the number of remoteOnly entries, else CONFIRMATION_MISMATCH, and never after any upload or write failed. Failures are per file and nothing is retried: the call continues unless stopOnError, then returns status, completed, failed, remaining, and a planToken to resume with. It saves tool calls, not time.",
      inputSchema: {
        projectId,
        localFolderPath,
        mode: z
          .enum(['additive', 'mirror'])
          .describe('additive only uploads and writes; mirror also deletes what exists only in the project'),
        destinationFolderPath,
        planToken: z
          .string()
          .min(1)
          .optional()
          .describe('From plan_sync, or from a partial sync_directory to resume it'),
        confirmDeleteCount: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("Required in mirror mode: the number of entries in plan_sync's remoteOnly, each folder counting once"),
        ignore: ignorePatterns,
        writeMode,
        stopOnError: z.boolean().default(false).describe('Stop at the first failure instead of continuing'),
      },
      outputSchema: {
        status: z.enum(['complete', 'partial']),
        mode: z.enum(['additive', 'mirror']),
        completed: z.array(
          z.object({ destinationPath: z.string(), action: syncActionSchema, entityId: z.string().optional() })
        ),
        failed: z.array(
          z.object({
            destinationPath: z.string(),
            action: syncActionSchema,
            errorCode: errorCodeSchema,
            message: z.string(),
          })
        ),
        remaining: z.array(z.object({ destinationPath: z.string(), action: syncActionSchema })),
        identicalCount: z.number().int(),
        planToken: z.string().optional(),
      },
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    structured(async (args: {
      projectId: string
      localFolderPath: string
      mode: SyncMode
      destinationFolderPath: string
      planToken?: string
      confirmDeleteCount?: number
      ignore?: string[]
      writeMode: WriteMode
      stopOnError: boolean
    }, extra) => ({
      ...(await runtime.sync.syncDirectory(args.projectId, args.localFolderPath, {
        mode: args.mode,
        destinationFolderPath: args.destinationFolderPath,
        planToken: args.planToken,
        confirmDeleteCount: args.confirmDeleteCount,
        ignore: args.ignore,
        writeMode: args.writeMode,
        stopOnError: args.stopOnError,
        onProgress: progressReporter(extra),
      })),
    }))
  )
  server.registerTool(
    'delete_entities',
    {
      description:
        'Delete several documents, files, or folders in one call. confirmCount must equal the number of paths, else CONFIRMATION_MISMATCH. Every path is resolved before anything is deleted, so a missing one fails the call with NOT_FOUND and changes nothing. Deleting a folder removes everything inside it, so list the folder alone, not its contents too. Continues past a failed delete unless stopOnError, and returns status, completed, failed, and remaining. Confirm the list with the user first.',
      inputSchema: {
        projectId,
        paths: z.array(filePath).min(1).max(500).describe('Project paths to delete'),
        confirmCount: z
          .number()
          .int()
          .positive()
          .describe('The number of paths, repeated after confirming the list with the user'),
        stopOnError: z.boolean().default(false).describe('Stop at the first failure instead of continuing'),
      },
      outputSchema: {
        status: z.enum(['complete', 'partial']),
        completed: z.array(z.object({ path: z.string(), type: entityTypeSchema, entityId: z.string() })),
        failed: z.array(z.object({ path: z.string(), errorCode: errorCodeSchema, message: z.string() })),
        remaining: z.array(z.object({ path: z.string() })),
      },
      annotations: { destructiveHint: true, idempotentHint: false },
    },
    structured(async (args: {
      projectId: string
      paths: string[]
      confirmCount: number
      stopOnError: boolean
    }, extra) => ({
      ...(await runtime.sync.deleteEntities(args.projectId, args.paths, args.confirmCount, {
        stopOnError: args.stopOnError,
        onProgress: progressReporter(extra),
      })),
    }))
  )
  server.registerTool(
    'get_sections',
    {
      description:
        'Parse LaTeX section headings in one file only; this never follows input/include directives.',
      inputSchema: { projectId, filePath },
      annotations: { readOnlyHint: true },
    },
    handler(async (args: { projectId: string; filePath: string }) =>
      await runtime.sections.getSections(args.projectId, args.filePath)
    )
  )
  server.registerTool(
    'get_section_content',
    {
      description: 'Read one parsed section body from a single file.',
      inputSchema: { projectId, filePath, sectionId: z.string().min(1) },
      annotations: { readOnlyHint: true },
    },
    handler(async (args: { projectId: string; filePath: string; sectionId: string }) =>
      await runtime.sections.getSectionContent(args.projectId, args.filePath, args.sectionId)
    )
  )
  server.registerTool(
    'write_section',
    {
      description:
        'Replace one section body in a single file using a revision-checked write, optionally recorded as tracked changes. Included files are not traversed.',
      inputSchema: {
        projectId,
        filePath,
        revision,
        sectionId: z.string().min(1),
        content: z.string(),
        writeMode,
      },
      annotations: { destructiveHint: true, idempotentHint: false },
    },
    handler(async (args: {
      projectId: string
      filePath: string
      revision: string
      sectionId: string
      content: string
      writeMode: WriteMode
    }) =>
      await runtime.sections.writeSection(
        args.projectId,
        args.filePath,
        args.revision,
        args.sectionId,
        args.content,
        args.writeMode
      )
    )
  )
  server.registerTool(
    'compile_project',
    {
      description:
        "Compile a project. Omit rootFilePath to build the root document configured in Overleaf, which is what the web UI's Recompile button uses; pass it to build a different document for this call only.",
      inputSchema: {
        projectId,
        rootFilePath: filePath.optional(),
        timeoutMs: z.number().int().min(1_000).max(15 * 60_000).optional(),
      },
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    handler(async (args: { projectId: string; rootFilePath?: string; timeoutMs?: number }) =>
      await runtime.compile.compileProject(args.projectId, args.rootFilePath, args.timeoutMs)
    )
  )
  server.registerTool(
    'stop_compile',
    {
      description: 'Stop the active Overleaf compile for a project.',
      inputSchema: { projectId },
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    handler(async ({ projectId }: { projectId: string }) =>
      await runtime.compile.stopCompile(projectId)
    )
  )
  server.registerTool(
    'list_comments',
    {
      description:
        'List reviewer-thread messages and lazily resolve document ranges. Defaults to open threads.',
      inputSchema: {
        projectId,
        filePath: z.string().min(1).optional(),
        status: z.enum(['open', 'resolved', 'all']).default('open'),
        author: z.string().min(1).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    handler(async (args: {
      projectId: string
      filePath?: string
      status: 'open' | 'resolved' | 'all'
      author?: string
    }) =>
      await runtime.comments.listComments(args.projectId, {
        status: args.status,
        ...(args.filePath === undefined ? {} : { filePath: args.filePath }),
        ...(args.author === undefined ? {} : { author: args.author }),
      })
    )
  )
  server.registerTool(
    'reply_to_comment',
    {
      description: 'Reply to an existing Overleaf review thread with timeout deduplication.',
      inputSchema: { projectId, threadId: z.string().min(1), content: z.string().min(1) },
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    handler(async (args: { projectId: string; threadId: string; content: string }) =>
      await runtime.comments.replyToComment(args.projectId, args.threadId, args.content)
    )
  )
  server.registerTool(
    'add_comment',
    {
      description:
        'Add and verify an anchored review comment using UTF-16 positions and expectedText.',
      inputSchema: {
        projectId,
        filePath,
        revision,
        start: position,
        end: position,
        expectedText: z.string().min(1),
        content: z.string().min(1),
      },
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    handler(async (args: AddCommentInput) => await runtime.comments.addComment(args))
  )
  server.registerTool(
    'set_comment_status',
    {
      description: 'Resolve or reopen a review thread and verify its resulting document revision.',
      inputSchema: {
        projectId,
        filePath,
        revision,
        threadId: z.string().min(1),
        status: z.enum(['open', 'resolved']),
      },
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    handler(async (args: {
      projectId: string
      filePath: string
      revision: string
      threadId: string
      status: 'open' | 'resolved'
    }) => await runtime.comments.setCommentStatus(args))
  )
  server.registerTool(
    'monitor_project_history',
    {
      description:
        'Poll one recent project-history window and return updates newer than an optional version cursor.',
      inputSchema: {
        projectId,
        sinceVersion: z.number().int().nonnegative().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    handler(async (args: { projectId: string; sinceVersion?: number }) =>
      await runtime.history.monitorProjectHistory(args.projectId, args.sinceVersion)
    )
  )
}
