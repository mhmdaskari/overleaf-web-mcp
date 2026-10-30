import { chmod, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, basename, join } from 'node:path'

import lockfile from 'proper-lockfile'
import { Cookie, CookieJar } from 'tough-cookie'

import { AUTH_LOGIN_INSTRUCTION, McpError } from '../core/errors.js'

export interface PermissionCheck {
  permissionsUnchecked: boolean
  warning?: string
}

export async function assertCookieFilePermissions(path: string): Promise<PermissionCheck> {
  if (process.platform === 'win32') {
    return {
      permissionsUnchecked: true,
      warning: 'Cookie file permissions could not be checked on this filesystem.',
    }
  }
  const metadata = await stat(path)
  if ((metadata.mode & 0o077) !== 0) {
    throw new McpError('PERMISSION_DENIED', `Cookie jar ${path} must be owner-only. Run: chmod 0600 ${path}`)
  }
  return { permissionsUnchecked: false }
}

export async function parseNetscapeCookies(text: string): Promise<CookieJar> {
  const jar = new CookieJar()
  for (const originalLine of text.split(/\r?\n/u)) {
    if (!originalLine || (originalLine.startsWith('#') && !originalLine.startsWith('#HttpOnly_'))) {
      continue
    }
    const httpOnly = originalLine.startsWith('#HttpOnly_')
    const line = httpOnly ? originalLine.slice('#HttpOnly_'.length) : originalLine
    const fields = line.split('\t')
    if (fields.length < 7) continue
    /*
     * The include-subdomains column is deliberately ignored. Jars written before 0.3.0 always
     * recorded FALSE, the session cookie included, so honouring it would load that cookie as
     * host-only and stop sending it to www.overleaf.com, breaking every existing install. Setting
     * `domain` leaves tough-cookie to treat the cookie as a domain cookie, which is what those
     * jars have always meant.
     */
    const [domain, , path, secure, expires, name, ...valueParts] = fields
    if (!domain || !path || !name) continue
    const value = valueParts.join('\t')
    const cookie = new Cookie({
      key: name,
      value,
      domain: domain.replace(/^\./u, ''),
      path,
      secure: secure === 'TRUE',
      httpOnly,
      expires: expires && expires !== '0' ? new Date(Number(expires) * 1000) : 'Infinity',
    })
    const protocol = cookie.secure ? 'https:' : 'http:'
    await jar.setCookie(cookie, `${protocol}//${cookie.domain}${cookie.path}`)
  }
  return jar
}

function cookieToNetscape(cookie: Cookie): string {
  const domain = cookie.domain ?? ''
  const prefix = cookie.httpOnly ? '#HttpOnly_' : ''
  /*
   * tough-cookie canonicalizes `domain` without a leading dot, so the dot can never be the source
   * of the include-subdomains column; `hostOnly` is. Overleaf scopes its session cookie to
   * `.overleaf.com`, and a reader that takes it as host-only will not send it to `www.overleaf.com`.
   */
  const includeSubdomains = cookie.hostOnly === false
  /*
   * Overleaf sets the session cookie with Max-Age, and tough-cookie keeps a Max-Age deadline in
   * `maxAge`, counted from `lastAccessed`, leaving `expires` as 'Infinity'. Reading `expires` here
   * wrote 0 and discarded the five-day deadline on every save. `expiryTime()` folds both forms
   * together; a cookie that came through `mergeSetCookies` already carries an absolute `expires`.
   */
  const expiryTime = cookie.expiryTime()
  const expires = expiryTime === undefined || !Number.isFinite(expiryTime) ? '0' : String(Math.floor(expiryTime / 1000))
  return [
    `${prefix}${includeSubdomains ? '.' : ''}${domain}`,
    includeSubdomains ? 'TRUE' : 'FALSE',
    cookie.path ?? '/',
    cookie.secure ? 'TRUE' : 'FALSE',
    expires,
    cookie.key,
    cookie.value,
  ].join('\t')
}

/**
 * RFC 6265 counts Max-Age from when the cookie arrives, but tough-cookie counts it from
 * `lastAccessed`, which every `getCookies()` moves forward. Turning it into an absolute `expires`
 * on arrival keeps the deadline the jar file records and the one `sessionExpiresAt` reports at the
 * same instant, however often the cookie is read afterwards.
 */
function withArrivalDeadline(header: string, arrivedAt: number): Cookie | string {
  const cookie = Cookie.parse(header)
  if (cookie === undefined || typeof cookie.maxAge !== 'number' || cookie.maxAge <= 0) return header
  // 8.64e15 ms is the latest instant a Date can hold; past it, serializing the jar would throw.
  cookie.expires = new Date(Math.min(arrivedAt + cookie.maxAge * 1000, 8.64e15))
  cookie.maxAge = null
  return cookie
}

function serializeJar(jar: CookieJar): string {
  const serialized = jar.serializeSync()
  const cookies = (serialized?.cookies ?? [])
    .map(value => Cookie.fromJSON(value))
    .filter((value): value is Cookie => value !== null)
  return `# Netscape HTTP Cookie File\n# Updated by overleaf-web-mcp\n${cookies.map(cookieToNetscape).join('\n')}\n`
}

/** Persists a complete cookie jar under an advisory lock with owner-only permissions. */
export async function writeCookieJar(path: string, jar: CookieJar): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  // proper-lockfile needs a stable target; create it with safe permissions before locking.
  try {
    await writeFile(path, '', { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  if (process.platform !== 'win32') await chmod(path, 0o600)

  let release: (() => Promise<void>) | undefined
  try {
    release = await lockfile.lock(path, {
      retries: { retries: 5, minTimeout: 50, maxTimeout: 250 },
      stale: 10_000,
    })
    const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`)
    await writeFile(temporary, serializeJar(jar), { mode: 0o600 })
    // Same-directory rename prevents readers from observing a partially written jar.
    await rename(temporary, path)
  } catch (error) {
    throw new McpError('PARTIAL_CLEANUP', 'Could not safely persist browser login cookies.', {
      cause: error,
    })
  } finally {
    await release?.()
  }
}

/**
 * Owns the process-wide cookie jar and durably merges cookies refreshed by Overleaf.
 * The in-memory object remains stable because HTTP and socket clients share its identity.
 */
export class CookieStore {
  readonly path: string
  jar: CookieJar
  readonly permissions: PermissionCheck

  private constructor(path: string, jar: CookieJar, permissions: PermissionCheck) {
    this.path = path
    this.jar = jar
    this.permissions = permissions
  }

  static async load(path: string): Promise<CookieStore> {
    try {
      const permissions = await assertCookieFilePermissions(path)
      const jar = await parseNetscapeCookies(await readFile(path, 'utf8'))
      return new CookieStore(path, jar, permissions)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new McpError('AUTH_EXPIRED', `No saved Overleaf web session was found. ${AUTH_LOGIN_INSTRUCTION}`, {
          cause: error,
        })
      }
      throw error
    }
  }

  async mergeSetCookies(url: string, setCookies: string[]): Promise<void> {
    const arrivedAt = Date.now()
    for (const value of setCookies) {
      await this.jar.setCookie(withArrivalDeadline(value, arrivedAt), url)
    }
    if (setCookies.length === 0) return

    let release: (() => Promise<void>) | undefined
    try {
      release = await lockfile.lock(this.path, {
        retries: { retries: 5, minTimeout: 50, maxTimeout: 250 },
        stale: 10_000,
      })
      // Reload under the lock so concurrent server processes do not overwrite each other's refreshes.
      const latest = await parseNetscapeCookies(await readFile(this.path, 'utf8'))
      for (const value of setCookies) {
        await latest.setCookie(withArrivalDeadline(value, arrivedAt), url)
      }
      await this.jar.removeAllCookies()
      for (const cookie of latest.serializeSync()?.cookies ?? []) {
        const parsed = Cookie.fromJSON(cookie)
        if (parsed) {
          const protocol = parsed.secure ? 'https:' : 'http:'
          await this.jar.setCookie(parsed, `${protocol}//${parsed.domain}${parsed.path ?? '/'}`)
        }
      }
      const temporary = join(dirname(this.path), `.${basename(this.path)}.${process.pid}.${Date.now()}.tmp`)
      await writeFile(temporary, serializeJar(this.jar), { mode: 0o600 })
      await rename(temporary, this.path)
    } catch (error) {
      throw new McpError('PARTIAL_CLEANUP', 'Could not safely persist refreshed cookies.', {
        cause: error,
      })
    } finally {
      await release?.()
    }
  }

  /**
   * Earliest deadline among the cookies the jar would send with a request to `url`, as ISO 8601,
   * or `undefined` when every one of them is a session cookie with no deadline.
   *
   * The session cookie is never matched by name: it is `overleaf_session2` on www.overleaf.com and
   * `overleaf.sid` on Community Edition. `expiryTime()` rather than `expires`, because a Max-Age
   * cookie that did not come through `mergeSetCookies` keeps its deadline apart from `expires`.
   */
  async sessionExpiresAt(url: string): Promise<string | undefined> {
    const deadlines = (await this.jar.getCookies(url))
      .map(cookie => cookie.expiryTime())
      .filter((time): time is number => time !== undefined && Number.isFinite(time))
    if (deadlines.length === 0) return undefined
    return new Date(Math.min(...deadlines)).toISOString()
  }
}
