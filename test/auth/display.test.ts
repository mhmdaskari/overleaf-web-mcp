import { describe, expect, test, vi } from 'vitest'

import { chromeEnvironment } from '../../src/auth/display.js'
import { McpError } from '../../src/core/errors.js'

// What an MCP client on Linux passes its servers: no display variables at all.
const STRIPPED = { HOME: '/home/u', PATH: '/usr/bin:/bin', USER: 'u' }

const SESSION = [
  'HOME=/home/u',
  'DISPLAY=:0',
  'WAYLAND_DISPLAY=wayland-0',
  'XAUTHORITY=/run/user/1000/.mutter-Xwaylandauth.ABC123',
  'XDG_RUNTIME_DIR=/run/user/1000',
  'DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus',
  'XDG_SESSION_TYPE=wayland',
  'XDG_CURRENT_DESKTOP=ubuntu:GNOME',
  'SSH_AUTH_SOCK=/run/user/1000/keyring/ssh',
  'PATH=/should/not/replace',
  '',
].join('\n')

function options(overrides: Partial<Parameters<typeof chromeEnvironment>[0]> = {}) {
  return {
    env: STRIPPED,
    platform: 'linux' as const,
    uid: 1000,
    directoryExists: async (path: string) => path === '/run/user/1000',
    readSessionEnvironment: vi.fn(async () => SESSION),
    ...overrides,
  }
}

describe('chromeEnvironment', () => {
  test('leaves the environment alone off Linux', async () => {
    for (const platform of ['darwin', 'win32'] as const) {
      const opts = options({ platform })
      expect(await chromeEnvironment(opts)).toEqual(STRIPPED)
      expect(opts.readSessionEnvironment).not.toHaveBeenCalled()
    }
  })

  test('leaves the environment alone when it already names a display', async () => {
    for (const display of [{ DISPLAY: ':1' }, { WAYLAND_DISPLAY: 'wayland-1' }]) {
      const opts = options({ env: { ...STRIPPED, ...display } })
      expect(await chromeEnvironment(opts)).toEqual({ ...STRIPPED, ...display })
      expect(opts.readSessionEnvironment).not.toHaveBeenCalled()
    }
  })

  test('recovers the desktop session display variables from the user session manager', async () => {
    const opts = options()
    const env = await chromeEnvironment(opts)

    expect(env).toEqual({
      ...STRIPPED,
      DISPLAY: ':0',
      WAYLAND_DISPLAY: 'wayland-0',
      XAUTHORITY: '/run/user/1000/.mutter-Xwaylandauth.ABC123',
      XDG_RUNTIME_DIR: '/run/user/1000',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
      XDG_SESSION_TYPE: 'wayland',
      XDG_CURRENT_DESKTOP: 'ubuntu:GNOME',
    })
    // The session manager is reachable only through the runtime directory, which the client dropped.
    expect(opts.readSessionEnvironment).toHaveBeenCalledWith({ ...STRIPPED, XDG_RUNTIME_DIR: '/run/user/1000' })
  })

  test('never overrides a variable the server was given', async () => {
    const env = await chromeEnvironment(
      options({ env: { ...STRIPPED, XDG_RUNTIME_DIR: '/custom/runtime' }, directoryExists: async () => true })
    )
    expect(env.XDG_RUNTIME_DIR).toBe('/custom/runtime')
    expect(env.DISPLAY).toBe(':0')
  })

  test('skips values the session manager prints quoted', async () => {
    const env = await chromeEnvironment(
      options({ readSessionEnvironment: async () => "DISPLAY=:0\nXAUTHORITY=$'/run/user/1000/odd\\nname'\n" })
    )
    expect(env.DISPLAY).toBe(':0')
    expect(env).not.toHaveProperty('XAUTHORITY')
  })

  test('refuses before any window when no display can be found', async () => {
    const cases = [
      options({ readSessionEnvironment: async () => 'HOME=/home/u\n' }),
      options({
        readSessionEnvironment: async () => {
          throw new Error('Failed to connect to user scope bus')
        },
      }),
    ]
    for (const opts of cases) {
      const failure = await chromeEnvironment(opts).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(McpError)
      expect(failure).toMatchObject({ code: 'NOT_FOUND', details: { reason: 'no_display' } })
      expect((failure as McpError).message).toContain('DISPLAY')
    }
  })

  test('does not ask the session manager without a runtime directory to reach it', async () => {
    const opts = options({ directoryExists: async () => false })
    await expect(chromeEnvironment(opts)).rejects.toMatchObject({ details: { reason: 'no_display' } })
    expect(opts.readSessionEnvironment).not.toHaveBeenCalled()
  })
})
