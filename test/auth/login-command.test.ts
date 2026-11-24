import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import lockfile from 'proper-lockfile'
import { CookieJar } from 'tough-cookie'
import { describe, expect, test, vi } from 'vitest'

import { captureBrowserSession, type CdpTransport } from '../../src/auth/browser-login.js'
import { runLoginCommand } from '../../src/auth/login-command.js'
import { readConfig } from '../../src/config.js'

/**
 * A capture that waits until its signal stops it, as the real one does: one stopped before it
 * starts, which happens when the stop lands while the profile is still being locked, rejects at once.
 */
async function captureUntilStopped(options: { signal?: AbortSignal | undefined }): Promise<never> {
  return await new Promise((_resolve, reject) => {
    const signal = options.signal
    if (signal === undefined) return
    if (signal.aborted) reject(signal.reason)
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
}

describe('login command', () => {
  test('captures, securely persists, and verifies a browser session', async () => {
    const configRoot = await mkdtemp(join(tmpdir(), 'overleaf-login-test-'))
    const config = readConfig(
      {
        XDG_CONFIG_HOME: configRoot,
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
            browserProfileDir: config.browserProfileDir,
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
      cookieJarFile: config.cookieJarFile,
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
        captureSession: captureUntilStopped,
        persistSession,
      }
    )
    await vi.waitFor(async () => expect(await lockfile.check(config.browserProfileDir)).toBe(true))
    controller.abort(new Error('stopped'))

    await expect(login).rejects.toThrow('stopped')
    expect(persistSession).not.toHaveBeenCalled()
    expect(await lockfile.check(config.browserProfileDir)).toBe(false)
  })

  test('stops before the browser when stopped while the profile is being locked', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'overleaf-login-early-'))
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
        captureSession: captureUntilStopped,
        persistSession,
      }
    )
    // Stopped before the lock is taken, so the capture starts with its signal already aborted.
    controller.abort(new Error('stopped'))

    await expect(login).rejects.toThrow('stopped')
    expect(persistSession).not.toHaveBeenCalled()
    expect(await lockfile.check(config.browserProfileDir)).toBe(false)
  })

  test.each([
    ['the sign-in times out', 'TIMEOUT', false],
    ['the window is closed', 'AUTH_EXPIRED', true],
  ])('leaves an existing session file byte-for-byte unchanged when %s', async (_case, code, closes) => {
    const directory = await mkdtemp(join(tmpdir(), 'overleaf-login-unchanged-'))
    const config = readConfig({
      OVERLEAF_COOKIE_JAR_FILE: join(directory, 'cookies.txt'),
      OVERLEAF_BROWSER_PROFILE_DIR: join(directory, 'profile'),
      OVERLEAF_BASE_URL: 'https://www.overleaf.test',
      OVERLEAF_LOGIN_TIMEOUT_MS: '10',
    })
    await writeFile(
      config.cookieJarFile,
      '# Netscape HTTP Cookie File\n.overleaf.test\tTRUE\t/\tTRUE\t2147483647\toverleaf.sid\texpired\n',
      { mode: 0o600 }
    )
    const before = { bytes: await readFile(config.cookieJarFile), mtime: (await stat(config.cookieJarFile)).mtimeMs }
    // The real capture and the real writeCookieJar, with only the browser faked: still on the login page.
    const cdp: CdpTransport = {
      closed: false,
      async send<T>(method: string): Promise<T> {
        if (method === 'Target.getTargets') return { targetInfos: [{ targetId: 'page-1', type: 'page' }] } as T
        if (method === 'Target.attachToTarget') return { sessionId: 'session-1' } as T
        if (method === 'Runtime.evaluate') {
          return {
            result: { value: { origin: 'https://www.overleaf.test', pathname: '/login', csrfToken: null } },
          } as T
        }
        return {} as T
      },
      close: vi.fn(),
    }
    let now = 0
    const browser = { exitCode: null as number | null, kill: () => true }

    await expect(
      runLoginCommand(
        config,
        {},
        {
          captureSession: async options =>
            await captureBrowserSession(options, {
              findChrome: async () => '/opt/chrome',
              browserEnvironment: async () => ({}),
              spawnChrome: () => browser,
              readEndpoint: async () => 'ws://127.0.0.1/devtools/browser/id',
              connectCdp: async () => cdp,
              sleep: async () => {
                now += 4
                if (closes) browser.exitCode = 0
              },
              now: () => now,
            }),
        }
      )
    ).rejects.toMatchObject({ code })

    expect(await readFile(config.cookieJarFile)).toEqual(before.bytes)
    expect((await stat(config.cookieJarFile)).mtimeMs).toBe(before.mtime)
  })
})
