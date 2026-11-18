import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import lockfile from 'proper-lockfile'
import { CookieJar } from 'tough-cookie'
import { describe, expect, test, vi } from 'vitest'

import { runLoginCommand } from '../../src/auth/login-command.js'
import { readConfig } from '../../src/config.js'

describe('login command', () => {
  test('captures, securely persists, and verifies a browser session', async () => {
    const config = readConfig(
      {
        XDG_CONFIG_HOME: '/tmp/overleaf-login-test',
        OVERLEAF_BASE_URL: 'https://overleaf.test',
      },
      { platform: 'linux', homeDir: '/home/alice' }
    )
    const jar = new CookieJar()
    await jar.setCookie(
      'overleaf_session2=secret-session; Domain=overleaf.test; Path=/; Secure',
      'https://overleaf.test/project'
    )
    const persistSession = vi.fn(async () => undefined)
    const close = vi.fn(async () => undefined)
    const statuses: string[] = []

    const result = await runLoginCommand(
      config,
      { onStatus: message => statuses.push(message) },
      {
        captureSession: async options => {
          expect(options).toMatchObject({
            baseUrl: 'https://overleaf.test',
            browserProfileDir: '/tmp/overleaf-login-test/overleaf-web-mcp/chrome-profile',
            timeoutMs: 300_000,
          })
          options.onStatus?.('Browser ready.')
          return { jar, cookieCount: 1 }
        },
        persistSession,
        createRuntime: async receivedConfig => {
          expect(receivedConfig).toBe(config)
          return {
            authStatus: async () => ({
              authenticated: true as const,
              baseUrl: config.baseUrl,
              projectCount: 2,
              permissionsUnchecked: false,
              socketPresenceNotice: 'presence notice',
            }),
            close,
          }
        },
      }
    )

    expect(persistSession).toHaveBeenCalledWith(config.cookieJarFile, jar)
    expect(close).toHaveBeenCalled()
    expect(statuses).toContain('Browser ready.')
    expect(result).toEqual({
      authenticated: true,
      baseUrl: 'https://overleaf.test',
      projectCount: 2,
      cookieJarFile: '/tmp/overleaf-login-test/overleaf-web-mcp/cookies.txt',
      cookiesCaptured: 1,
      permissionsUnchecked: false,
    })
    expect(JSON.stringify(result)).not.toContain('secret-session')
  })

  test('refuses, opening nothing, while another sign-in holds the browser profile', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'overleaf-login-lock-'))
    const config = readConfig({
      OVERLEAF_COOKIE_JAR_FILE: join(directory, 'cookies.txt'),
      OVERLEAF_BROWSER_PROFILE_DIR: join(directory, 'profile'),
      OVERLEAF_BASE_URL: 'https://overleaf.test',
    })
    const captureSession = vi.fn()
    const persistSession = vi.fn()
    // Another process signing in, through this same function, holds the lock.
    const holding = runLoginCommand(
      config,
      {},
      {
        captureSession: () => new Promise(() => undefined),
        persistSession,
      }
    )
    void holding.catch(() => undefined)
    await vi.waitFor(async () => expect(await lockfile.check(config.browserProfileDir)).toBe(true))

    await expect(runLoginCommand(config, {}, { captureSession, persistSession })).rejects.toMatchObject({
      code: 'AUTH_EXPIRED',
      details: { reason: 'sign_in_in_progress' },
    })
    expect(captureSession).not.toHaveBeenCalled()
    expect(persistSession).not.toHaveBeenCalled()
  })

  test('passes its signal to the browser and releases the profile when it stops', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'overleaf-login-signal-'))
    const config = readConfig({
      OVERLEAF_COOKIE_JAR_FILE: join(directory, 'cookies.txt'),
      OVERLEAF_BROWSER_PROFILE_DIR: join(directory, 'profile'),
      OVERLEAF_BASE_URL: 'https://overleaf.test',
    })
    const controller = new AbortController()
    const persistSession = vi.fn()
    const login = runLoginCommand(
      config,
      { signal: controller.signal },
      {
        captureSession: async options =>
          await new Promise((_resolve, reject) => {
            options.signal?.addEventListener('abort', () => reject(options.signal?.reason))
          }),
        persistSession,
      }
    )
    await vi.waitFor(async () => expect(await lockfile.check(config.browserProfileDir)).toBe(true))
    controller.abort(new Error('stopped'))

    await expect(login).rejects.toThrow('stopped')
    expect(persistSession).not.toHaveBeenCalled()
    expect(await lockfile.check(config.browserProfileDir)).toBe(false)
  })
})
