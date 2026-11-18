import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test, vi } from 'vitest'

import { readConfig } from '../src/config.js'
import { McpError } from '../src/core/errors.js'
import {
  SESSION_RUNTIME_MEMBERS,
  SessionRuntime,
  signInOfferedBy,
  type SessionRuntimeOptions,
} from '../src/session-runtime.js'
import { fakeServiceRuntime } from './helpers/fake-runtime.js'

type FakeRuntime = ReturnType<typeof fakeServiceRuntime>

const expired = () => new McpError('AUTH_EXPIRED', 'No saved Overleaf web session was found.')

async function config() {
  const directory = await mkdtemp(join(tmpdir(), 'overleaf-session-runtime-'))
  return readConfig({
    OVERLEAF_COOKIE_JAR_FILE: join(directory, 'cookies.txt'),
    OVERLEAF_BROWSER_PROFILE_DIR: join(directory, 'profile'),
  })
}

/** A session file whose modification time the test moves by hand, and a factory to go with it. */
function harness(outcomes: Array<FakeRuntime | Error>) {
  const created: FakeRuntime[] = []
  let stamp: number | undefined = 1
  const createRuntime = vi.fn(async () => {
    const next = outcomes.shift()
    if (next === undefined) throw new Error('no runtime left for this test')
    if (next instanceof Error) throw next
    created.push(next)
    return next
  })
  const options: SessionRuntimeOptions = {
    createRuntime,
    sessionFileStamp: async () => stamp,
  }
  return {
    created,
    createRuntime,
    options,
    touch: () => {
      stamp = (stamp ?? 0) + 1
    },
  }
}

describe('SessionRuntime', () => {
  test('starts signed out when there is no working session, and answers AUTH_EXPIRED', async () => {
    const { options, createRuntime } = harness([expired()])
    const session = await SessionRuntime.start(await config(), options)

    await expect(session.authStatus()).rejects.toMatchObject({
      code: 'AUTH_EXPIRED',
      message: expect.stringMatching(/overleaf-web-mcp login/u),
    })
    // The session file has not changed, so no new attempt was made.
    expect(createRuntime).toHaveBeenCalledTimes(1)
    await session.close()
  })

  test('still fails at startup for anything but a missing or expired session', async () => {
    const { options } = harness([new McpError('PERMISSION_DENIED', 'The session file is readable by others.')])
    await expect(SessionRuntime.start(await config(), options)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
  })

  test('picks up a session saved after it started, without a restart', async () => {
    const runtime = fakeServiceRuntime()
    const { options, createRuntime, touch } = harness([expired(), runtime])
    const session = await SessionRuntime.start(await config(), options)

    touch()
    await expect(session.authStatus()).resolves.toEqual(await fakeServiceRuntime().authStatus())
    expect(runtime.authStatus).toHaveBeenCalledTimes(1)
    expect(createRuntime).toHaveBeenCalledTimes(2)
    await session.close()
    expect(runtime.close).toHaveBeenCalledTimes(1)
  })

  test('a call that finds the session expired drops the runtime, and the next call reads the file again', async () => {
    const first = fakeServiceRuntime()
    const second = fakeServiceRuntime()
    first.account.listProjects.mockRejectedValueOnce(expired())
    const { options, createRuntime } = harness([first, second])
    const session = await SessionRuntime.start(await config(), options)

    await expect(session.account.listProjects({})).rejects.toMatchObject({ code: 'AUTH_EXPIRED' })
    expect(first.close).toHaveBeenCalledTimes(1)
    await session.account.listProjects({})
    expect(second.account.listProjects).toHaveBeenCalledTimes(1)
    expect(createRuntime).toHaveBeenCalledTimes(2)
    await session.close()
  })

  test('closes a dropped runtime only after its other calls settle', async () => {
    const runtime = fakeServiceRuntime()
    let finishWrite!: () => void
    runtime.documents.writeFile.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finishWrite = () => resolve({})
        })
    )
    runtime.account.listProjects.mockRejectedValueOnce(expired())
    const { options } = harness([runtime])
    const session = await SessionRuntime.start(await config(), options)

    const write = session.documents.writeFile('p', 'main.tex', 'text', 'r')
    await expect(session.account.listProjects({})).rejects.toMatchObject({ code: 'AUTH_EXPIRED' })
    expect(runtime.close).not.toHaveBeenCalled()
    finishWrite()
    await write
    expect(runtime.close).toHaveBeenCalledTimes(1)
    await session.close()
  })

  test('concurrent calls share one attempt to open the session', async () => {
    const runtime = fakeServiceRuntime()
    const { options, createRuntime, touch } = harness([expired(), runtime])
    const session = await SessionRuntime.start(await config(), options)

    touch()
    await Promise.all([session.authStatus(), session.account.listProjects({}), session.authStatus()])
    expect(createRuntime).toHaveBeenCalledTimes(2)
    await session.close()
  })

  test('delegates every member of the service runtime to the current runtime, once each', async () => {
    const runtime = fakeServiceRuntime()
    const { options } = harness([runtime])
    const session = await SessionRuntime.start(await config(), options)

    // The members the command line alone uses are not part of the service runtime.
    const cliOnly = new Set(['account.findProject', 'reviewSupport', 'close'])
    const fakeMembers = Object.entries(runtime).flatMap(([key, value]) =>
      typeof value === 'function' ? [key] : Object.keys(value).map(method => `${key}.${method}`)
    )
    const listed = SESSION_RUNTIME_MEMBERS.map(([group, method]) => (group === '' ? method : `${group}.${method}`))
    expect(listed.sort()).toEqual(fakeMembers.filter(member => !cliOnly.has(member)).sort())

    for (const [group, method] of SESSION_RUNTIME_MEMBERS) {
      const call = (group === '' ? session : (session as any)[group])[method] as (
        ...args: unknown[]
      ) => Promise<unknown>
      const target = (group === '' ? runtime : (runtime as any)[group])[method] as ReturnType<typeof vi.fn>
      await call('argument')
      expect(target, `${group}.${method}`).toHaveBeenCalledTimes(1)
      expect(target, `${group}.${method}`).toHaveBeenCalledWith('argument')
    }
    await session.close()
  })

  test('names sign_in in its message only when the configuration offers it', async () => {
    const offered = await SessionRuntime.start(await config(), { ...harness([expired()]).options, signInOffered: true })
    await expect(offered.authStatus()).rejects.toThrow(/sign_in/u)
    const hidden = await SessionRuntime.start(await config(), harness([expired()]).options)
    await expect(hidden.authStatus()).rejects.not.toThrow(/sign_in/u)
    expect(signInOfferedBy(readConfig({}))).toBe(true)
    expect(signInOfferedBy(readConfig({ OVERLEAF_TOOLSETS: 'files' }))).toBe(false)
    expect(signInOfferedBy(readConfig({ OVERLEAF_ALLOWED_EFFECTS: 'overleaf-read' }))).toBe(false)
    expect(signInOfferedBy(readConfig({ OVERLEAF_ALLOWED_EFFECTS: 'overleaf-read,sign-in' }))).toBe(true)
    await offered.close()
    await hidden.close()
  })

  test('exposes the access policy before any session exists', async () => {
    const { options } = harness([expired()])
    const session = await SessionRuntime.start(
      readConfig({ ...process.env, OVERLEAF_ALLOWED_PROJECTS: 'aaaaaaaaaaaaaaaaaaaaaaaa' }),
      options
    )
    expect(() => session.policy.assertProject('bbbbbbbbbbbbbbbbbbbbbbbb')).toThrow(/OVERLEAF_ALLOWED_PROJECTS|policy/iu)
    await session.close()
  })
})

describe('SessionRuntime.signIn', () => {
  /** A login that the test finishes or fails by hand, recording the signal it was given. */
  function pendingLogin() {
    const calls: AbortSignal[] = []
    let finish!: () => void
    let fail!: (error: unknown) => void
    const login = vi.fn(
      async (_config: unknown, options: { signal: AbortSignal }) =>
        await new Promise<void>((resolve, reject) => {
          calls.push(options.signal)
          finish = resolve
          fail = reject
          options.signal.addEventListener('abort', () => reject(options.signal.reason))
        })
    )
    return { login, calls, finish: () => finish(), fail: (error: unknown) => fail(error) }
  }

  async function signedOut(extra: Partial<SessionRuntimeOptions> = {}, outcomes: Array<FakeRuntime | Error> = []) {
    const h = harness([expired(), ...outcomes])
    const session = await SessionRuntime.start(await config(), {
      ...h.options,
      probe: async () => {
        throw expired()
      },
      signInWaitMs: 30,
      ...extra,
    })
    return { ...h, session }
  }

  test('reports a working session without opening anything', async () => {
    const runtime = fakeServiceRuntime()
    const { login } = pendingLogin()
    const h = harness([runtime])
    const session = await SessionRuntime.start(await config(), { ...h.options, login })

    await expect(session.signIn()).resolves.toMatchObject({ status: 'signed_in', alreadySignedIn: true })
    expect(login).not.toHaveBeenCalled()
    await session.close()
  })

  test('finds a session saved elsewhere with a read-only probe, and opens nothing', async () => {
    const { login } = pendingLogin()
    const probe = vi.fn(async () => undefined)
    const { session } = await signedOut({ login, probe }, [fakeServiceRuntime()])

    await expect(session.signIn()).resolves.toMatchObject({ status: 'signed_in', alreadySignedIn: true })
    expect(probe).toHaveBeenCalledTimes(1)
    expect(login).not.toHaveBeenCalled()
    await session.close()
  })

  test('signs in, then uses the new session', async () => {
    const pending = pendingLogin()
    const runtime = fakeServiceRuntime()
    const { session } = await signedOut({ login: pending.login, signInWaitMs: 1_000 }, [runtime])

    const result = session.signIn()
    await vi.waitFor(() => expect(pending.login).toHaveBeenCalledTimes(1))
    pending.finish()
    await expect(result).resolves.toMatchObject({ status: 'signed_in', alreadySignedIn: false, authenticated: true })
    expect(runtime.authStatus).toHaveBeenCalledTimes(1)
    await session.close()
  })

  test('returns waiting while the user signs in, refuses other calls, and reports the session next time', async () => {
    const pending = pendingLogin()
    const { session } = await signedOut({ login: pending.login }, [fakeServiceRuntime()])

    const waiting = await session.signIn()
    expect(waiting).toMatchObject({ status: 'waiting', deadline: expect.any(String) })
    await expect(session.account.listProjects({})).rejects.toMatchObject({
      code: 'AUTH_EXPIRED',
      details: { reason: 'sign_in_in_progress' },
    })
    // A second call joins the same sign-in instead of opening another window.
    await expect(session.signIn()).resolves.toMatchObject({ status: 'waiting' })
    expect(pending.login).toHaveBeenCalledTimes(1)

    pending.finish()
    await expect(session.signIn()).resolves.toMatchObject({ status: 'signed_in', alreadySignedIn: false })
    await session.close()
  })

  test('reports a failed sign-in once, opening nothing, and tries again only after it expires', async () => {
    const pending = pendingLogin()
    let clock = 1_000_000
    const { session } = await signedOut({ login: pending.login, now: () => clock })

    await expect(session.signIn()).resolves.toMatchObject({ status: 'waiting' })
    pending.fail(new McpError('AUTH_EXPIRED', 'Chrome closed before Overleaf login completed.'))
    await vi.waitFor(async () =>
      expect(session.account.listProjects({})).rejects.not.toMatchObject({ details: { reason: 'sign_in_in_progress' } })
    )

    await expect(session.signIn()).rejects.toMatchObject({
      code: 'AUTH_EXPIRED',
      message: expect.stringMatching(/Ask the user before calling sign_in again/u),
    })
    expect(pending.login).toHaveBeenCalledTimes(1)

    clock += 3 * 60_000
    await expect(session.signIn()).resolves.toMatchObject({ status: 'waiting' })
    expect(pending.login).toHaveBeenCalledTimes(2)
    await session.close()
  })

  test('a failure other than an expired session opens nothing', async () => {
    const { login } = pendingLogin()
    const { session } = await signedOut({
      login,
      probe: async () => {
        throw new McpError('REMOTE_ERROR', 'Overleaf could not be reached.')
      },
    })

    await expect(session.signIn()).rejects.toMatchObject({ code: 'REMOTE_ERROR' })
    expect(login).not.toHaveBeenCalled()
    await session.close()
  })

  test('refuses before anything when OVERLEAF_ALLOWED_EFFECTS leaves out sign-in', async () => {
    const { login } = pendingLogin()
    const probe = vi.fn()
    const h = harness([expired()])
    const session = await SessionRuntime.start(
      readConfig({ ...process.env, OVERLEAF_ALLOWED_EFFECTS: 'overleaf-read' }),
      { ...h.options, login, probe }
    )

    await expect(session.signIn()).rejects.toMatchObject({ code: 'POLICY_DENIED', details: { effect: 'sign-in' } })
    expect(probe).not.toHaveBeenCalled()
    expect(login).not.toHaveBeenCalled()
    await session.close()
  })

  test('closing the server stops a sign-in in progress', async () => {
    const pending = pendingLogin()
    const { session } = await signedOut({ login: pending.login })

    await expect(session.signIn()).resolves.toMatchObject({ status: 'waiting' })
    await session.close()
    expect(pending.calls[0]!.aborted).toBe(true)
  })

  test('sends progress while it waits', async () => {
    const pending = pendingLogin()
    const { session } = await signedOut({ login: pending.login, signInWaitMs: 60, signInProgressMs: 10 })
    const progress = vi.fn(async () => undefined)

    await expect(session.signIn(progress)).resolves.toMatchObject({ status: 'waiting' })
    expect(progress.mock.calls.length).toBeGreaterThan(0)
    await session.close()
  })
})
