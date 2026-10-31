import { spawn } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { Cookie, CookieJar } from 'tough-cookie'

import { McpError } from '../core/errors.js'
import { CdpClient } from './cdp.js'
import { chromeLaunchArguments, findChromeExecutable, readDevToolsEndpoint } from './chrome.js'

export interface BrowserProcess {
  exitCode: number | null
  kill(signal?: NodeJS.Signals | number): boolean
}

export interface CdpTransport {
  readonly closed: boolean
  send<T>(method: string, params?: Record<string, unknown>, sessionId?: string, timeoutMs?: number): Promise<T>
  close(): void
}

interface BrowserCookie {
  name: string
  value: string
  domain: string
  path: string
  secure: boolean
  httpOnly: boolean
  expires: number
}

export interface BrowserLoginOptions {
  baseUrl: string
  browserProfileDir: string
  browserPath?: string
  timeoutMs: number
  onStatus?: (message: string) => void
}

export interface BrowserLoginDependencies {
  findChrome?: (explicitPath?: string) => Promise<string>
  spawnChrome?: (executable: string, args: string[]) => BrowserProcess
  readEndpoint?: (profileDir: string, timeoutMs?: number) => Promise<string>
  connectCdp?: (url: string) => Promise<CdpTransport>
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

function domainApplies(domain: string, hostname: string): boolean {
  const normalized = domain.replace(/^\./u, '').toLowerCase()
  const target = hostname.toLowerCase()
  return target === normalized || target.endsWith(`.${normalized}`)
}

async function cookiesToJar(cookies: BrowserCookie[], baseUrl: URL): Promise<CookieJar> {
  const jar = new CookieJar()
  for (const browserCookie of cookies) {
    // CDP returns cookies for the whole profile; retain only the configured Overleaf origin.
    if (!domainApplies(browserCookie.domain, baseUrl.hostname)) continue
    const domain = browserCookie.domain.replace(/^\./u, '')
    const cookie = new Cookie({
      key: browserCookie.name,
      value: browserCookie.value,
      domain,
      path: browserCookie.path || '/',
      secure: browserCookie.secure,
      httpOnly: browserCookie.httpOnly,
      expires: browserCookie.expires > 0 ? new Date(browserCookie.expires * 1000) : 'Infinity',
    })
    const protocol = browserCookie.secure ? 'https:' : baseUrl.protocol
    await jar.setCookie(cookie, `${protocol}//${baseUrl.hostname}${cookie.path ?? '/'}`)
  }
  return jar
}

/**
 * Opens an isolated Chrome profile and captures an authenticated Overleaf session.
 * The browser is closed after origin-scoped cookies have been collected.
 */
export async function captureBrowserSession(
  options: BrowserLoginOptions,
  dependencies: BrowserLoginDependencies = {}
): Promise<{ jar: CookieJar; cookieCount: number }> {
  const findChrome = dependencies.findChrome ?? findChromeExecutable
  const spawnChrome =
    dependencies.spawnChrome ??
    ((executable: string, args: string[]) => spawn(executable, args, { stdio: 'ignore', detached: false }))
  const readEndpoint = dependencies.readEndpoint ?? readDevToolsEndpoint
  const connectCdp = dependencies.connectCdp ?? (async (url: string) => await CdpClient.connect(url))
  const sleep = dependencies.sleep ?? (async (ms: number) => await new Promise(resolve => setTimeout(resolve, ms)))
  const now = dependencies.now ?? Date.now
  const baseUrl = new URL(options.baseUrl)

  // A dedicated profile avoids exposing or modifying the user's everyday browser session.
  await mkdir(options.browserProfileDir, { recursive: true, mode: 0o700 })
  // Chrome may leave this discovery file behind after an unclean exit.
  await rm(join(options.browserProfileDir, 'DevToolsActivePort'), { force: true })
  const executable = await findChrome(options.browserPath)
  options.onStatus?.('Opening a dedicated Chrome window for Overleaf login...')
  const browser = spawnChrome(executable, chromeLaunchArguments(options.browserProfileDir))
  let cdp: CdpTransport | undefined
  try {
    const endpoint = await readEndpoint(options.browserProfileDir, 10_000)
    cdp = await connectCdp(endpoint)
    const targets = await cdp.send<{
      targetInfos: Array<{ targetId: string; type: string }>
    }>('Target.getTargets')
    const page = targets.targetInfos.find(target => target.type === 'page')
    if (!page) throw new McpError('NOT_FOUND', 'Chrome opened without a page for login.')
    const attached = await cdp.send<{ sessionId: string }>('Target.attachToTarget', {
      targetId: page.targetId,
      flatten: true,
    })
    await cdp.send('Page.enable', {}, attached.sessionId)
    await cdp.send('Runtime.enable', {}, attached.sessionId)
    await cdp.send('Page.navigate', { url: new URL('/project', baseUrl).href }, attached.sessionId)
    options.onStatus?.('Sign in normally; this window will close after authentication succeeds.')

    const deadline = now() + options.timeoutMs
    while (now() < deadline) {
      if (browser.exitCode !== null || cdp.closed) {
        throw new McpError('AUTH_EXPIRED', 'Chrome closed before Overleaf login completed.')
      }
      try {
        // The project page's CSRF meta tag is a stronger authentication signal than a URL redirect.
        const state = await cdp.send<{
          result: {
            value?: { origin?: string; pathname?: string; csrfToken?: string | null }
          }
        }>(
          'Runtime.evaluate',
          {
            expression:
              '({ origin: location.origin, pathname: location.pathname, csrfToken: document.querySelector(\'meta[name=\\"ol-csrfToken\\"]\')?.content ?? null })',
            returnByValue: true,
          },
          attached.sessionId
        )
        const value = state.result.value
        if (
          value?.origin === baseUrl.origin &&
          value.pathname?.startsWith('/project') &&
          typeof value.csrfToken === 'string' &&
          value.csrfToken.length > 0
        ) {
          const result = await cdp.send<{ cookies: BrowserCookie[] }>('Storage.getCookies')
          const jar = await cookiesToJar(result.cookies, baseUrl)
          const cookieCount = jar.serializeSync()?.cookies?.length ?? 0
          if (cookieCount === 0) {
            throw new McpError('AUTH_EXPIRED', 'Overleaf login completed without usable cookies.')
          }
          return { jar, cookieCount }
        }
      } catch (error) {
        if (error instanceof McpError && error.code === 'AUTH_EXPIRED') throw error
        // Navigation briefly destroys the execution context; polling resumes after the redirect.
      }
      await sleep(500)
    }
    throw new McpError(
      'TIMEOUT',
      `Overleaf login did not complete within ${Math.round(options.timeoutMs / 1000)} seconds.`
    )
  } finally {
    cdp?.close()
    if (browser.exitCode === null) browser.kill('SIGTERM')
  }
}
