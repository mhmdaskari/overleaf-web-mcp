import { CookieJar } from 'tough-cookie'
import { describe, expect, test, vi } from 'vitest'

import { OverleafHttpClient } from '../../src/http/client.js'
import { USER_AGENT } from '../../src/version.js'

describe('authenticated HTTP client', () => {
  test('adds cookies and parses JSON responses', async () => {
    const jar = new CookieJar()
    await jar.setCookie('overleaf.sid=session; Path=/; Secure', 'https://overleaf.test')
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('cookie')).toContain('overleaf.sid=session')
      expect(new Headers(init?.headers).get('user-agent')).toBe(USER_AGENT)
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    const client = new OverleafHttpClient({
      baseUrl: 'https://overleaf.test',
      jar,
      fetcher,
    })

    await expect(client.getJson('/user/projects')).resolves.toEqual({ ok: true })
  })

  test('turns login redirects and 401 responses into actionable AUTH_EXPIRED', async () => {
    const client = new OverleafHttpClient({
      baseUrl: 'https://overleaf.test',
      jar: new CookieJar(),
      fetcher: async () => new Response('unauthorized', { status: 401 }),
    })

    await expect(client.getJson('/user/projects')).rejects.toMatchObject({
      code: 'AUTH_EXPIRED',
      message: expect.stringMatching(/overleaf-web-mcp login/i),
    })
  })

  test('surfaces an Overleaf error code without carrying response content', async () => {
    const client = new OverleafHttpClient({
      baseUrl: 'https://overleaf.test',
      jar: new CookieJar(),
      fetcher: async () =>
        new Response(
          JSON.stringify({ success: false, error: 'duplicate_file_name', detail: 'main.tex' }),
          { status: 422, headers: { 'content-type': 'application/json' } }
        ),
    })

    await expect(client.postJson('/project/p/upload')).rejects.toMatchObject({
      code: 'REMOTE_ERROR',
      details: { status: 422, overleafError: 'duplicate_file_name' },
    })
  })

  test('maps HTTP 429 to a retryable RATE_LIMITED error carrying the Retry-After hint', async () => {
    const client = new OverleafHttpClient({
      baseUrl: 'https://overleaf.test',
      jar: new CookieJar(),
      fetcher: async () =>
        new Response('slow down', { status: 429, headers: { 'retry-after': '30' } }),
    })

    await expect(client.postJson('/project/new/upload')).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      retryable: true,
      details: { status: 429, path: '/project/new/upload', retryAfterMs: 30_000 },
    })
  })

  test('omits retryAfterMs when Overleaf sends no usable Retry-After header', async () => {
    const client = new OverleafHttpClient({
      baseUrl: 'https://overleaf.test',
      jar: new CookieJar(),
      fetcher: async () => new Response('slow down', { status: 429 }),
    })

    const error = await client.postJson('/project/new').catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: 'RATE_LIMITED', details: { status: 429 } })
    expect((error as { details: Record<string, unknown> }).details).not.toHaveProperty('retryAfterMs')
  })

  test('ignores error bodies that are free text rather than a code', async () => {
    const client = new OverleafHttpClient({
      baseUrl: 'https://overleaf.test',
      jar: new CookieJar(),
      fetcher: async () =>
        new Response(JSON.stringify({ error: 'Something went wrong with main.tex' }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        }),
    })

    // Only a short lowercase identifier is propagated, so document text can never leak.
    await expect(client.postJson('/project/p/upload')).rejects.toMatchObject({
      code: 'REMOTE_ERROR',
      details: { status: 500 },
    })
    await expect(client.postJson('/project/p/upload')).rejects.not.toMatchObject({
      details: { overleafError: expect.anything() },
    })
  })

  test('enforces an explicit request deadline', async () => {
    const client = new OverleafHttpClient({
      baseUrl: 'https://overleaf.test',
      jar: new CookieJar(),
      fetcher: async (_url, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
        }),
    })

    await expect(client.getJson('/slow', { timeoutMs: 5 })).rejects.toMatchObject({
      code: 'TIMEOUT',
    })
  })

  test('streams a body unread and reports its content type, with the same status mapping', async () => {
    const client = new OverleafHttpClient({
      baseUrl: 'https://overleaf.test',
      jar: new CookieJar(),
      fetcher: async url =>
        url.endsWith('/missing')
          ? new Response('gone', { status: 404 })
          : new Response(new Uint8Array([0x50, 0x4b, 3, 4]), { headers: { 'content-type': 'application/zip' } }),
    })

    const { body, contentType } = await client.getStream('/Project/p/download/zip')
    expect(contentType).toBe('application/zip')
    expect(new Uint8Array(await new Response(body).arrayBuffer())).toEqual(new Uint8Array([0x50, 0x4b, 3, 4]))
    await expect(client.getStream('/missing')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
