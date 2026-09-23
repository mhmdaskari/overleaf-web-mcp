import type { AppConfig } from './config.js'
import { AUTH_LOGIN_INSTRUCTION, McpError } from './core/errors.js'
import { parseBootstrapMeta, type BootstrapMeta } from './http/bootstrap.js'
import { OverleafHttpClient } from './http/client.js'
import { CookieStore } from './http/cookies.js'
import { createProxyRoute, type ProxyRoute } from './http/proxy.js'
import type { OverleafToolRuntime } from './mcp/tools.js'
import { AccountApi } from './overleaf/account.js'
import { CommentsApi } from './overleaf/comments.js'
import { CompileApi } from './overleaf/compile.js'
import { DocumentsApi, type WriteMode } from './overleaf/documents.js'
import { EntitiesApi } from './overleaf/entities.js'
import { HistoryApi } from './overleaf/history.js'
import { ProjectsApi } from './overleaf/projects.js'
import { SectionsApi } from './overleaf/sections-api.js'
import { resolveProjectPath, type EntityType } from './overleaf/tree.js'
import { ProjectConnectionCache } from './protocol/connection-cache.js'
import { openProjectConnection } from './protocol/connect.js'
import type { ProjectConnection } from './protocol/project-connection.js'

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface RuntimeDependencies {
  fetcher?: Fetcher
  connectionFactory?: (projectId: string) => Promise<ProjectConnection>
}

/**
 * Composes authenticated HTTP, cached collaboration sockets, and the domain APIs used by MCP tools.
 * Callers must close the runtime so cached sockets do not outlive the server process.
 */
export class OverleafRuntime implements OverleafToolRuntime {
  readonly config: AppConfig
  readonly cookieStore: CookieStore
  readonly http: OverleafHttpClient
  readonly account: AccountApi
  readonly entities: EntitiesApi
  readonly documents: DocumentsApi
  readonly sections: SectionsApi
  readonly compile: CompileApi
  readonly comments: CommentsApi
  readonly history: HistoryApi
  readonly projects: ProjectsApi
  readonly connections: ProjectConnectionCache<ProjectConnection>
  readonly userId?: string
  readonly #proxy: ProxyRoute | undefined

  private constructor(options: {
    config: AppConfig
    cookieStore: CookieStore
    http: OverleafHttpClient
    account: AccountApi
    entities: EntitiesApi
    documents: DocumentsApi
    sections: SectionsApi
    compile: CompileApi
    comments: CommentsApi
    history: HistoryApi
    projects: ProjectsApi
    connections: ProjectConnectionCache<ProjectConnection>
    userId?: string
    proxy?: ProxyRoute
  }) {
    this.config = options.config
    this.cookieStore = options.cookieStore
    this.http = options.http
    this.account = options.account
    this.entities = options.entities
    this.documents = options.documents
    this.sections = options.sections
    this.compile = options.compile
    this.comments = options.comments
    this.history = options.history
    this.projects = options.projects
    this.connections = options.connections
    if (options.userId !== undefined) this.userId = options.userId
    this.#proxy = options.proxy
  }

  static async create(
    config: AppConfig,
    dependencies: RuntimeDependencies = {}
  ): Promise<OverleafRuntime> {
    const cookieStore = await CookieStore.load(config.cookieJarFile)
    // One proxy decision, from readConfig, covers REST calls, the handshake, and the WebSocket.
    const proxy = config.proxyUrl === undefined ? undefined : createProxyRoute(config.proxyUrl)
    const fetcher = dependencies.fetcher ?? proxy?.fetcher
    const csrf = { token: undefined as string | undefined }
    const http = new OverleafHttpClient({
      baseUrl: config.baseUrl,
      jar: cookieStore.jar,
      defaultTimeoutMs: config.requestTimeoutMs,
      csrfToken: () => csrf.token,
      persistSetCookies: async (url, values) => await cookieStore.mergeSetCookies(url, values),
      ...(fetcher === undefined ? {} : { fetcher }),
    })

    let bootstrap: BootstrapMeta
    try {
      const bootstrapResponse = await http.request('GET', '/project')
      bootstrap = parseBootstrapMeta(await bootstrapResponse.text())
      if (!bootstrap.csrfToken) {
        throw new McpError(
          'AUTH_EXPIRED',
          `Overleaf did not expose an authenticated CSRF token. ${AUTH_LOGIN_INSTRUCTION}`
        )
      }
    } catch (error) {
      await proxy?.close()
      throw error
    }
    csrf.token = bootstrap.csrfToken

    // Sockets are cached per project, while each document is freshly joined inside its queued call.
    const factory = dependencies.connectionFactory ?? (async (projectId: string) =>
      await openProjectConnection({
        baseUrl: config.baseUrl,
        projectId,
        jar: cookieStore.jar,
        supportedProtocolVersions: config.supportedProtocolVersions,
        timeoutMs: config.requestTimeoutMs,
        applyTimeoutMs: config.applyTimeoutMs,
        ...(bootstrap.userId === undefined ? {} : { currentUserId: bootstrap.userId }),
        ...(fetcher === undefined ? {} : { fetcher }),
        ...(proxy === undefined ? {} : { webSocketAgent: proxy.webSocketAgent }),
      }))
    const connections = new ProjectConnectionCache<ProjectConnection>({
      capacity: config.socketCacheSize,
      idleTtlMs: config.socketIdleTtlMs,
      factory,
    })
    const account = new AccountApi(http)
    const documents = new DocumentsApi(connections, {
      maxDocLength: bootstrap.maxDocLength ?? config.maxDocLength,
      maxUpdateChars: config.maxUpdateChars,
      recoveryTimeoutMs: config.recoveryTimeoutMs,
      ...(bootstrap.userId === undefined ? {} : { currentUserId: bootstrap.userId }),
    })
    const entities = new EntitiesApi(http, connections)
    const sections = new SectionsApi(documents)
    // A fresh join before resolving, so a path is never looked up in a stale tree.
    const resolvePath = async (projectId: string, path: string, type: EntityType) => {
      await connections.invalidate(projectId)
      return await connections.withConnection(projectId, async connection =>
        await connection.queue.run(() => resolveProjectPath(connection.getTree(), path, type))
      )
    }
    const compile = new CompileApi(
      http,
      resolvePath,
      config.compileTimeoutMs,
      // Overleaf's own root document, so a compile that names no root matches the web UI.
      async projectId => {
        await connections.invalidate(projectId)
        return await entities.getRootDocument(projectId)
      }
    )
    const comments = new CommentsApi(http, connections, {
      maxUpdateChars: config.maxUpdateChars,
      recoveryTimeoutMs: config.recoveryTimeoutMs,
      ...(bootstrap.userId === undefined ? {} : { currentUserId: bootstrap.userId }),
    })
    const history = new HistoryApi(http)
    const projects = new ProjectsApi({
      http,
      baseUrl: config.baseUrl,
      findProject: async projectId => await account.findProject(projectId),
      resolvePath,
      getProjectTree: async projectId => await entities.getProjectTree(projectId),
      invalidate: async projectId => await connections.invalidate(projectId),
    })

    return new OverleafRuntime({
      config,
      cookieStore,
      http,
      account,
      entities,
      documents,
      sections,
      compile,
      comments,
      history,
      projects,
      connections,
      ...(bootstrap.userId === undefined ? {} : { userId: bootstrap.userId }),
      ...(proxy === undefined ? {} : { proxy }),
    })
  }

  async authStatus(): Promise<{
    authenticated: true
    baseUrl: string
    userId?: string
    projectCount: number
    /** When the session lapses unless a request refreshes it first; absent if no cookie has a deadline. */
    sessionExpiresAt?: string
    permissionsUnchecked: boolean
    warning?: string
    socketPresenceNotice: string
  }> {
    const projectCount = await this.account.countProjects()
    const sessionExpiresAt = await this.cookieStore.sessionExpiresAt(`${this.config.baseUrl}/project`)
    return {
      authenticated: true,
      baseUrl: this.config.baseUrl,
      ...(this.userId === undefined ? {} : { userId: this.userId }),
      projectCount,
      ...(sessionExpiresAt === undefined ? {} : { sessionExpiresAt }),
      permissionsUnchecked: this.cookieStore.permissions.permissionsUnchecked,
      ...(this.cookieStore.permissions.warning === undefined
        ? {}
        : { warning: this.cookieStore.permissions.warning }),
      socketPresenceNotice:
        'An active cached project socket can make this account appear online to collaborators until the idle timeout.',
    }
  }

  async createFile(
    projectId: string,
    filePath: string,
    content = '',
    writeMode: WriteMode = 'untracked'
  ): Promise<unknown> {
    if (writeMode === 'tracked' && content === '') {
      throw new McpError(
        'INVALID_ARGUMENT',
        'Tracked file creation requires non-empty initial content.'
      )
    }
    if (writeMode === 'tracked' && this.userId === undefined) {
      throw new McpError(
        'PROTOCOL_UNSUPPORTED',
        'Tracked writes require an authenticated Overleaf user ID from the project bootstrap.'
      )
    }
    await this.entities.createEmptyFile(projectId, filePath)
    const created = await this.documents.readFile(projectId, filePath)
    if (content !== '') {
      return await this.documents.writeFile(
        projectId,
        filePath,
        created.revision,
        content,
        writeMode
      )
    }
    return {
      revision: created.revision,
      protocol: created.protocol,
      trackChangesActive: created.trackChangesActive,
      writeMode: 'untracked' as const,
    }
  }

  async close(): Promise<void> {
    await this.connections.closeAll()
    await this.#proxy?.close()
  }
}
