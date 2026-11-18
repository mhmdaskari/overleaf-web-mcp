import { stat } from 'node:fs/promises'

import type { AppConfig } from './config.js'
import type { OverleafServiceRuntime } from './contracts/service.js'
import { AUTH_LOGIN_INSTRUCTION, McpError } from './core/errors.js'
import type { AccessPolicy } from './core/policy.js'
import { createAccessPolicy, OverleafRuntime } from './runtime.js'

type ClosableRuntime = OverleafServiceRuntime & { close(): Promise<void> }

type Group = Exclude<keyof OverleafServiceRuntime, 'authStatus' | 'createFile' | 'policy'>

/**
 * Every member of `OverleafServiceRuntime`, as `[group, method]`, with `''` for a top-level method.
 * `test/session-runtime.test.ts` holds it to the fake runtime, so a member added to the interface
 * and not here fails a test.
 */
export const SESSION_RUNTIME_MEMBERS = [
  ['', 'authStatus'],
  ['', 'createFile'],
  ['account', 'listProjects'],
  ['projects', 'createProject'],
  ['projects', 'cloneProject'],
  ['projects', 'importProjectZip'],
  ['projects', 'downloadProjectZip'],
  ['projects', 'manageProject'],
  ['projects', 'updateProjectSettings'],
  ['entities', 'getProjectTree'],
  ['entities', 'manageEntity'],
  ['entities', 'uploadFile'],
  ['entities', 'downloadFile'],
  ['documents', 'readFile'],
  ['documents', 'writeFile'],
  ['sections', 'getFullDocument'],
  ['sections', 'getSections'],
  ['sections', 'getSectionContent'],
  ['sections', 'writeSection'],
  ['compile', 'compileProject'],
  ['compile', 'stopCompile'],
  ['compile', 'downloadCompileOutput'],
  ['compile', 'getCompileLog'],
  ['compile', 'readCompileOutput'],
  ['comments', 'listComments'],
  ['comments', 'replyToComment'],
  ['comments', 'addComment'],
  ['comments', 'setCommentStatus'],
  ['trackedChanges', 'listTrackedChanges'],
  ['trackedChanges', 'manageTrackedChanges'],
  ['history', 'monitorProjectHistory'],
  ['sync', 'planSync'],
  ['sync', 'syncDirectory'],
  ['sync', 'deleteEntities'],
  ['sync', 'batchUpload'],
  ['tags', 'manageTags'],
  ['search', 'searchProject'],
] as const satisfies ReadonlyArray<
  readonly ['', 'authStatus' | 'createFile'] | { [G in Group]: readonly [G, keyof OverleafServiceRuntime[G]] }[Group]
>

export interface SessionRuntimeOptions {
  /** Opens a runtime from the saved session; `OverleafRuntime.create` by default. */
  createRuntime?: (config: AppConfig) => Promise<ClosableRuntime>
  /** The session file's modification time, or undefined when there is none; read from disk by default. */
  sessionFileStamp?: (path: string) => Promise<number | undefined>
  /** Whether MCP clients are offered `sign_in`, so messages name it only then. */
  signInOffered?: boolean
}

/** One opened runtime and the calls still running on it, so a retired one closes only once idle. */
interface Lease {
  readonly runtime: ClosableRuntime
  active: number
  retired: boolean
  closed?: Promise<void>
}

async function fileStamp(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).mtimeMs
  } catch {
    return undefined
  }
}

/**
 * The runtime `overleaf-web-mcp serve` runs on. It starts even when there is no working session,
 * so an MCP client can connect and be told so, and opens the session when a call needs one: after
 * a `login` in a terminal, the next call works without restarting the client. A call that finds
 * the session expired retires its runtime, which closes once its other calls settle, never under a
 * running write. Operation commands and the SDK keep `OverleafRuntime`, which opens the session up
 * front.
 */
export class SessionRuntime implements OverleafServiceRuntime {
  readonly policy: AccessPolicy
  readonly authStatus: OverleafServiceRuntime['authStatus']
  readonly createFile: OverleafServiceRuntime['createFile']
  readonly account: OverleafServiceRuntime['account']
  readonly projects: OverleafServiceRuntime['projects']
  readonly entities: OverleafServiceRuntime['entities']
  readonly documents: OverleafServiceRuntime['documents']
  readonly sections: OverleafServiceRuntime['sections']
  readonly compile: OverleafServiceRuntime['compile']
  readonly comments: OverleafServiceRuntime['comments']
  readonly trackedChanges: OverleafServiceRuntime['trackedChanges']
  readonly history: OverleafServiceRuntime['history']
  readonly sync: OverleafServiceRuntime['sync']
  readonly tags: OverleafServiceRuntime['tags']
  readonly search: OverleafServiceRuntime['search']

  readonly #config: AppConfig
  readonly #createRuntime: (config: AppConfig) => Promise<ClosableRuntime>
  readonly #sessionFileStamp: (path: string) => Promise<number | undefined>
  readonly #signInOffered: boolean
  #current: Lease | undefined
  #opening: Promise<Lease> | undefined
  /** The session file's stamp when opening it last failed with AUTH_EXPIRED; absent when untried. */
  #failedAt: { stamp: number | undefined } | undefined
  #closing = new Set<Promise<void>>()
  #closed = false

  private constructor(config: AppConfig, policy: AccessPolicy, options: SessionRuntimeOptions) {
    this.#config = config
    this.policy = policy
    this.#createRuntime = options.createRuntime ?? (async next => await OverleafRuntime.create(next))
    this.#sessionFileStamp = options.sessionFileStamp ?? fileStamp
    this.#signInOffered = options.signInOffered ?? false

    const member = (group: Group | '', method: string) =>
      (async (...args: unknown[]) =>
        await this.#run(runtime => {
          const target = (group === '' ? runtime : runtime[group]) as unknown as Record<
            string,
            (...values: unknown[]) => Promise<unknown>
          >
          return target[method]!(...args)
        })) as never
    const groups: Partial<Record<Group, Record<string, unknown>>> = {}
    for (const [group, method] of SESSION_RUNTIME_MEMBERS) {
      if (group === '') continue
      ;(groups[group] ??= {})[method] = member(group, method)
    }
    this.authStatus = member('', 'authStatus')
    this.createFile = member('', 'createFile')
    this.account = groups.account as never
    this.projects = groups.projects as never
    this.entities = groups.entities as never
    this.documents = groups.documents as never
    this.sections = groups.sections as never
    this.compile = groups.compile as never
    this.comments = groups.comments as never
    this.trackedChanges = groups.trackedChanges as never
    this.history = groups.history as never
    this.sync = groups.sync as never
    this.tags = groups.tags as never
    this.search = groups.search as never
  }

  /**
   * Builds the access policy, then tries the saved session. A missing or expired session starts
   * signed out; any other failure, such as a session file others can read, is thrown as before.
   */
  static async start(config: AppConfig, options: SessionRuntimeOptions = {}): Promise<SessionRuntime> {
    const session = new SessionRuntime(config, await createAccessPolicy(config), options)
    try {
      session.#release(await session.#open())
    } catch (error) {
      if (!(error instanceof McpError && error.code === 'AUTH_EXPIRED')) throw error
    }
    return session
  }

  /** Stops using the current runtime and closes it, and every retired one, once their calls settle. */
  async close(): Promise<void> {
    this.#closed = true
    if (this.#current !== undefined) this.#retire(this.#current)
    await Promise.all([...this.#closing])
  }

  async #run<T>(call: (runtime: ClosableRuntime) => Promise<T>): Promise<T> {
    const lease = await this.#open()
    try {
      return await call(lease.runtime)
    } catch (error) {
      if (error instanceof McpError && error.code === 'AUTH_EXPIRED') this.#retire(lease)
      throw error
    } finally {
      this.#release(lease)
    }
  }

  /** The current runtime with one more call counted on it, opening it from the saved session first if needed. */
  async #open(): Promise<Lease> {
    if (this.#closed) throw new McpError('AUTH_EXPIRED', 'The server is shutting down.')
    if (this.#current === undefined) {
      this.#opening ??= this.#openFromFile().finally(() => {
        this.#opening = undefined
      })
      await this.#opening
    }
    const lease = this.#current
    if (lease === undefined) throw this.#signedOut()
    lease.active += 1
    return lease
  }

  async #openFromFile(): Promise<Lease> {
    const path = this.#config.cookieJarFile
    // An unchanged session file cannot hold a session that failed a moment ago, so nothing is sent.
    if (this.#failedAt !== undefined && (await this.#sessionFileStamp(path)) === this.#failedAt.stamp) {
      throw this.#signedOut()
    }
    try {
      const lease: Lease = { runtime: await this.#createRuntime(this.#config), active: 0, retired: false }
      this.#failedAt = undefined
      this.#current = lease
      return lease
    } catch (error) {
      if (!(error instanceof McpError && error.code === 'AUTH_EXPIRED')) throw error
      // Read after the failure: opening it may have saved the cookies Overleaf answered with.
      this.#failedAt = { stamp: await this.#sessionFileStamp(path) }
      throw this.#signedOut(error)
    }
  }

  #release(lease: Lease): void {
    lease.active -= 1
    if (lease.retired && lease.active <= 0) this.#closeLease(lease)
  }

  #retire(lease: Lease): void {
    if (this.#current === lease) this.#current = undefined
    lease.retired = true
    if (lease.active <= 0) this.#closeLease(lease)
  }

  #closeLease(lease: Lease): void {
    if (lease.closed !== undefined) return
    lease.closed = lease.runtime.close().catch(() => undefined)
    this.#closing.add(lease.closed)
    void lease.closed.finally(() => this.#closing.delete(lease.closed!))
  }

  #signedOut(cause?: unknown): McpError {
    const howTo = this.#signInOffered
      ? 'With the user’s agreement, call sign_in, or ask them to run `npx overleaf-web-mcp login`.'
      : AUTH_LOGIN_INSTRUCTION
    return new McpError('AUTH_EXPIRED', `There is no working Overleaf session. ${howTo}`, {
      ...(cause === undefined ? {} : { cause }),
    })
  }
}
