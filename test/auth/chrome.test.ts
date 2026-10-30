import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'vitest'

import { chromeLaunchArguments, findChromeExecutable, readDevToolsEndpoint } from '../../src/auth/chrome.js'

describe('Chrome discovery and launch configuration', () => {
  test('uses an explicit executable when it is runnable', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'overleaf-chrome-'))
    const executable = join(directory, 'chrome')
    await writeFile(executable, '#!/bin/sh\n')
    await chmod(executable, 0o700)

    await expect(findChromeExecutable(executable)).resolves.toBe(executable)
  })

  test('reports an actionable error for a missing explicit executable', async () => {
    await expect(findChromeExecutable('/missing/chrome')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: expect.stringMatching(/OVERLEAF_BROWSER_PATH/u),
    })
  })

  test('uses an isolated profile and an ephemeral debugging port', () => {
    expect(chromeLaunchArguments('/tmp/overleaf-profile')).toEqual(
      expect.arrayContaining([
        '--remote-debugging-port=0',
        '--user-data-dir=/tmp/overleaf-profile',
        '--no-first-run',
        '--no-default-browser-check',
        '--new-window',
        'about:blank',
      ])
    )
  })

  test('reads the browser websocket endpoint from DevToolsActivePort', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'overleaf-devtools-'))
    await writeFile(join(directory, 'DevToolsActivePort'), '43123\n/devtools/browser/browser-id\n')

    await expect(readDevToolsEndpoint(directory, 250)).resolves.toBe('ws://127.0.0.1:43123/devtools/browser/browser-id')
  })
})
