import type { CookieJar } from 'tough-cookie'

import { AUTH_LOGIN_INSTRUCTION, McpError } from '../core/errors.js'
import { USER_AGENT } from '../version.js'

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>

export interface HttpClientOptions {
  baseUrl: string
  jar: CookieJar
  fetcher?: Fetcher
  defaultTimeoutMs?: number
  csrfToken?: () => string | undefined
  persistSetCookies?: (url: string, values: string[]) => Promise<void>
}

export interface RequestOptions {
  timeoutMs?: number
  headers?: HeadersInit
  signal?: AbortSignal
}

/**
 * Overleaf identifies rejected requests with a short lowercase code, for example
 * `duplicate_file_name`. Only a value matching that shape is propagated, so no response
 * content or free text can reach a caller through an error.
 */
const ERROR_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u

async function safeErrorCode(response: Response): Promise<string | undefined> {
  if (!(response.headers.get('content-type') ?? '').includes('application/json')) {
    return undefined
  }
  try {
    const body: unknown = JSON.parse((await response.text()).slice(0, 2048))
    const code = (body as { error?: unknown } | null)?.error
    return typeof code === 'string' && ERROR_CODE_PATTERN.test(code) ? code : undefined
  } catch {
    return undefined
  }
}

/** `Retry-After` is either whole seconds or an HTTP date; anything else yields no hint. */
function parseRetryAfter(header: string | null): number | undefined {
  if (header === null) return undefined
  const trimmed = header.trim()
  if (/^\d+$/u.test(trimmed)) return Number(trimmed) * 1000
  const at = Date.parse(trimmed)
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now())
}

function responseSetCookies(headers: Headers): string[] {
  const enhanced = headers as Headers & { getSetCookie?: () => string[] }
  if (enhanced.getSetCookie) return enhanced.getSetCookie()
  const value = headers.get('set-cookie')
  return value ? [value] : []
}

export class OverleafHttpClient {
  readonly baseUrl: string
  readonly jar: CookieJar
  readonly #fetcher: Fetcher
  readonly #defaultTimeoutMs: number
  readonly #csrfToken: (() => string | undefined) | undefined
  readonly #persistSetCookies: ((url: string, values: string[]) => Promise<void>) | undefined

  constructor(options: HttpClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/u, '')
    this.jar = options.jar
    this.#fetcher = options.fetcher ?? fetch
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000
    this.#csrfToken = options.csrfToken
    this.#persistSetCookies = options.persistSetCookies
  }

  async request(
    method: string,
    path: string,
    body?: unknown,
    options: RequestOptions = {}
  ): Promise<Response> {
    const url = new URL(path, `${this.baseUrl}/`).href
    const headers = new Headers(options.headers)
    const cookies = await this.jar.getCookieString(url)
    if (cookies) headers.set('cookie', cookies)
    headers.set('accept', 'application/json, text/plain, */*')
    headers.set('user-agent', USER_AGENT)
    if (body !== undefined && !(body instanceof FormData)) {
      headers.set('content-type', 'application/json')
    }
    if (!['GET', 'HEAD'].includes(method)) {
      const csrf = this.#csrfToken?.()
      if (csrf) headers.set('x-csrf-token', csrf)
    }

    const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? this.#defaultTimeoutMs)
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal

    let response: Response
    try {
      response = await this.#fetcher(url, {
        method,
        headers,
        signal,
        redirect: 'follow',
        ...(body === undefined
          ? {}
          : { body: body instanceof FormData ? body : JSON.stringify(body) }),
      })
    } catch (error) {
      if (signal.aborted) {
        throw new McpError('TIMEOUT', `Overleaf request timed out: ${method} ${path}`, {
          retryable: true,
          cause: error,
        })
      }
      throw new McpError('REMOTE_ERROR', `Overleaf request failed: ${method} ${path}`, {
        retryable: true,
        cause: error,
      })
    }

    const setCookies = responseSetCookies(response.headers)
    for (const value of setCookies) await this.jar.setCookie(value, url)
    await this.#persistSetCookies?.(url, setCookies)

    const finalPath = response.url ? new URL(response.url).pathname : ''
    if (response.status === 401 || finalPath.startsWith('/login')) {
      throw new McpError(
        'AUTH_EXPIRED',
        `Overleaf authentication expired. ${AUTH_LOGIN_INSTRUCTION}`,
        { retryable: false }
      )
    }
    if (response.status === 403) {
      throw new McpError('PERMISSION_DENIED', 'Overleaf denied this operation.')
    }
    if (response.status === 404) {
      throw new McpError('NOT_FOUND', `Overleaf resource was not found: ${path}`)
    }
    if (response.status === 413) {
      throw new McpError(
        'UPDATE_TOO_LARGE',
        'Overleaf rejected the request as too large. Split it into smaller revisioned operations.'
      )
    }
    if (response.status === 429) {
      const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'))
      throw new McpError('RATE_LIMITED', 'Overleaf rate-limited this request. Wait before retrying.', {
        retryable: true,
        details: {
          status: 429,
          path,
          ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        },
      })
    }
    if (!response.ok) {
      const overleafError = await safeErrorCode(response)
      throw new McpError('REMOTE_ERROR', `Overleaf returned HTTP ${response.status}.`, {
        details: {
          status: response.status,
          path,
          ...(overleafError === undefined ? {} : { overleafError }),
        },
      })
    }
    return response
  }

  async getJson<T = unknown>(path: string, options?: RequestOptions): Promise<T> {
    const response = await this.request('GET', path, undefined, options)
    return (await response.json()) as T
  }

  async postJson<T = unknown>(
    path: string,
    body: unknown = {},
    options?: RequestOptions
  ): Promise<T> {
    const response = await this.request('POST', path, body, options)
    const text = await response.text()
    return (text ? JSON.parse(text) : {}) as T
  }

  async deleteJson<T = unknown>(path: string, options?: RequestOptions): Promise<T> {
    const response = await this.request('DELETE', path, undefined, options)
    const text = await response.text()
    return (text ? JSON.parse(text) : {}) as T
  }

  async getBytes(path: string, options?: RequestOptions): Promise<Uint8Array> {
    const response = await this.request('GET', path, undefined, options)
    return new Uint8Array(await response.arrayBuffer())
  }

  /**
   * Starts a GET and hands back the body unread, for downloads too large to buffer. The request
   * timeout keeps running while the caller reads, so it bounds the whole transfer.
   */
  async getStream(
    path: string,
    options?: RequestOptions
  ): Promise<{ body: ReadableStream<Uint8Array>; contentType?: string }> {
    const response = await this.request('GET', path, undefined, options)
    const contentType = response.headers.get('content-type') ?? undefined
    const body = response.body ?? new Response(new Uint8Array()).body!
    return { body, ...(contentType === undefined ? {} : { contentType }) }
  }

  async postForm<T = unknown>(
    path: string,
    form: FormData,
    options?: RequestOptions
  ): Promise<T> {
    const response = await this.request('POST', path, form, options)
    const text = await response.text()
    return (text ? JSON.parse(text) : {}) as T
  }
}
