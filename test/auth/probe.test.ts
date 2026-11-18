import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'vitest'

import { probeSavedSession } from '../../src/auth/probe.js'
import { readConfig } from '../../src/config.js'
import { OverleafRuntime } from '../../src/runtime.js'

async function expiredSession() {
  const directory = await mkdtemp(join(tmpdir(), 'overleaf-probe-'))
  const cookieJarFile = join(directory, 'cookies.txt')
  await writeFile(
    cookieJarFile,
    '# Netscape HTTP Cookie File\n.overleaf.test\tTRUE\t/\tTRUE\t2147483647\toverleaf.sid\texpired\n',
    { mode: 0o600 }
  )
  const config = readConfig({
    OVERLEAF_COOKIE_JAR_FILE: cookieJarFile,
    OVERLEAF_BROWSER_PROFILE_DIR: join(directory, 'profile'),
    OVERLEAF_BASE_URL: 'https://overleaf.test',
  })
  return { config, cookieJarFile }
}

/** Overleaf's answer to an expired session: the login page, with an anonymous session cookie. */
const loginRedirect = async (): Promise<Response> => {
  const response = new Response('<html>login</html>', {
    headers: { 'set-cookie': 'overleaf.sid=anonymous; Domain=overleaf.test; Path=/; Secure' },
  })
  Object.defineProperty(response, 'url', { value: 'https://overleaf.test/login' })
  return await Promise.resolve(response)
}

describe('probeSavedSession', () => {
  test('reports an expired session as AUTH_EXPIRED and leaves the session file untouched', async () => {
    const { config, cookieJarFile } = await expiredSession()
    const before = { bytes: await readFile(cookieJarFile), mtime: (await stat(cookieJarFile)).mtimeMs }

    await expect(probeSavedSession(config, { fetcher: loginRedirect })).rejects.toMatchObject({ code: 'AUTH_EXPIRED' })

    expect(await readFile(cookieJarFile)).toEqual(before.bytes)
    expect((await stat(cookieJarFile)).mtimeMs).toBe(before.mtime)
  })

  test('where opening a runtime would save the anonymous cookie over the file', async () => {
    // The reason sign_in probes instead of opening a runtime before it opens a window.
    const { config, cookieJarFile } = await expiredSession()
    await expect(OverleafRuntime.create(config, { fetcher: loginRedirect })).rejects.toMatchObject({
      code: 'AUTH_EXPIRED',
    })
    expect(await readFile(cookieJarFile, 'utf8')).toContain('overleaf.sid\tanonymous')
  })

  test('reports a missing session file as AUTH_EXPIRED', async () => {
    const config = readConfig({
      OVERLEAF_COOKIE_JAR_FILE: join(await mkdtemp(join(tmpdir(), 'overleaf-probe-missing-')), 'cookies.txt'),
    })
    await expect(probeSavedSession(config)).rejects.toMatchObject({ code: 'AUTH_EXPIRED' })
  })
})
