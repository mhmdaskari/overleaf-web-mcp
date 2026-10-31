import { chmod, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CookieJar } from 'tough-cookie'
import { describe, expect, test, vi } from 'vitest'

import {
  assertCookieFilePermissions,
  CookieStore,
  parseNetscapeCookies,
  writeCookieJar,
} from '../../src/http/cookies.js'

describe('Netscape cookie jars', () => {
  test('turns a missing default jar into actionable login guidance', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'overleaf-cookie-missing-'))
    const path = join(directory, 'cookies.txt')

    await expect(CookieStore.load(path)).rejects.toMatchObject({
      code: 'AUTH_EXPIRED',
      message: expect.stringMatching(/overleaf-web-mcp login/iu),
    })
  })

  test('parses regular and HttpOnly cookie export lines', async () => {
    const jar = await parseNetscapeCookies(`# Netscape HTTP Cookie File
.overleaf.test\tTRUE\t/\tTRUE\t2147483647\toverleaf.sid\tsession
#HttpOnly_.overleaf.test\tTRUE\t/\tTRUE\t2147483647\tcsrf\ttoken
`)

    expect(await jar.getCookieString('https://www.overleaf.test/project')).toContain('overleaf.sid=session')
    expect(await jar.getCookieString('https://www.overleaf.test/project')).toContain('csrf=token')
  })

  test('rejects group/world-readable files on POSIX', async () => {
    if (process.platform === 'win32') return
    const directory = await mkdtemp(join(tmpdir(), 'overleaf-cookie-test-'))
    const path = join(directory, 'cookies.txt')
    await writeFile(path, 'cookies')
    await chmod(path, 0o644)

    await expect(assertCookieFilePermissions(path)).rejects.toThrow(/0600/u)
    await chmod(path, 0o600)
    await expect(assertCookieFilePermissions(path)).resolves.toMatchObject({
      permissionsUnchecked: false,
    })
  })

  test('persists a refreshed cookie without replacing the live jar object', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'overleaf-cookie-refresh-'))
    const path = join(directory, 'cookies.txt')
    await writeFile(
      path,
      '# Netscape HTTP Cookie File\n.overleaf.test\tTRUE\t/\tTRUE\t2147483647\toverleaf.sid\told\n',
      { mode: 0o600 }
    )
    const store = await CookieStore.load(path)
    const liveJar = store.jar

    await store.mergeSetCookies('https://overleaf.test/project', [
      'overleaf.sid=new; Domain=overleaf.test; Path=/; Secure',
    ])

    expect(store.jar).toBe(liveJar)
    expect(await liveJar.getCookieString('https://overleaf.test/project')).toContain('overleaf.sid=new')
    expect(await readFile(path, 'utf8')).toContain('overleaf.sid\tnew')
  })

  test('creates a protected Netscape jar in a new config directory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'overleaf-cookie-login-'))
    const path = join(directory, 'nested', 'cookies.txt')
    const jar = new CookieJar()
    await jar.setCookie(
      'overleaf_session2=session; Domain=overleaf.test; Path=/; Secure; HttpOnly',
      'https://overleaf.test/project'
    )

    await writeCookieJar(path, jar)

    expect(await readFile(path, 'utf8')).toContain('overleaf_session2\tsession')
    if (process.platform !== 'win32') {
      expect((await stat(path)).mode & 0o777).toBe(0o600)
    }
    const loaded = await CookieStore.load(path)
    expect(await loaded.jar.getCookieString('https://overleaf.test/project')).toContain('overleaf_session2=session')
  })

  test('writes domain cookies with the subdomain flag other Netscape readers rely on', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'overleaf-cookie-scope-'))
    const path = join(directory, 'cookies.txt')
    const jar = new CookieJar()
    await jar.setCookie(
      'overleaf_session2=session; Domain=.overleaf.test; Path=/; Secure; HttpOnly',
      'https://www.overleaf.test/project'
    )
    await jar.setCookie('balancer=host; Path=/; Secure', 'https://www.overleaf.test/project')

    await writeCookieJar(path, jar)

    const lines = (await readFile(path, 'utf8')).split('\n')
    // tough-cookie strips the leading dot from `domain`; the flag must come from `hostOnly`.
    expect(lines).toContain('#HttpOnly_.overleaf.test\tTRUE\t/\tTRUE\t0\toverleaf_session2\tsession')
    expect(lines).toContain('www.overleaf.test\tFALSE\t/\tTRUE\t0\tbalancer\thost')
    const loaded = await CookieStore.load(path)
    expect(await loaded.jar.getCookieString('https://www.overleaf.test/project')).toContain('overleaf_session2=session')
  })

  test('keeps a Max-Age deadline across a write and a reload', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'overleaf-cookie-deadline-'))
    const path = join(directory, 'cookies.txt')
    const jar = new CookieJar()
    await jar.setCookie(
      'overleaf_session2=session; Domain=.overleaf.test; Path=/; Secure; HttpOnly; Max-Age=432000',
      'https://www.overleaf.test/project'
    )
    const [issued] = await jar.getCookies('https://www.overleaf.test/project')
    const deadline = Math.floor((issued?.expiryTime() ?? Number.NaN) / 1000)
    expect(Number.isFinite(deadline)).toBe(true)

    await writeCookieJar(path, jar)

    // Before the fix this column read 0, because `expires` stays Infinity for a Max-Age cookie.
    expect(await readFile(path, 'utf8')).toContain(`\t${deadline}\toverleaf_session2\t`)
    const loaded = await CookieStore.load(path)
    expect(await loaded.sessionExpiresAt('https://www.overleaf.test/project')).toBe(
      new Date(deadline * 1000).toISOString()
    )
  })

  test('dates a Max-Age deadline from its arrival, not from the latest read', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'overleaf-cookie-received-'))
    const path = join(directory, 'cookies.txt')
    await writeFile(path, '# Netscape HTTP Cookie File\n', { mode: 0o600 })
    const store = await CookieStore.load(path)
    const arrived = Date.parse('2026-10-19T23:31:59.900Z')
    const deadline = new Date(arrived + 432_000_000).toISOString()

    vi.useFakeTimers({ toFake: ['Date'], now: arrived })
    try {
      await store.mergeSetCookies('https://www.overleaf.test/project', [
        'overleaf_session2=rolled; Domain=.overleaf.test; Path=/; Secure; HttpOnly; Max-Age=432000',
      ])
      // tough-cookie counts Max-Age from the last read, so a read past the next second moved it.
      vi.setSystemTime(arrived + 200)
      expect(await store.sessionExpiresAt('https://www.overleaf.test/project')).toBe(deadline)
      expect(await readFile(path, 'utf8')).toContain(
        `\t${Math.floor(Date.parse(deadline) / 1000)}\toverleaf_session2\trolled`
      )
    } finally {
      vi.useRealTimers()
    }
  })

  test('keeps a cookie whose Max-Age reaches past the latest date', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'overleaf-cookie-far-'))
    const path = join(directory, 'cookies.txt')
    await writeFile(path, '# Netscape HTTP Cookie File\n', { mode: 0o600 })
    const store = await CookieStore.load(path)

    await store.mergeSetCookies('https://www.overleaf.test/project', [
      'overleaf_session2=far; Domain=.overleaf.test; Path=/; Secure; HttpOnly; Max-Age=99999999999999999999',
    ])

    expect(await store.sessionExpiresAt('https://www.overleaf.test/project')).toBe(new Date(8.64e15).toISOString())
    expect(await readFile(path, 'utf8')).toContain('\toverleaf_session2\tfar')
  })

  test('reports the earliest finite deadline among the cookies a request would carry', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'overleaf-cookie-expiry-'))
    const path = join(directory, 'cookies.txt')
    await writeFile(
      path,
      [
        '# Netscape HTTP Cookie File',
        '.overleaf.test\tTRUE\t/\tTRUE\t0\tbalancer\tsession-only',
        '.overleaf.test\tTRUE\t/\tTRUE\t2147483647\tpreference\tlater',
        '#HttpOnly_.overleaf.test\tTRUE\t/\tTRUE\t1893456000\toverleaf_session2\tsession',
        '',
      ].join('\n'),
      { mode: 0o600 }
    )
    const store = await CookieStore.load(path)

    expect(await store.sessionExpiresAt('https://www.overleaf.test/project')).toBe('2030-01-01T00:00:00.000Z')
    // Nothing is sent to an unrelated host, so there is no deadline to report.
    expect(await store.sessionExpiresAt('https://elsewhere.test/')).toBeUndefined()
  })

  test('reports no deadline when every cookie is a session cookie', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'overleaf-cookie-session-only-'))
    const path = join(directory, 'cookies.txt')
    await writeFile(path, '# Netscape HTTP Cookie File\n.overleaf.test\tTRUE\t/\tTRUE\t0\toverleaf.sid\tsession\n', {
      mode: 0o600,
    })
    const store = await CookieStore.load(path)

    expect(await store.sessionExpiresAt('https://www.overleaf.test/project')).toBeUndefined()
  })
})
