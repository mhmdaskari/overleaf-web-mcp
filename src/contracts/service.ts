import type { AccessPolicy } from '../core/policy.js'
import type { AccountApi } from '../overleaf/account.js'
import type { CommentsApi } from '../overleaf/comments.js'
import type { CompileApi } from '../overleaf/compile.js'
import type { DocumentsApi, WriteFileResult, WriteMode } from '../overleaf/documents.js'
import type { EntitiesApi } from '../overleaf/entities.js'
import type { HistoryApi } from '../overleaf/history.js'
import type { ProjectsApi } from '../overleaf/projects.js'
import type { SearchApi } from '../overleaf/search.js'
import type { SectionsApi } from '../overleaf/sections-api.js'
import type { SyncApi } from '../overleaf/sync.js'
import type { TagsApi } from '../overleaf/tags.js'
import type { TrackedChangesApi } from '../overleaf/tracked-changes.js'
import type { OperationContext, ProgressReporter } from './context.js'
import type { OperationInput, OperationName, OperationOutput } from './operations.js'

/**
 * The domain engine an `OverleafService` runs on: the parts of `OverleafRuntime` the operations
 * reach Overleaf through. Tests and other backends supply their own.
 */
export interface OverleafServiceRuntime {
  authStatus(): Promise<OperationOutput<'auth_status'>>
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
  entities: Pick<EntitiesApi, 'getProjectTree' | 'manageEntity' | 'uploadFile' | 'downloadFile'>
  documents: Pick<DocumentsApi, 'readFile' | 'writeFile'>
  createFile(projectId: string, filePath: string, content?: string, writeMode?: WriteMode): Promise<WriteFileResult>
  sections: Pick<
    SectionsApi,
    'getFullDocument' | 'getSections' | 'getSectionContent' | 'writeSection' | 'checkReferences'
  >
  compile: Pick<
    CompileApi,
    'compileProject' | 'stopCompile' | 'downloadCompileOutput' | 'getCompileLog' | 'readCompileOutput'
  >
  comments: Pick<CommentsApi, 'listComments' | 'replyToComment' | 'addComment' | 'setCommentStatus'>
  trackedChanges: Pick<TrackedChangesApi, 'listTrackedChanges' | 'manageTrackedChanges'>
  history: Pick<HistoryApi, 'monitorProjectHistory'>
  sync: Pick<SyncApi, 'planSync' | 'syncDirectory' | 'deleteEntities' | 'batchUpload'>
  tags: Pick<TagsApi, 'manageTags'>
  search: Pick<SearchApi, 'searchProject'>
  /** Checks local paths the service reads itself; without one, only ids are checked. */
  policy?: AccessPolicy
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

/** What `sign_in` returns: the session it confirmed, or that the user is still signing in. */
export type SignInResult =
  | (OperationOutput<'auth_status'> & { status: 'signed_in'; alreadySignedIn: boolean })
  | { status: 'waiting'; deadline: string }

/**
 * A runtime that can open a browser window for the user to sign in, as `serve`'s does. The MCP
 * server offers `sign_in` only for a runtime that has this.
 */
export interface SignInCapable {
  signIn(onProgress?: ProgressReporter): Promise<SignInResult>
}

export function isSignInCapable(runtime: object): runtime is SignInCapable {
  return typeof (runtime as Partial<SignInCapable>).signIn === 'function'
}
