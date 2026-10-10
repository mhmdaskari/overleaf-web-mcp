import { McpError } from '../core/errors.js'
import { AccessPolicy } from '../core/policy.js'
import type { ProjectEntity } from './tree.js'

export interface JsonPoster {
  postJson(
    path: string,
    body?: unknown,
    options?: { timeoutMs?: number }
  ): Promise<unknown>
}

export interface CompileResult {
  status: string
  outputFiles: Array<Record<string, unknown>>
  clsiServerId?: string
  validationProblems?: unknown
  /** The document actually compiled, whether named by the caller or taken from the project. */
  rootFilePath?: string
}

/** A status Overleaf reports is echoed only in this shape; anything else is `unrecognized`. */
const COMPILE_STATUS_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u

export class CompileApi {
  readonly #http: JsonPoster
  readonly #resolvePath: (projectId: string, path: string, type: 'doc') => Promise<ProjectEntity>
  readonly #defaultTimeoutMs: number
  readonly #resolveRootDocument:
    | ((projectId: string) => Promise<ProjectEntity | undefined>)
    | undefined
  readonly #policy: AccessPolicy

  constructor(
    http: JsonPoster,
    resolvePath: (projectId: string, path: string, type: 'doc') => Promise<ProjectEntity>,
    defaultTimeoutMs = 120_000,
    resolveRootDocument?: (projectId: string) => Promise<ProjectEntity | undefined>,
    policy: AccessPolicy = AccessPolicy.permissive
  ) {
    this.#http = http
    this.#resolvePath = resolvePath
    this.#defaultTimeoutMs = defaultTimeoutMs
    this.#resolveRootDocument = resolveRootDocument
    this.#policy = policy
  }

  /**
   * Compiles the project, defaulting to the root document configured in Overleaf itself.
   *
   * A blank Overleaf project ships with a stub `main.tex`, so a project whose real manuscript
   * lives under another name compiles the stub unless a root is named or configured.
   */
  async compileProject(
    projectId: string,
    rootFilePath?: string,
    timeoutMs = this.#defaultTimeoutMs
  ): Promise<CompileResult> {
    this.#policy.assertProject(projectId)
    this.#policy.assertEffect('compile')
    const boundedTimeout = Math.max(1_000, Math.min(timeoutMs, 15 * 60_000))
    const root =
      rootFilePath === undefined
        ? await this.#projectRootDocument(projectId)
        : await this.#resolvePath(projectId, rootFilePath, 'doc')
    const result = await this.#http.postJson(
      `/project/${encodeURIComponent(projectId)}/compile`,
      {
        rootDoc_id: root.id,
        check: 'silent',
        incrementalCompilesEnabled: true,
      },
      { timeoutMs: boundedTimeout }
    ) as CompileResult
    if (result.status !== 'success') {
      const status =
        typeof result.status === 'string' && COMPILE_STATUS_PATTERN.test(result.status) ? result.status : 'unrecognized'
      // details.result is deprecated and keeps only the status; 0.6.0 removes it.
      throw new McpError('COMPILE_FAILED', `Overleaf compile finished with status ${status}.`, {
        details: { status, rootFilePath: root.path, result: { status } },
      })
    }
    return { ...result, rootFilePath: root.path }
  }

  async #projectRootDocument(projectId: string): Promise<ProjectEntity> {
    const root = await this.#resolveRootDocument?.(projectId)
    if (root === undefined) {
      throw new McpError(
        'INVALID_ARGUMENT',
        'This project has no root document configured in Overleaf. Pass rootFilePath, or set one in the project settings.'
      )
    }
    return root
  }

  async stopCompile(projectId: string): Promise<{ stopped: true }> {
    this.#policy.assertProject(projectId)
    this.#policy.assertEffect('compile')
    await this.#http.postJson(`/project/${encodeURIComponent(projectId)}/compile/stop`, {})
    return { stopped: true }
  }
}
