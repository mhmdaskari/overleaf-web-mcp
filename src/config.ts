import { McpError } from './core/errors.js'
import { resolveAuthPaths } from './auth/paths.js'
import { resolveProxyUrl } from './http/proxy.js'

export interface AppConfig {
  baseUrl: string
  cookieJarFile: string
  browserPath?: string
  browserProfileDir: string
  loginTimeoutMs: number
  maxDocLength: number
  maxUpdateChars: number
  socketCacheSize: number
  socketIdleTtlMs: number
  requestTimeoutMs: number
  applyTimeoutMs: number
  recoveryTimeoutMs: number
  compileTimeoutMs: number
  supportedProtocolVersions: number[]
  /** Proxy for every connection to `baseUrl`; absent to connect directly. */
  proxyUrl?: string
}

function positiveInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number
): number {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new McpError('INVALID_ARGUMENT', `${name} must be a positive integer.`)
  }
  return parsed
}

export interface ConfigContext {
  platform?: NodeJS.Platform
  homeDir?: string
}

export function readConfig(
  env: NodeJS.ProcessEnv = process.env,
  context: ConfigContext = {}
): AppConfig {
  const authPaths = resolveAuthPaths({ env, ...context })
  const cookieJarFile = env.OVERLEAF_COOKIE_JAR_FILE ?? authPaths.cookieJarFile

  let baseUrl: URL
  try {
    baseUrl = new URL(env.OVERLEAF_BASE_URL ?? 'https://www.overleaf.com')
  } catch (error) {
    throw new McpError('INVALID_ARGUMENT', 'OVERLEAF_BASE_URL is invalid.', { cause: error })
  }
  if (baseUrl.protocol !== 'https:' && baseUrl.protocol !== 'http:') {
    throw new McpError('INVALID_ARGUMENT', 'OVERLEAF_BASE_URL must use HTTP or HTTPS.')
  }

  const supportedProtocolVersions = (env.OVERLEAF_PROTOCOL_VERSIONS ?? '2')
    .split(',')
    .map(value => Number(value.trim()))
  if (supportedProtocolVersions.some(value => !Number.isSafeInteger(value))) {
    throw new McpError('INVALID_ARGUMENT', 'OVERLEAF_PROTOCOL_VERSIONS must be integers.')
  }

  const proxyUrl = resolveProxyUrl(baseUrl, env)

  return {
    baseUrl: baseUrl.href.replace(/\/$/u, ''),
    cookieJarFile,
    ...(env.OVERLEAF_BROWSER_PATH ? { browserPath: env.OVERLEAF_BROWSER_PATH } : {}),
    browserProfileDir:
      env.OVERLEAF_BROWSER_PROFILE_DIR ?? authPaths.browserProfileDir,
    loginTimeoutMs: Math.min(
      positiveInteger(env, 'OVERLEAF_LOGIN_TIMEOUT_MS', 5 * 60_000),
      15 * 60_000
    ),
    maxDocLength: positiveInteger(env, 'OVERLEAF_MAX_DOC_LENGTH', 2 * 1024 * 1024),
    maxUpdateChars: positiveInteger(env, 'OVERLEAF_MAX_UPDATE_CHARS', 7 * 1024 * 1024),
    socketCacheSize: positiveInteger(env, 'OVERLEAF_SOCKET_CACHE_SIZE', 2),
    socketIdleTtlMs: positiveInteger(env, 'OVERLEAF_SOCKET_IDLE_TTL_MS', 90_000),
    requestTimeoutMs: positiveInteger(env, 'OVERLEAF_REQUEST_TIMEOUT_MS', 30_000),
    applyTimeoutMs: positiveInteger(env, 'OVERLEAF_APPLY_TIMEOUT_MS', 30_000),
    recoveryTimeoutMs: positiveInteger(env, 'OVERLEAF_RECOVERY_TIMEOUT_MS', 30_000),
    compileTimeoutMs: Math.min(
      positiveInteger(env, 'OVERLEAF_COMPILE_TIMEOUT_MS', 120_000),
      15 * 60_000
    ),
    supportedProtocolVersions,
    ...(proxyUrl === undefined ? {} : { proxyUrl }),
  }
}
