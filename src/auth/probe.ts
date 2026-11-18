import type { AppConfig } from '../config.js'
import { parseBootstrapMeta, requireCsrfToken } from '../http/bootstrap.js'
import { OverleafHttpClient } from '../http/client.js'
import { CookieStore } from '../http/cookies.js'
import { createProxyRoute } from '../http/proxy.js'

export interface ProbeDependencies {
  fetcher?: typeof fetch
}

/**
 * Checks the saved session with one request for the project page, as `doctor` does, and writes
 * nothing: unlike a runtime, it never saves the cookies Overleaf answers with. Resolves when the
 * session works; a missing or expired one is `AUTH_EXPIRED`, anything else its own error.
 */
export async function probeSavedSession(config: AppConfig, dependencies: ProbeDependencies = {}): Promise<void> {
  const cookieStore = await CookieStore.load(config.cookieJarFile)
  const proxy = config.proxyUrl === undefined ? undefined : createProxyRoute(config.proxyUrl)
  const fetcher = dependencies.fetcher ?? proxy?.fetcher
  try {
    const http = new OverleafHttpClient({
      baseUrl: config.baseUrl,
      jar: cookieStore.jar,
      defaultTimeoutMs: config.requestTimeoutMs,
      minRequestIntervalMs: config.minRequestIntervalMs ?? 0,
      ...(fetcher === undefined ? {} : { fetcher }),
    })
    const page = await http.request('GET', '/project')
    requireCsrfToken(parseBootstrapMeta(await page.text()))
  } finally {
    await proxy?.close()
  }
}
