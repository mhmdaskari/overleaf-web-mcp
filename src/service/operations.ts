import type { OperationContext, OperationDiagnostic } from '../contracts/context.js'
import type { OperationInput, OperationName } from '../contracts/operations.js'
import type { OperationHandler, OverleafService, OverleafServiceRuntime } from '../contracts/service.js'
import { asMcpError, McpError } from '../core/errors.js'
import { resolveTextContent } from '../core/local-file.js'
import { AccessPolicy } from '../core/policy.js'
import type { EntityAction } from '../overleaf/entities.js'
import type { ProjectAction } from '../overleaf/projects.js'

type Implementation<N extends OperationName> = (
  input: OperationInput<N>,
  context: OperationContext
) => Promise<unknown>

/**
 * Runs one operation so every interface sees the same failure: a typed `McpError`, reported to
 * `onDiagnostic` as the operation and its code only. The project the call names is checked
 * against the policy first, before any local or remote work; the domain engine then checks each
 * effect it performs.
 */
function guarded<N extends OperationName>(
  policy: AccessPolicy,
  name: N,
  run: Implementation<N>
): OperationHandler<N> {
  return (async (input: OperationInput<N>, context: OperationContext = {}) => {
    try {
      const fields = (input ?? {}) as { projectId?: unknown; sourceProjectId?: unknown }
      if (typeof fields.projectId === 'string') policy.assertProject(fields.projectId)
      if (typeof fields.sourceProjectId === 'string') policy.assertProject(fields.sourceProjectId, 'sourceProjectId')
      const result = await run(input ?? ({} as OperationInput<N>), context)
      const deprecations = (result as { deprecations?: unknown } | null)?.deprecations
      if (Array.isArray(deprecations) && deprecations.length > 0) notify(context, { tool: name, code: 'DEPRECATED' })
      return result
    } catch (error) {
      const failure = asMcpError(error)
      notify(context, { tool: name, code: failure.code })
      throw failure
    }
  }) as OperationHandler<N>
}

function notify(context: OperationContext, diagnostic: OperationDiagnostic): void {
  try {
    context.onDiagnostic?.(diagnostic)
  } catch {
    // A diagnostic that cannot be delivered never changes the call's outcome.
  }
}

function manageProjectAction(input: OperationInput<'manage_project'>): ProjectAction {
  if (input.action === 'rename' && input.newName !== undefined) {
    return { action: input.action, newName: input.newName }
  }
  if (
    (input.action === 'trash' || input.action === 'archive' || input.action === 'delete') &&
    input.confirmName !== undefined
  ) {
    return { action: input.action, confirmName: input.confirmName }
  }
  if (input.action === 'restore' || input.action === 'unarchive') return { action: input.action }
  throw new McpError('INVALID_ARGUMENT', `Missing fields for ${input.action}.`)
}

function manageEntityAction(input: OperationInput<'manage_entity'>): EntityAction {
  if (input.action === 'create_folder') return { action: input.action, path: input.path }
  if (input.action === 'rename' && input.newName !== undefined) {
    return { action: input.action, path: input.path, newName: input.newName }
  }
  if (input.action === 'move' && input.destinationFolderPath !== undefined) {
    return { action: input.action, path: input.path, destinationFolderPath: input.destinationFolderPath }
  }
  if (input.action === 'delete' && input.confirmPath !== undefined) {
    return { action: input.action, path: input.path, confirmPath: input.confirmPath }
  }
  throw new McpError('INVALID_ARGUMENT', `Missing fields for ${input.action}.`)
}

/**
 * Builds every operation over a domain runtime. Each one shapes its arguments for the domain
 * engine, which applies the access policy and every safety check; nothing here retries.
 *
 * Input is taken as the interface parsed it. The MCP server parses it against the contract's
 * schema before the call; a library caller is held to the same shape by the types.
 */
export function createOverleafService(runtime: OverleafServiceRuntime): OverleafService {
  const policy = runtime.policy ?? AccessPolicy.permissive
  const operation = <N extends OperationName>(name: N, run: Implementation<N>): OperationHandler<N> =>
    guarded(policy, name, run)
  return {
    auth_status: operation('auth_status', async () => await runtime.authStatus()),
    list_projects: operation('list_projects', async input => await runtime.account.listProjects(input)),
    create_project: operation('create_project', async input =>
      await runtime.projects.createProject(input.name, input.template)
    ),
    clone_project: operation('clone_project', async input =>
      await runtime.projects.cloneProject(input.sourceProjectId, input.name)
    ),
    import_project_zip: operation('import_project_zip', async input =>
      await runtime.projects.importProjectZip(input.localZipPath, input.name)
    ),
    manage_project: operation('manage_project', async input =>
      await runtime.projects.manageProject(input.projectId, manageProjectAction(input))
    ),
    update_project_settings: operation('update_project_settings', async input =>
      await runtime.projects.updateProjectSettings(input.projectId, {
        rootFilePath: input.rootFilePath,
        compiler: input.compiler,
        imageName: input.imageName,
        spellCheckLanguage: input.spellCheckLanguage,
      })
    ),
    get_project_tree: operation('get_project_tree', async input =>
      await runtime.entities.getProjectTree(input.projectId)
    ),
    read_file: operation('read_file', async input =>
      await runtime.documents.readFile(input.projectId, input.filePath)
    ),
    write_file: operation('write_file', async input =>
      await runtime.documents.writeFile(
        input.projectId,
        input.filePath,
        input.revision,
        await resolveTextContent(input, runtime.policy),
        input.writeMode
      )
    ),
    create_file: operation('create_file', async input =>
      await runtime.createFile(input.projectId, input.filePath, input.content, input.writeMode)
    ),
    manage_entity: operation('manage_entity', async input =>
      await runtime.entities.manageEntity(input.projectId, manageEntityAction(input))
    ),
    upload_file: operation('upload_file', async input =>
      await runtime.entities.uploadFile(input.projectId, input.localPath, input.destinationFolderPath, input.destinationName, {
        overwrite: input.overwrite,
        expectedHash: input.expectedHash,
        uncheckedDocumentReplace: input.uncheckedDocumentReplace,
      })
    ),
    batch_upload: operation('batch_upload', async (input, context) =>
      await runtime.sync.batchUpload(input.projectId, input.files, {
        onConflict: input.onConflict,
        uncheckedDocumentReplace: input.uncheckedDocumentReplace,
        stopOnError: input.stopOnError,
        onProgress: context.onProgress,
      })
    ),
    download_file: operation('download_file', async input =>
      await runtime.entities.downloadFile(input.projectId, input.filePath, input.localPath, input.overwrite)
    ),
    download_project_zip: operation('download_project_zip', async input =>
      await runtime.projects.downloadProjectZip(input.projectId, input.localPath, {
        overwrite: input.overwrite,
        timeoutMs: input.timeoutMs,
      })
    ),
    plan_sync: operation('plan_sync', async (input, context) =>
      await runtime.sync.planSync(input.projectId, input.localFolderPath, {
        destinationFolderPath: input.destinationFolderPath,
        ignore: input.ignore,
        verbose: input.verbose,
        onProgress: context.onProgress,
      })
    ),
    sync_directory: operation('sync_directory', async (input, context) =>
      await runtime.sync.syncDirectory(input.projectId, input.localFolderPath, {
        mode: input.mode,
        destinationFolderPath: input.destinationFolderPath,
        planToken: input.planToken,
        unplanned: input.unplanned,
        confirmDeleteCount: input.confirmDeleteCount,
        ignore: input.ignore,
        writeMode: input.writeMode,
        stopOnError: input.stopOnError,
        onProgress: context.onProgress,
      })
    ),
    delete_entities: operation('delete_entities', async (input, context) =>
      await runtime.sync.deleteEntities(input.projectId, input.paths, input.confirmCount, {
        stopOnError: input.stopOnError,
        onProgress: context.onProgress,
      })
    ),
    get_sections: operation('get_sections', async input =>
      await runtime.sections.getSections(input.projectId, input.filePath)
    ),
    get_section_content: operation('get_section_content', async input =>
      await runtime.sections.getSectionContent(input.projectId, input.filePath, input.sectionId)
    ),
    write_section: operation('write_section', async input =>
      await runtime.sections.writeSection(
        input.projectId,
        input.filePath,
        input.revision,
        input.sectionId,
        input.content,
        input.writeMode
      )
    ),
    compile_project: operation('compile_project', async input =>
      await runtime.compile.compileProject(input.projectId, input.rootFilePath, input.timeoutMs)
    ),
    stop_compile: operation('stop_compile', async input => await runtime.compile.stopCompile(input.projectId)),
    list_comments: operation('list_comments', async input =>
      await runtime.comments.listComments(input.projectId, {
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.filePath === undefined ? {} : { filePath: input.filePath }),
        ...(input.author === undefined ? {} : { author: input.author }),
      })
    ),
    reply_to_comment: operation('reply_to_comment', async input =>
      await runtime.comments.replyToComment(input.projectId, input.threadId, input.content)
    ),
    add_comment: operation('add_comment', async input => await runtime.comments.addComment(input)),
    set_comment_status: operation('set_comment_status', async input =>
      await runtime.comments.setCommentStatus(input)
    ),
    monitor_project_history: operation('monitor_project_history', async input =>
      await runtime.history.monitorProjectHistory(input.projectId, input.sinceVersion)
    ),
  }
}
