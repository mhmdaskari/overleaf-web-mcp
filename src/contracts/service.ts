import type { AccountApi } from '../overleaf/account.js'
import type { CommentsApi } from '../overleaf/comments.js'
import type { CompileApi } from '../overleaf/compile.js'
import type { DocumentsApi, WriteMode } from '../overleaf/documents.js'
import type { EntitiesApi } from '../overleaf/entities.js'
import type { HistoryApi } from '../overleaf/history.js'
import type { ProjectsApi } from '../overleaf/projects.js'
import type { SectionsApi } from '../overleaf/sections-api.js'
import type { SyncApi } from '../overleaf/sync.js'
import type { OperationContext } from './context.js'
import type { OperationInput, OperationName, OperationOutput } from './operations.js'

/**
 * The domain engine an `OverleafService` runs on: the parts of `OverleafRuntime` the operations
 * reach Overleaf through. Tests and other backends supply their own.
 */
export interface OverleafServiceRuntime {
  authStatus(): Promise<Record<string, unknown>>
  account: Pick<AccountApi, 'listProjects'>
  projects: Pick<
    ProjectsApi,
    | 'createProject'
    | 'cloneProject'
    | 'importProjectZip'
    | 'downloadProjectZip'
    | 'manageProject'
    | 'updateProjectSettings'
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
  sync: Pick<SyncApi, 'planSync' | 'syncDirectory' | 'deleteEntities' | 'batchUpload'>
}

/** One operation: input as its contract describes it, resolving with its result or rejecting with `McpError`. */
export type OperationHandler<N extends OperationName> = (
  input: OperationInput<N>,
  context?: OperationContext
) => Promise<OperationOutput<N>>

/**
 * Every operation, keyed by its id. Each one shapes its arguments for the domain engine and
 * nothing else; interfaces parse input against the contract, render the result, and map errors.
 */
export type OverleafService = { readonly [N in OperationName]: OperationHandler<N> }
