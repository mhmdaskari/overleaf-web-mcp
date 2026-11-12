import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'

export interface AuthPathOptions {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  homeDir?: string
}

export interface AuthPaths {
  cookieJarFile: string
  browserProfileDir: string
}

/** An empty or blank variable counts as unset, as the XDG Base Directory specification asks. */
function present(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === '' ? undefined : value
}

export function resolveAuthPaths(options: AuthPathOptions = {}): AuthPaths {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const homeDir = options.homeDir ?? homedir()
  const path = platform === 'win32' ? win32 : posix

  let configRoot: string
  if (platform === 'darwin') {
    configRoot = path.join(homeDir, 'Library', 'Application Support')
  } else if (platform === 'win32') {
    configRoot = present(env.APPDATA) ?? path.join(homeDir, 'AppData', 'Roaming')
  } else {
    configRoot = present(env.XDG_CONFIG_HOME) ?? path.join(homeDir, '.config')
  }

  const authRoot = path.join(configRoot, 'overleaf-web-mcp')
  return {
    cookieJarFile: path.join(authRoot, 'cookies.txt'),
    browserProfileDir: path.join(authRoot, 'chrome-profile'),
  }
}
