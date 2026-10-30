import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test, vi } from 'vitest'

import { captureBrowserSession, type BrowserProcess, type CdpTransport } from '../../src/auth/browser-login.js'

describe('browser-assisted login', () => {
  test('captures only target-origin cookies after the authenticated project page loads', async () => {
    const profileDir = await mkdtemp(join(tmpdir(), 'overleaf-browser-profile-'))
    const calls: string[] = []
    const closeCdp = vi.fn()
    const cdp: CdpTransport = {
      closed: false,
      async send<T>(method: string): Promise<T> {
        calls.push(method)
        if (method === 'Target.getTargets') {
          return { targetInfos: [{ targetId: 'page-1', type: 'page' }] } as T
        }
        if (method === 'Target.attachToTarget') return { sessionId: 'session-1' } as T
        if (method === 'Runtime.evaluate') {
          return {
            result: {
              value: {
                origin: 'https://www.overleaf.test',
                pathname: '/project',
                csrfToken: 'csrf',
              },
            },
          } as T
        }
        if (method === 'Storage.getCookies') {
          return {
            cookies: [
              {
                name: 'overleaf_session2',
                value: 'secret-session',
                domain: '.overleaf.test',
                path: '/',
                secure: true,
                httpOnly: true,
                expires: 2_147_483_647,
              },
              {
                name: 'unrelated',
                value: 'ignore-me',
                domain: '.example.test',
                path: '/',
                secure: true,
                httpOnly: false,
                expires: -1,
              },
            ],
          } as T
        }
        return {} as T
      },
      close: closeCdp,
    }
    let killed = false
    const process: BrowserProcess = {
      exitCode: null,
      kill: () => {
        killed = true
        return true
      },
    }

    const result = await captureBrowserSession(
      {
        baseUrl: 'https://www.overleaf.test',
        browserProfileDir: profileDir,
        timeoutMs: 5_000,
      },
      {
        findChrome: async () => '/opt/chrome',
        spawnChrome: () => process,
        readEndpoint: async () => 'ws://127.0.0.1/devtools/browser/id',
        connectCdp: async () => cdp,
        sleep: async () => undefined,
      }
    )

    expect(await result.jar.getCookieString('https://www.overleaf.test/project')).toContain(
      'overleaf_session2=secret-session'
    )
    expect(await result.jar.getCookieString('https://example.test/')).not.toContain('unrelated')
    expect(result.cookieCount).toBe(1)
    expect(calls).toContain('Storage.getCookies')
    expect(closeCdp).toHaveBeenCalled()
    expect(killed).toBe(true)
  })

  test('times out without returning a partial session', async () => {
    const profileDir = await mkdtemp(join(tmpdir(), 'overleaf-browser-timeout-'))
    const cdp: CdpTransport = {
      closed: false,
      async send<T>(method: string): Promise<T> {
        if (method === 'Target.getTargets') {
          return { targetInfos: [{ targetId: 'page-1', type: 'page' }] } as T
        }
        if (method === 'Target.attachToTarget') return { sessionId: 'session-1' } as T
        if (method === 'Runtime.evaluate') {
          return {
            result: {
              value: {
                origin: 'https://www.overleaf.test',
                pathname: '/login',
                csrfToken: null,
              },
            },
          } as T
        }
        return {} as T
      },
      close: vi.fn(),
    }
    let now = 0

    await expect(
      captureBrowserSession(
        {
          baseUrl: 'https://www.overleaf.test',
          browserProfileDir: profileDir,
          timeoutMs: 2,
        },
        {
          findChrome: async () => '/opt/chrome',
          spawnChrome: () => ({ exitCode: null, kill: () => true }),
          readEndpoint: async () => 'ws://127.0.0.1/devtools/browser/id',
          connectCdp: async () => cdp,
          sleep: async () => {
            now += 2
          },
          now: () => now,
        }
      )
    ).rejects.toMatchObject({ code: 'TIMEOUT' })
  })
})
