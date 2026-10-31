import { constants } from 'node:fs'
import { access, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

import { McpError } from '../core/errors.js'

export interface ChromeDiscoveryOptions {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  homeDir?: string
}

function chromeCandidates(options: ChromeDiscoveryOptions): string[] {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const homeDir = options.homeDir ?? homedir()
  const names =
    platform === 'win32'
      ? ['chrome.exe', 'msedge.exe', 'brave.exe', 'chromium.exe']
      : ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'brave-browser', 'microsoft-edge']
  const fromPath = (env.PATH ?? '')
    .split(delimiter)
    .filter(Boolean)
    .flatMap(directory => names.map(name => join(directory, name)))

  if (platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      join(homeDir, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
      ...fromPath,
    ]
  }
  if (platform === 'win32') {
    return [
      ...(env.PROGRAMFILES ? [join(env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe')] : []),
      ...(env['PROGRAMFILES(X86)']
        ? [join(env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe')]
        : []),
      ...(env.LOCALAPPDATA
        ? [
            join(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
            join(env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
          ]
        : []),
      ...fromPath,
    ]
  }
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/brave-browser',
    '/usr/bin/microsoft-edge',
    ...fromPath,
  ]
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export async function findChromeExecutable(
  explicitPath?: string,
  options: ChromeDiscoveryOptions = {}
): Promise<string> {
  if (explicitPath) {
    if (await isExecutable(explicitPath)) return explicitPath
    throw new McpError(
      'NOT_FOUND',
      `Chrome executable was not found at ${explicitPath}. Correct OVERLEAF_BROWSER_PATH or install Chrome, Chromium, Brave, or Edge.`
    )
  }

  for (const candidate of [...new Set(chromeCandidates(options))]) {
    if (await isExecutable(candidate)) return candidate
  }
  throw new McpError(
    'NOT_FOUND',
    'No supported Chrome-family browser was found. Install Chrome, Chromium, Brave, or Edge, or set OVERLEAF_BROWSER_PATH.'
  )
}

export function chromeLaunchArguments(profileDir: string): string[] {
  return [
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--new-window',
    'about:blank',
  ]
}

/** Reads the ephemeral CDP endpoint written by Chrome when port zero is requested. */
export async function readDevToolsEndpoint(
  profileDir: string,
  timeoutMs = 10_000,
  sleep: (ms: number) => Promise<void> = async ms => await new Promise(resolve => setTimeout(resolve, ms))
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  const endpointFile = join(profileDir, 'DevToolsActivePort')
  while (Date.now() < deadline) {
    try {
      const [portText, websocketPath] = (await readFile(endpointFile, 'utf8')).trim().split(/\r?\n/u)
      const port = Number(portText)
      if (Number.isSafeInteger(port) && port > 0 && websocketPath?.startsWith('/')) {
        return `ws://127.0.0.1:${port}${websocketPath}`
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await sleep(50)
  }
  throw new McpError(
    'TIMEOUT',
    `Chrome did not expose its login connection within ${timeoutMs}ms. Verify the browser installation and profile directory permissions.`
  )
}
