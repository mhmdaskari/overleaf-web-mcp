import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test, vi } from 'vitest'

import { readConfig } from '../src/config.js'
import { McpError } from '../src/core/errors.js'
import { SESSION_RUNTIME_MEMBERS, SessionRuntime, type SessionRuntimeOptions } from '../src/session-runtime.js'
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
