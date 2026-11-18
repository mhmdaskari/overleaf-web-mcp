import { mkdir } from 'node:fs/promises'

import lockfile from 'proper-lockfile'
import type { CookieJar } from 'tough-cookie'

import type { AppConfig } from '../config.js'
import { McpError } from '../core/errors.js'
import { writeCookieJar } from '../http/cookies.js'
import { OverleafRuntime } from '../runtime.js'
import { captureBrowserSession } from './browser-login.js'

interface LoginRuntime {
  authStatus(): Promise<{
    authenticated: true
    baseUrl: string
    projectCount: number
    permissionsUnchecked: boolean
    warning?: string
  }>
  close(): Promise<void>
}

export interface LoginCommandOptions {
  onStatus?: (message: string) => void
  /** Stops the sign-in and closes its window; nothing is saved. */
  signal?: AbortSignal
}

export interface LoginCommandDependencies {
  captureSession?: typeof captureBrowserSession
  persistSession?: (path: string, jar: CookieJar) => Promise<void>
  createRuntime?: (config: AppConfig) => Promise<LoginRuntime>
}

export interface LoginResult {
  authenticated: true
  baseUrl: string
  projectCount: number
  cookieJarFile: string
  cookiesCaptured: number
  permissionsUnchecked: boolean
  warning?: string
}

/**
 * Locks the browser profile for one sign-in. A lock another process holds is `AUTH_EXPIRED` with
 * `details.reason: "sign_in_in_progress"`; `onCompromised` runs instead of throwing if the lock is
 * lost while held.
 */
async function lockProfile(directory: string, onCompromised: () => void): Promise<() => Promise<void>> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  try {
    return await lockfile.lock(directory, { stale: 30_000, onCompromised })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOCKED') {
      throw new McpError(
        'AUTH_EXPIRED',
        'Another Overleaf sign-in is already open on this computer. Finish it in its browser window, or close that window, then try again.',
        { details: { reason: 'sign_in_in_progress' }, cause: error }
      )
    }
    throw error
  }
}

export async function runLoginCommand(
  config: AppConfig,
  options: LoginCommandOptions = {},
  dependencies: LoginCommandDependencies = {}
): Promise<LoginResult> {
  const captureSession = dependencies.captureSession ?? captureBrowserSession
  const persistSession = dependencies.persistSession ?? writeCookieJar
  const createRuntime =
    dependencies.createRuntime ?? (async (runtimeConfig: AppConfig) => await OverleafRuntime.create(runtimeConfig))

  // One sign-in at a time per browser profile, across processes: Chrome lets one process use a
  // profile, so a second window would close at once and look like a cancelled sign-in.
  const stop = new AbortController()
  const forward = (): void => stop.abort(options.signal?.reason)
  if (options.signal?.aborted) forward()
  else options.signal?.addEventListener('abort', forward, { once: true })
  const release = await lockProfile(config.browserProfileDir, () =>
    // The lock went stale, as after a laptop sleep: stop rather than share the profile.
    stop.abort(new McpError('TIMEOUT', 'The sign-in stopped because its lock on the browser profile was lost.'))
  )
  let captured: { jar: CookieJar; cookieCount: number }
  try {
    captured = await captureSession({
      baseUrl: config.baseUrl,
      browserProfileDir: config.browserProfileDir,
      ...(config.browserPath === undefined ? {} : { browserPath: config.browserPath }),
      timeoutMs: config.loginTimeoutMs,
      ...(options.onStatus === undefined ? {} : { onStatus: options.onStatus }),
      signal: stop.signal,
    })
    options.onStatus?.('Saving the Overleaf session securely...')
    await persistSession(config.cookieJarFile, captured.jar)
  } finally {
    options.signal?.removeEventListener('abort', forward)
    // A lock already lost cannot be released, and that is no reason to fail the sign-in.
    await release().catch(() => undefined)
  }
  options.onStatus?.('Verifying the saved session with Overleaf...')

  const runtime = await createRuntime(config)
  try {
    const status = await runtime.authStatus()
    return {
      authenticated: true,
      baseUrl: status.baseUrl,
      projectCount: status.projectCount,
      cookieJarFile: config.cookieJarFile,
      cookiesCaptured: captured.cookieCount,
      permissionsUnchecked: status.permissionsUnchecked,
      ...(status.warning === undefined ? {} : { warning: status.warning }),
    }
  } finally {
    await runtime.close()
  }
}
