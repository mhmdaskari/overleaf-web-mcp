import type { AppConfig } from '../config.js'
import { OverleafRuntime } from '../runtime.js'

interface KeepaliveRuntime {
  readonly config: { baseUrl: string }
  readonly userId?: string | undefined
  readonly cookieStore: { sessionExpiresAt(url: string): Promise<string | undefined> }
  close(): Promise<void>
}

export interface KeepaliveCommandDependencies {
  createRuntime?: (config: AppConfig) => Promise<KeepaliveRuntime>
}

export interface KeepaliveResult {
  refreshed: true
  baseUrl: string
  /** When the session now lapses; absent only if Overleaf sent no cookie with a deadline. */
  sessionExpiresAt?: string
  userId?: string
}

/**
 * Refreshes the saved web session by running the server's own startup bootstrap, then exits.
 *
 * Overleaf re-issues its session cookie with a fresh five-day deadline on every response, so one
 * request a day keeps a session alive indefinitely, while five idle days end it for good. The
 * bootstrap already merges the refreshed cookie into the jar under its advisory lock, so a
 * keepalive that fires while a client has the server open cannot clobber either refresh.
 *
 * A session that has already lapsed cannot be revived. `OverleafRuntime.create` then throws
 * `AUTH_EXPIRED`, which must propagate: Overleaf's login redirect hands out an anonymous cookie
 * that replaces the dead one in the jar, and that must never be reported as a refresh.
 */
export async function runKeepaliveCommand(
  config: AppConfig,
  dependencies: KeepaliveCommandDependencies = {}
): Promise<KeepaliveResult> {
  const createRuntime =
    dependencies.createRuntime ?? (async (runtimeConfig: AppConfig) => await OverleafRuntime.create(runtimeConfig))
  const runtime = await createRuntime(config)
  try {
    const sessionExpiresAt = await runtime.cookieStore.sessionExpiresAt(`${runtime.config.baseUrl}/project`)
    return {
      refreshed: true,
      baseUrl: runtime.config.baseUrl,
      ...(sessionExpiresAt === undefined ? {} : { sessionExpiresAt }),
      ...(runtime.userId === undefined ? {} : { userId: runtime.userId }),
    }
  } finally {
    await runtime.close()
  }
}
