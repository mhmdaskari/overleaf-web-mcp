import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { promisify } from 'node:util'

import { McpError } from '../core/errors.js'

/**
 * What Chrome needs from the desktop session to open a window on Linux. MCP clients start
 * servers with a short allowlist of variables (HOME, LOGNAME, PATH, SHELL, USER), so none of
 * these reach a server a desktop app starts, and Chrome exits before opening.
 */
const SESSION_DISPLAY_VARIABLES = [
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XAUTHORITY',
  'XDG_RUNTIME_DIR',
  'DBUS_SESSION_BUS_ADDRESS',
  'XDG_SESSION_TYPE',
  'XDG_CURRENT_DESKTOP',
] as const

export interface ChromeEnvironmentOptions {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  uid?: number
  directoryExists?: (path: string) => Promise<boolean>
  /** Prints the user session manager's environment, one `NAME=value` per line. */
  readSessionEnvironment?: (env: NodeJS.ProcessEnv) => Promise<string>
}

const execFileAsync = promisify(execFile)

async function systemdUserEnvironment(env: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await execFileAsync('systemctl', ['--user', 'show-environment'], {
    env,
    timeout: 2_000,
    maxBuffer: 1024 * 1024,
  })
  return stdout
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

function hasDisplay(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.DISPLAY ?? env.WAYLAND_DISPLAY)
}

function noDisplay(): McpError {
  return new McpError(
    'NOT_FOUND',
    'No desktop display was found to open the sign-in window: the server has neither DISPLAY nor WAYLAND_DISPLAY, and the desktop session did not provide them. Sign in from a terminal with `npx overleaf-web-mcp login`, or set DISPLAY or WAYLAND_DISPLAY in the server environment.',
    { details: { reason: 'no_display' } }
  )
}

/**
 * The environment to start Chrome with. On Linux, a server started by a desktop app has no
 * display variables, so they are read from the user's systemd session, which the desktop sets.
 * A variable the server was given is never replaced, and no value is logged or returned in an
 * error.
 */
export async function chromeEnvironment(options: ChromeEnvironmentOptions = {}): Promise<NodeJS.ProcessEnv> {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  if (platform !== 'linux' || hasDisplay(env)) return env

  const uid = options.uid ?? process.getuid?.()
  const directoryExists = options.directoryExists ?? isDirectory
  const runtimeDir = env.XDG_RUNTIME_DIR ?? (uid === undefined ? undefined : `/run/user/${uid}`)
  if (runtimeDir === undefined || !(await directoryExists(runtimeDir))) throw noDisplay()

  let listing: string
  try {
    listing = await (options.readSessionEnvironment ?? systemdUserEnvironment)({
      ...env,
      XDG_RUNTIME_DIR: runtimeDir,
    })
  } catch {
    throw noDisplay()
  }

  const recovered: NodeJS.ProcessEnv = {}
  for (const line of listing.split('\n')) {
    const separator = line.indexOf('=')
    if (separator <= 0) continue
    const name = line.slice(0, separator)
    const value = line.slice(separator + 1)
    // systemd prints a value holding special characters as $'…'; such a value is not trusted.
    if (value === '' || value.startsWith("$'")) continue
    if ((SESSION_DISPLAY_VARIABLES as readonly string[]).includes(name) && env[name] === undefined) {
      recovered[name] = value
    }
  }
  const result = { ...env, ...recovered }
  if (!hasDisplay(result)) throw noDisplay()
  return result
}
