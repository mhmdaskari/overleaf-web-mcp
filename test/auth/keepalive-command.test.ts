import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'vitest'

import { runKeepaliveCommand } from '../../src/auth/keepalive-command.js'
import { readConfig, type AppConfig } from '../../src/config.js'
import { OverleafRuntime } from '../../src/runtime.js'

const AUTHENTICATED_PAGE = '<meta name="ol-csrfToken" content="csrf"><meta name="ol-user_id" content="user">'
const FIVE_DAYS_MS = 432_000_000

async function jarWithSession() {
  const directory = await mkdtemp(join(tmpdir(), 'overleaf-keepalive-'))
  const cookiePath = join(directory, 'cookies.txt')
  await writeFile(cookiePath, '# Netscape HTTP Cookie File\n.overleaf.test\tTRUE\t/\tTRUE\t0\toverleaf.sid\tstale\n')
  if (process.platform !== 'win32') await chmod(cookiePath, 0o600)
  return {
    cookiePath,
    config: readConfig({
      OVERLEAF_COOKIE_JAR_FILE: cookiePath,
      OVERLEAF_BASE_URL: 'https://overleaf.test',
    }),
  }
}

/** The real runtime with a scripted Overleaf and a socket factory that must never be reached. */
function runtimeAnswering(respond: (url: string) => Response) {
  return async (config: AppConfig) =>
    await OverleafRuntime.create(config, {
      fetcher: async input => respond(String(input)),
      connectionFactory: async () => {
        throw new Error('keepalive must not open a project socket')
      },
    })
}

describe('keepalive command', () => {
  test('refreshes the session, reports the new deadline, and persists it to the jar', async () => {
    const { cookiePath, config } = await jarWithSession()
    const before = Date.now()

    const result = await runKeepaliveCommand(config, {
      createRuntime: runtimeAnswering(url => {
        expect(url).toBe('https://overleaf.test/project')
        return new Response(AUTHENTICATED_PAGE, {
          status: 200,
          headers: {
            'set-cookie': 'overleaf.sid=rolled; Domain=.overleaf.test; Path=/; Secure; HttpOnly; Max-Age=432000',
          },
        })
      }),
    })

    expect(result).toMatchObject({ refreshed: true, baseUrl: 'https://overleaf.test', userId: 'user' })
    const deadline = Date.parse(result.sessionExpiresAt ?? '')
    expect(deadline).toBeGreaterThanOrEqual(before + FIVE_DAYS_MS - 5_000)
    expect(deadline).toBeLessThanOrEqual(Date.now() + FIVE_DAYS_MS + 5_000)
    // The deadline must survive on disk, or the next run and auth_status would both lose it.
    const jar = await readFile(cookiePath, 'utf8')
    expect(jar).toContain(`\t${Math.floor(deadline / 1000)}\toverleaf.sid\trolled`)
    expect(jar).not.toContain('\tstale')
  })

  test('reports a session that redirects to the login page as AUTH_EXPIRED, not as refreshed', async () => {
    const { config } = await jarWithSession()
    const loginPage = new Response('<html>Log in</html>', { status: 200 })
    Object.defineProperty(loginPage, 'url', { value: 'https://overleaf.test/login' })

    await expect(
      runKeepaliveCommand(config, { createRuntime: runtimeAnswering(() => loginPage) })
    ).rejects.toMatchObject({ code: 'AUTH_EXPIRED' })
  })

  test('treats a page without the authenticated CSRF token as an expired session', async () => {
    const { config } = await jarWithSession()

    await expect(
      runKeepaliveCommand(config, {
        createRuntime: runtimeAnswering(() => new Response('<html>anonymous</html>')),
      })
    ).rejects.toMatchObject({ code: 'AUTH_EXPIRED' })
  })
})
