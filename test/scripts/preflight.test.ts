import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, test } from 'vitest'

import {
  evaluatePreflight,
  gatherPreflight,
  INSTRUCTION_WORD_LIMIT,
  instructionWords,
  renderChecks,
  type InstalledPackage,
  type PreflightEnvironment,
} from '../../scripts/preflight.js'
import { SERVER_INSTRUCTIONS } from '../../src/mcp/instructions.js'

const repository = fileURLToPath(new URL('../../', import.meta.url))
const version = (JSON.parse(await readFile(join(repository, 'package.json'), 'utf8')) as { version: string }).version

const HEALTHY: InstalledPackage[] = [
  { name: '@modelcontextprotocol/server', version: '2.3.1', location: 'node_modules/@modelcontextprotocol/server' },
  { name: '@modelcontextprotocol/client', version: '2.3.1', location: 'node_modules/@modelcontextprotocol/client' },
  { name: '@modelcontextprotocol/core', version: '2.3.1', location: 'node_modules/@modelcontextprotocol/core' },
  { name: 'zod', version: '4.6.7', location: 'node_modules/zod' },
]

const folders: string[] = []

async function copyOfRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'overleaf-preflight-'))
  folders.push(root)
  await mkdir(join(root, 'src'))
  for (const path of ['package.json', 'server.json', 'src/version.ts'])
    await cp(join(repository, path), join(root, path))
  return root
}

/** Answers the commands preflight runs, as a released checkout would. */
function environment(
  overrides: { npm?: string | Error; tags?: string; installed?: InstalledPackage[]; instructions?: string } = {}
): PreflightEnvironment {
  return {
    run: (command, args) => {
      if (command === 'npm' && args[0] === 'view') {
        if (overrides.npm instanceof Error) throw overrides.npm
        return `${overrides.npm ?? version}\n`
      }
      if (command === 'npm' && args[0] === 'query') return JSON.stringify(overrides.installed ?? HEALTHY)
      if (command === 'git') return overrides.tags ?? `v${version}\nv0.9.0\nnot-a-release\n`
      throw new Error(`unexpected command ${command} ${args.join(' ')}`)
    },
    instructions: async () => overrides.instructions ?? 'A short text.',
  }
}

async function failing(root: string, overrides?: Parameters<typeof environment>[0]): Promise<string[]> {
  const checks = evaluatePreflight(await gatherPreflight(root, environment(overrides)))
  return checks.filter(check => !check.ok).map(check => check.name)
}

afterEach(async () => {
  await Promise.all(folders.splice(0).map(async folder => await rm(folder, { recursive: true, force: true })))
})

describe('preflight', () => {
  test('passes every check on a released checkout and prints one line per check', async () => {
    const root = await copyOfRepository()
    const checks = evaluatePreflight(await gatherPreflight(root, environment()))
    expect(checks.filter(check => !check.ok)).toEqual([])
    const output = renderChecks(checks)
    expect(output.trimEnd().split('\n')).toHaveLength(checks.length)
    expect(output).toContain(`ok   versions agree: ${version} everywhere`)
  })

  test('fails when server.json names a different version, naming each source', async () => {
    const root = await copyOfRepository()
    const path = join(root, 'server.json')
    const server = JSON.parse(await readFile(path, 'utf8'))
    server.version = '0.0.1'
    await writeFile(path, JSON.stringify(server, null, 2))
    expect(await failing(root)).toEqual(['versions agree'])
    const [agree] = evaluatePreflight(await gatherPreflight(root, environment()))
    expect(agree!.detail).toContain('server.json 0.0.1')
  })

  test('fails when npm, the latest tag, or SERVER_VERSION disagree, or npm cannot be reached', async () => {
    const root = await copyOfRepository()
    expect(await failing(root, { npm: '0.0.1' })).toEqual(['versions agree'])
    expect(await failing(root, { npm: new Error('offline') })).toEqual(['versions agree'])
    expect(await failing(root, { tags: 'v0.9.0\n' })).toEqual(['versions agree'])
    const path = join(root, 'src/version.ts')
    await writeFile(
      path,
      (await readFile(path, 'utf8')).replace(/SERVER_VERSION = '[^']*'/u, "SERVER_VERSION = '0.0.1'")
    )
    expect(await failing(root)).toEqual(['versions agree'])
  })

  test('fails on the dependency rules AGENTS.md sets', async () => {
    const root = await copyOfRepository()
    const sdk = {
      name: '@modelcontextprotocol/sdk',
      version: '1.20.0',
      location: 'node_modules/@modelcontextprotocol/sdk',
    }
    expect(await failing(root, { installed: [...HEALTHY, sdk] })).toEqual(['no @modelcontextprotocol/sdk'])

    const nestedZod = { name: 'zod', version: '3.25.0', location: 'node_modules/other/node_modules/zod' }
    expect(await failing(root, { installed: [...HEALTHY, nestedZod] })).toEqual(['one copy of zod'])
    // npm query can list a copy once per path to it; one location is one copy.
    expect(await failing(root, { installed: [...HEALTHY, HEALTHY[3]!] })).toEqual([])

    const oldServer = HEALTHY.map(entry =>
      entry.name === '@modelcontextprotocol/server' ? { ...entry, version: '3.0.0' } : entry
    )
    expect(await failing(root, { installed: oldServer })).toEqual(['@modelcontextprotocol/server is 2.x'])
    const noCore = HEALTHY.filter(entry => entry.name !== '@modelcontextprotocol/core')
    expect(await failing(root, { installed: noCore })).toEqual(['one copy of @modelcontextprotocol/core'])
  })

  test('counts instruction words as the server test does, and fails at the bound', async () => {
    const root = await copyOfRepository()
    expect(instructionWords('one two\nthree')).toBe(3)
    expect(instructionWords(SERVER_INSTRUCTIONS)).toBeLessThan(INSTRUCTION_WORD_LIMIT)
    const long = Array.from({ length: INSTRUCTION_WORD_LIMIT }, () => 'word').join(' ')
    expect(await failing(root, { instructions: long })).toEqual(['SERVER_INSTRUCTIONS under the word bound'])
  })
})
