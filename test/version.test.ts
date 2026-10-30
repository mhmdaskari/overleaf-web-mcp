import { readFileSync } from 'node:fs'

import { describe, expect, test } from 'vitest'

import { SERVER_NAME, SERVER_VERSION, USER_AGENT } from '../src/version.js'

describe('package identity', () => {
  test('keeps MCP and transport identity aligned with package metadata', () => {
    const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      name: string
      version: string
    }

    expect(SERVER_NAME).toBe(packageJson.name)
    expect(SERVER_VERSION).toBe(packageJson.version)
    expect(USER_AGENT).toBe(`${packageJson.name}/${packageJson.version}`)
  })

  test('keeps the MCP Registry entry aligned with package metadata', () => {
    const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      name: string
      version: string
      mcpName: string
    }
    const serverJson = JSON.parse(readFileSync(new URL('../server.json', import.meta.url), 'utf8')) as {
      name: string
      description: string
      version: string
      packages: { registryType: string; identifier: string; version: string }[]
    }

    // The registry rejects a publish whose name differs from the npm package's mcpName.
    expect(serverJson.name).toBe(packageJson.mcpName)
    expect(serverJson.name.startsWith('io.github.mhmdaskari/')).toBe(true)
    expect(serverJson.description.length).toBeLessThanOrEqual(100)
    expect(serverJson.version).toBe(packageJson.version)
    expect(serverJson.packages).toEqual([
      expect.objectContaining({
        registryType: 'npm',
        identifier: packageJson.name,
        version: packageJson.version,
      }),
    ])
  })
})
