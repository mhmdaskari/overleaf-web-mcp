import { z } from 'zod'

import { DEFAULT_PROJECT_LIMIT, MAX_PROJECT_LIMIT } from '../overleaf/account.js'
import { COMPILERS, DEFAULT_ZIP_DOWNLOAD_TIMEOUT_MS } from '../overleaf/projects.js'
import { BATCH_UPLOAD_LIMIT } from '../overleaf/sync.js'
import type { Effect } from './effects.js'

/**
 * Operation ids, in registration order. They are the MCP tool names and, from v0.7.0, the CLI
 * and SDK names.
 */
export const OPERATION_NAMES = [
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
  'batch_upload',
  'download_file',
  'download_project_zip',
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

export type OperationName = (typeof OPERATION_NAMES)[number]

/** MCP tool annotations. `readOnlyHint` means nothing changes on Overleaf and nothing is written locally. */
export interface OperationAnnotations {
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
}

/** One operation, defined once for every interface. */
export interface OperationContract {
  /** Self-sufficient: it, plus the server instructions, is what an agent reads at runtime. */
  description: string
  /** Absent for an operation without parameters. */
  inputSchema?: z.ZodObject
  /** Present when the result is returned as validated structured content. */
  outputSchema?: z.ZodObject
  annotations: OperationAnnotations
  /** Everything the operation can do; the access policy refuses it before any work otherwise. */
  effects: readonly Effect[]
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
const batchUploadActionSchema = z.enum(['create_folder', 'upload'])
const deprecationsSchema = z
  .array(z.object({ parameter: z.string(), message: z.string(), enforcedIn: z.string() }))
  .optional()
const uncheckedDocumentReplace = z
  .boolean()
  .optional()
  .describe(
    'Allow replacing a text document, a blind write with no revision check; prefer write_file with localPath when a collaborator may be editing'
  )

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

const createdProjectSchema = z.object({
  projectId: z.string(),
  name: z.string(),
  url: z.string(),
})

const projectActionSchema = z.enum(['rename', 'trash', 'restore', 'archive', 'unarchive', 'delete'])

export const OPERATIONS = {
  auth_status: {
    description:
      'Verify the saved Overleaf web session without exposing cookies. sessionExpiresAt is when the session lapses unless a request refreshes it first; Overleaf sessions last five days from their last use, and the CLI command `overleaf-web-mcp keepalive` can be scheduled to refresh them.',
    outputSchema: z.object({
      authenticated: z.literal(true),
      baseUrl: z.string(),
      userId: z.string().optional(),
      projectCount: z.number().int().nonnegative(),
      sessionExpiresAt: z.string().optional(),
      permissionsUnchecked: z.boolean(),
      warning: z.string().optional(),
      socketPresenceNotice: z.string(),
    }),
    annotations: { readOnlyHint: true },
    effects: ['overleaf-read'],
  },
  list_projects: {
    description:
      'List the projects the account can access, newest first by default. Archived and trashed projects are hidden unless includeArchived or includeTrashed is set. Returns projects with id, name, accessLevel, lastUpdated, archived, and trashed, plus totalMatched (before limit) and totalProjects (everything the account can access).',
    inputSchema: z.object({
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
    }),
    outputSchema: z.object({
      projects: z.array(projectSummarySchema),
      totalMatched: z.number().int(),
      totalProjects: z.number().int(),
    }),
    annotations: { readOnlyHint: true },
    effects: ['overleaf-read'],
  },
  create_project: {
    description:
      'Create a new Overleaf project and return its projectId, url, and rootDocPath. A "blank" project still contains Overleaf\'s stub main.tex as its root document; after importing your own manuscript, point the project at it with update_project_settings or delete the stub with manage_entity. "example" seeds Overleaf\'s example paper.',
    inputSchema: z.object({
      name: projectName,
      template: z.enum(['blank', 'example']).default('blank'),
    }),
    outputSchema: createdProjectSchema.extend({ rootDocPath: z.string().optional() }),
    annotations: { destructiveHint: false, idempotentHint: false },
    effects: ['project-lifecycle', 'overleaf-read'],
  },
  clone_project: {
    description:
      'Copy an existing project, including its files and settings, into a new project with the given name. Use it to start from a lab or journal template project.',
    inputSchema: z.object({ sourceProjectId: projectId.describe('Project to copy'), name: projectName }),
    outputSchema: createdProjectSchema,
    annotations: { destructiveHint: false, idempotentHint: false },
    effects: ['project-lifecycle'],
  },
  import_project_zip: {
    description:
      'Create a new project from a local .zip archive of LaTeX sources. name defaults to the archive file name. Overleaf caps archives at about 50 MB and rate-limits this route: RATE_LIMITED means wait details.retryAfterMs before trying again, and nothing was created. Set the root document afterwards with update_project_settings if the archive has more than one .tex file at the top level.',
    inputSchema: z.object({
      localZipPath: z.string().min(1).describe('Local path of a .zip archive'),
      name: projectName.optional(),
    }),
    outputSchema: createdProjectSchema,
    annotations: { destructiveHint: false, idempotentHint: false },
    effects: ['local-read', 'project-lifecycle'],
  },
  manage_project: {
    description:
      'Rename, trash, restore, archive, unarchive, or permanently delete a project. trash, archive, and delete require confirmName to equal the current project name exactly, else CONFIRMATION_MISMATCH and nothing changes. trash is the normal way to remove a project and is reversible with restore or in the web UI. delete is permanent and only succeeds on a project that is already trashed. Confirm with the user before trashing or deleting.',
    inputSchema: z.object({
      projectId,
      action: projectActionSchema,
      newName: projectName.optional().describe('New name, for rename'),
      confirmName: z
        .string()
        .optional()
        .describe('Current project name, repeated exactly, for trash, archive, and delete'),
    }),
    outputSchema: z.object({
      action: projectActionSchema,
      projectId: z.string(),
      name: z.string(),
    }),
    annotations: { destructiveHint: true, idempotentHint: false },
    effects: ['project-lifecycle', 'overleaf-read', 'overleaf-delete'],
  },
  update_project_settings: {
    description:
      "Persist the project's root document, TeX engine, TeX Live image, or spell-check language in Overleaf's own project settings, so the web UI's Recompile follows the change. rootFilePath must name an existing text document. Returns the settings as re-read from the project. Provide at least one field.",
    inputSchema: z.object({
      projectId,
      rootFilePath: filePath.optional().describe('Document Overleaf should compile by default'),
      compiler: z.enum(COMPILERS).optional(),
      imageName: z.string().min(1).optional().describe('TeX Live image, as shown in Overleaf\'s menu'),
      spellCheckLanguage: z
        .string()
        .optional()
        .describe('Overleaf language code such as en or de; an empty string turns spell checking off'),
    }),
    outputSchema: z.object({
      projectId: z.string(),
      rootDocPath: z.string().optional(),
      compiler: z.string().optional(),
      imageName: z.string().optional(),
      spellCheckLanguage: z.string().optional(),
    }),
    annotations: { destructiveHint: false, idempotentHint: true },
    effects: ['project-lifecycle', 'overleaf-read'],
  },
  get_project_tree: {
    description:
      'Return the project file/folder tree with entity IDs and paths, plus the root document, compiler, TeX Live image, and spell-check language Overleaf uses. Each binary file entity carries hash, a git blob hash equal to `git hash-object <file>`; text documents have no hash and must be compared by reading their content.',
    inputSchema: z.object({ projectId }),
    annotations: { readOnlyHint: true },
    effects: ['overleaf-read'],
  },
  read_file: {
    description: 'Read a text document as LF-normalized content and return its opaque revision.',
    inputSchema: z.object({ projectId, filePath }),
    annotations: { readOnlyHint: true },
    effects: ['overleaf-read'],
  },
  write_file: {
    description:
      'Replace a text document using a minimal verified OT edit, optionally recorded as tracked changes. Supply the new text either inline through content or from disk through localPath, never both; localPath keeps a whole-file replacement revision-checked without sending the file through the tool call.',
    inputSchema: z.object({
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
    }),
    annotations: { destructiveHint: true, idempotentHint: false },
    effects: ['local-read', 'overleaf-write'],
  },
  create_file: {
    description:
      'Create a text document and optionally record non-empty initial content as tracked changes.',
    inputSchema: z.object({ projectId, filePath, content: z.string().optional(), writeMode }),
    annotations: { destructiveHint: false, idempotentHint: false },
    effects: ['overleaf-write', 'overleaf-read'],
  },
  manage_entity: {
    description:
      'Create a folder, rename, move, or delete an entity. Deletion requires confirmPath to exactly equal path.',
    inputSchema: z.object({
      projectId,
      action: z.enum(['create_folder', 'rename', 'move', 'delete']),
      path: filePath,
      newName: z.string().min(1).optional(),
      destinationFolderPath: z.string().optional(),
      confirmPath: z.string().optional(),
    }),
    annotations: { destructiveHint: true, idempotentHint: false },
    effects: ['overleaf-write', 'overleaf-delete'],
  },
  upload_file: {
    description:
      'Upload a local file into a project folder. Overleaf decides whether it becomes a text document or a binary file, by extension and UTF-8 validity. Something already at the path is replaced: a replaced text document keeps its entity ID; a replaced binary file may get a new one. Replacing a binary needs overwrite: true, or expectedHash equal to its hash from get_project_tree; overwrite: false refuses with CONFIRMATION_MISMATCH and a different hash with REMOTE_DRIFT, nothing sent. expectedHash is checked just before the upload, not atomically with it. Replacing a text document is a blind write with no revision check: prefer write_file with localPath, and pass uncheckedDocumentReplace: true only when nobody else is editing it. writeMode in the result is tracked when Overleaf records that replacement as tracked changes, because track changes is on for this account. Until 0.6.0 a replacement without these parameters still happens and the result lists deprecations; from 0.6.0 it is refused.',
    inputSchema: z.object({
      projectId,
      localPath: z.string().min(1),
      destinationFolderPath: z.string().default(''),
      destinationName: z
        .string()
        .min(1)
        .optional()
        .describe('Name to store the file under; defaults to the local file name'),
      overwrite: z
        .boolean()
        .optional()
        .describe('true allows replacing a binary file at the path; false refuses to replace anything'),
      expectedHash: z
        .string()
        .regex(/^[0-9a-f]{40}$/u)
        .optional()
        .describe('The hash get_project_tree reported for the binary file being replaced; a different one is REMOTE_DRIFT'),
      uncheckedDocumentReplace,
    }),
    outputSchema: z.object({
      entityId: z.string().optional(),
      entityType: z.enum(['doc', 'file']).optional(),
      path: z.string(),
      replaced: z.boolean(),
      hash: z.string().optional(),
      trackChangesActive: z.boolean(),
      writeMode: z.enum(['untracked', 'tracked']),
      deprecations: deprecationsSchema,
    }),
    annotations: { destructiveHint: true, idempotentHint: false },
    effects: ['local-read', 'overleaf-write', 'unchecked-replace'],
  },
  batch_upload: {
    description:
      'Upload a list of local files to explicit project paths in one call, instead of one upload_file call per file. Each destinationPath is the full project path including the file name; missing folders are created. onConflict "overwrite" replaces a binary file already at the path; "skip" leaves an existing document or file untouched and lists it in skipped. Pass onConflict explicitly: omitted, it still overwrites, but from 0.6.0 no default replaces anything, and the result lists deprecations when it did. A folder at a destination path, or a file where a folder is needed, fails that file in either mode. Replacing a text document has no revision check, so use write_file or sync_directory for documents a collaborator may be editing; pass uncheckedDocumentReplace: true to replace them anyway, since without it a replaced document is listed in deprecations, and refused from 0.6.0. Every path is checked before anything is sent: a duplicate destination or a missing local file fails the call with nothing uploaded. Failures are per file and nothing is retried: the call continues past a failure unless stopOnError, and stops at RATE_LIMITED (Overleaf allows about 500 uploads per project in 15 minutes). It returns status, completed (with replaced per upload), skipped, failed, remaining, and verified, which is true when the tree read back afterwards confirmed every completed entry. A timed-out upload is classified from that read-back, never resubmitted: recoveredAfterTimeout when the path holds the local bytes, OUTCOME_UNKNOWN when the tree cannot tell. It saves tool calls, not time. Confirm overwrites with the user first.',
    inputSchema: z.object({
      projectId,
      files: z
        .array(
          z.object({
            localPath: z.string().min(1).describe("File on the server's own disk"),
            destinationPath: filePath.describe('Project path to upload to, including the file name'),
          })
        )
        .min(1)
        .max(BATCH_UPLOAD_LIMIT)
        .describe(`Files to upload, in order; at most ${BATCH_UPLOAD_LIMIT}`),
      onConflict: z
        .enum(['skip', 'overwrite'])
        .optional()
        .describe('What to do when something is already at a destination path; omitted, overwrite, which is deprecated'),
      uncheckedDocumentReplace,
      stopOnError: z.boolean().default(false).describe('Stop at the first failure instead of continuing'),
    }),
    outputSchema: z.object({
      status: z.enum(['complete', 'partial']),
      onConflict: z.enum(['skip', 'overwrite']),
      completed: z.array(
        z.object({
          destinationPath: z.string(),
          action: batchUploadActionSchema,
          entityId: z.string().optional(),
          entityType: z.enum(['doc', 'file']).optional(),
          replaced: z.boolean().optional(),
          recoveredAfterTimeout: z.literal(true).optional(),
        })
      ),
      skipped: z.array(
        z.object({ destinationPath: z.string(), localPath: z.string(), entityType: z.enum(['doc', 'file']) })
      ),
      failed: z.array(
        z.object({
          destinationPath: z.string(),
          action: batchUploadActionSchema,
          errorCode: errorCodeSchema,
          message: z.string(),
        })
      ),
      remaining: z.array(z.object({ destinationPath: z.string(), action: batchUploadActionSchema })),
      verified: z.boolean(),
      deprecations: deprecationsSchema,
    }),
    annotations: { destructiveHint: true, idempotentHint: false },
    effects: ['local-read', 'overleaf-read', 'overleaf-write', 'unchecked-replace'],
  },
  download_file: {
    description:
      'Download one Overleaf document or binary file to an explicit local path. Refuses to replace an existing local file unless overwrite is set.',
    inputSchema: z.object({
      projectId,
      filePath,
      localPath: z.string().min(1),
      overwrite: z.boolean().default(false).describe('Replace localPath if it already exists'),
    }),
    // It writes a local file and can replace one, so it is not read-only.
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    effects: ['overleaf-read', 'local-write'],
  },
  download_project_zip: {
    description:
      'Download the whole project, sources and binaries, as one zip archive (Overleaf\'s "Download as zip") to a local path on the server\'s own disk. The folder must exist. An existing file is replaced only when overwrite is true, else CONFIRMATION_MISMATCH and nothing is downloaded; a replacement is atomic, so a failed or incomplete download leaves the old file intact. Offer it as a backup before a mirror sync_directory or an overwriting batch_upload. Overleaf allows about 10 downloads per project a minute, so on RATE_LIMITED wait a minute. PERMISSION_DENIED here can also mean the session expired; check auth_status. Returns the absolute localPath, bytes, and replaced.',
    inputSchema: z.object({
      projectId,
      localPath: z.string().min(1).describe('Local file to write the archive to, for example backup.zip'),
      overwrite: z.boolean().default(false).describe('Replace localPath if it already exists'),
      timeoutMs: z
        .number()
        .int()
        .min(1_000)
        .max(15 * 60_000)
        .optional()
        .describe(`Limit for the whole download; defaults to ${DEFAULT_ZIP_DOWNLOAD_TIMEOUT_MS / 60_000} minutes`),
    }),
    outputSchema: z.object({
      projectId: z.string(),
      localPath: z.string(),
      bytes: z.number().int().nonnegative(),
      replaced: z.boolean(),
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    effects: ['overleaf-read', 'local-write'],
  },
  plan_sync: {
    description:
      "Compare a local folder with a project folder and report what sync_directory would do, changing nothing. Binary files compare by git blob hash at no cost; each text document with a local counterpart, or present only in the project, is read once through the project's queue, so this suits tens of documents, not thousands. Returns toUpload (new or changed), identical (a count and the first 25 paths unless verbose), remoteOnly (what mirror mode would delete, each folder collapsed to one entry that includes its contents), conflicts (a file where the other side has a folder, or non-UTF-8 text where the project has a document; sync_directory cannot apply these), ignored, and planToken. Show the plan to the user before syncing. localFolderPath is on the server's disk; a symbolic link that leads outside it fails with PATH_OUTSIDE_ROOT.",
    inputSchema: z.object({
      projectId,
      localFolderPath,
      destinationFolderPath,
      ignore: ignorePatterns,
      verbose: z
        .boolean()
        .default(false)
        .describe('List every identical path and ignored entry instead of the first 25'),
    }),
    outputSchema: z.object({
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
    }),
    annotations: { readOnlyHint: true },
    effects: ['local-read', 'overleaf-read'],
  },
  sync_directory: {
    description:
      "Make a project folder match a local folder: upload new and changed files, and in mirror mode also delete what exists only in the project. Call plan_sync first, confirm the plan with the user, and pass its planToken; if the project or the folder changed since, REMOTE_DRIFT is returned and nothing changes. Without a planToken nothing is checked against a plan: the call still runs in this version, with planned false and a deprecations entry, and from 0.6.0 it is refused unless an additive sync passes unplanned: true. Changed text documents are replaced through revision-checked write_file edits, recorded as tracked changes when writeMode is tracked, so a concurrent edit fails that file with REVISION_CONFLICT rather than being overwritten. Binaries and new files are uploaded, and one whose path changed since the plan fails with REMOTE_DRIFT; with writeMode tracked, new .tex, .bib, and similar text files are created with tracked content instead. Missing folders are created. Uploads and writes run first. Deletes run only in mirror mode, only when confirmDeleteCount equals the number of remoteOnly entries, else CONFIRMATION_MISMATCH, and never after any upload or write failed. Failures are per file and nothing is retried: the call continues unless stopOnError, then returns status, completed, failed, remaining, and a planToken to resume with. It saves tool calls, not time.",
    inputSchema: z.object({
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
      unplanned: z
        .boolean()
        .optional()
        .describe('Run an additive sync without a planToken on purpose; never with a planToken or in mirror mode'),
      confirmDeleteCount: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe("Required in mirror mode: the number of entries in plan_sync's remoteOnly, each folder counting once"),
      ignore: ignorePatterns,
      writeMode,
      stopOnError: z.boolean().default(false).describe('Stop at the first failure instead of continuing'),
    }),
    outputSchema: z.object({
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
      planned: z.boolean(),
      deprecations: deprecationsSchema,
    }),
    annotations: { destructiveHint: true, idempotentHint: true },
    effects: ['local-read', 'overleaf-read', 'overleaf-write', 'overleaf-delete'],
  },
  delete_entities: {
    description:
      'Delete several documents, files, or folders in one call. confirmCount must equal the number of paths, else CONFIRMATION_MISMATCH. Every path is resolved before anything is deleted, so a missing one fails the call with NOT_FOUND and changes nothing. Deleting a folder removes everything inside it, so list the folder alone, not its contents too. Continues past a failed delete unless stopOnError, and returns status, completed, failed, and remaining. Confirm the list with the user first.',
    inputSchema: z.object({
      projectId,
      paths: z.array(filePath).min(1).max(500).describe('Project paths to delete'),
      confirmCount: z
        .number()
        .int()
        .positive()
        .describe('The number of paths, repeated after confirming the list with the user'),
      stopOnError: z.boolean().default(false).describe('Stop at the first failure instead of continuing'),
    }),
    outputSchema: z.object({
      status: z.enum(['complete', 'partial']),
      completed: z.array(z.object({ path: z.string(), type: entityTypeSchema, entityId: z.string() })),
      failed: z.array(z.object({ path: z.string(), errorCode: errorCodeSchema, message: z.string() })),
      remaining: z.array(z.object({ path: z.string() })),
    }),
    annotations: { destructiveHint: true, idempotentHint: false },
    effects: ['overleaf-read', 'overleaf-delete'],
  },
  get_sections: {
    description:
      'Parse LaTeX section headings in one file only; this never follows input/include directives.',
    inputSchema: z.object({ projectId, filePath }),
    annotations: { readOnlyHint: true },
    effects: ['overleaf-read'],
  },
  get_section_content: {
    description: 'Read one parsed section body from a single file.',
    inputSchema: z.object({ projectId, filePath, sectionId: z.string().min(1) }),
    annotations: { readOnlyHint: true },
    effects: ['overleaf-read'],
  },
  write_section: {
    description:
      'Replace one section body in a single file using a revision-checked write, optionally recorded as tracked changes. Included files are not traversed.',
    inputSchema: z.object({
      projectId,
      filePath,
      revision,
      sectionId: z.string().min(1),
      content: z.string(),
      writeMode,
    }),
    annotations: { destructiveHint: true, idempotentHint: false },
    effects: ['overleaf-read', 'overleaf-write'],
  },
  compile_project: {
    description:
      "Compile a project. Omit rootFilePath to build the root document configured in Overleaf, which is what the web UI's Recompile button uses; pass it to build a different document for this call only.",
    inputSchema: z.object({
      projectId,
      rootFilePath: filePath.optional(),
      timeoutMs: z.number().int().min(1_000).max(15 * 60_000).optional(),
    }),
    annotations: { destructiveHint: false, idempotentHint: false },
    effects: ['compile'],
  },
  stop_compile: {
    description: 'Stop the active Overleaf compile for a project.',
    inputSchema: z.object({ projectId }),
    annotations: { destructiveHint: true, idempotentHint: true },
    effects: ['compile'],
  },
  list_comments: {
    description:
      'List reviewer-thread messages and lazily resolve document ranges. Defaults to open threads.',
    inputSchema: z.object({
      projectId,
      filePath: z.string().min(1).optional(),
      status: z.enum(['open', 'resolved', 'all']).default('open'),
      author: z.string().min(1).optional(),
    }),
    annotations: { readOnlyHint: true },
    effects: ['overleaf-read'],
  },
  reply_to_comment: {
    description: 'Reply to an existing Overleaf review thread with timeout deduplication.',
    inputSchema: z.object({ projectId, threadId: z.string().min(1), content: z.string().min(1) }),
    annotations: { destructiveHint: false, idempotentHint: false },
    effects: ['overleaf-write', 'overleaf-read'],
  },
  add_comment: {
    description:
      'Add and verify an anchored review comment using UTF-16 positions and expectedText.',
    inputSchema: z.object({
      projectId,
      filePath,
      revision,
      start: position,
      end: position,
      expectedText: z.string().min(1),
      content: z.string().min(1),
    }),
    annotations: { destructiveHint: false, idempotentHint: false },
    effects: ['overleaf-write', 'overleaf-read'],
  },
  set_comment_status: {
    description: 'Resolve or reopen a review thread and verify its resulting document revision.',
    inputSchema: z.object({
      projectId,
      filePath,
      revision,
      threadId: z.string().min(1),
      status: z.enum(['open', 'resolved']),
    }),
    annotations: { destructiveHint: true, idempotentHint: true },
    effects: ['overleaf-write'],
  },
  monitor_project_history: {
    description:
      'Poll one recent project-history window and return updates newer than an optional version cursor.',
    inputSchema: z.object({
      projectId,
      sinceVersion: z.number().int().nonnegative().optional(),
    }),
    annotations: { readOnlyHint: true },
    effects: ['overleaf-read'],
  },
} as const satisfies Record<OperationName, OperationContract>

type Operations = typeof OPERATIONS

/** What an operation accepts: its input schema's input type, so defaulted fields may be left out. */
export type OperationInput<N extends OperationName> = Operations[N] extends { inputSchema: infer S extends z.ZodType }
  ? z.input<S>
  : Record<string, never>

/** What an operation resolves with: its output schema's type, or `unknown` until it declares one (v0.7.0). */
export type OperationOutput<N extends OperationName> = Operations[N] extends { outputSchema: infer S extends z.ZodType }
  ? z.output<S>
  : unknown

/** The contract entry for an operation, typed as the general shape. */
export function operationContract(name: OperationName): OperationContract {
  return OPERATIONS[name]
}
