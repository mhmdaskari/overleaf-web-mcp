import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, test } from 'vitest'

import { PLUGINS } from '../scripts/bump-version.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

function json<T>(path: string): T {
  return JSON.parse(readFileSync(join(ROOT, path), 'utf8')) as T
}

/** Every file under `folder`, relative to it with `/` separators, symbolic links included. */
function filesUnder(folder: string): string[] {
  const found: string[] = []
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) walk(path)
      else found.push(relative(folder, path).split('\\').join('/'))
    }
  }
  walk(folder)
  return found.sort()
}

const packageJson = json<{ name: string; version: string; license: string }>('package.json')
const serverJson = json<{
  packages: Array<{ identifier: string; runtimeHint: string; packageArguments: Array<{ value: string }> }>
}>('server.json')

interface PluginManifest {
  name: string
  version: string
  description: string
  license: string
  author: { name: string }
}

interface McpConfig {
  mcpServers: Record<string, { command: string; args: string[] }>
}

describe.each(PLUGINS.map(plugin => [plugin.folder, plugin] as const))('%s', (_folder, plugin) => {
  const folder = join(ROOT, plugin.folder)
  const files = filesUnder(folder)

  test('names the package and carries its version and license', () => {
    const manifest = json<PluginManifest>(plugin.manifest)
    expect(manifest.name).toBe(packageJson.name)
    expect(manifest.version).toBe(packageJson.version)
    expect(manifest.license).toBe(packageJson.license)
    expect(manifest.description.length).toBeGreaterThan(0)
    expect(manifest.author.name.length).toBeGreaterThan(0)
  })

  test('starts the server as server.json does, pinned to the exact package version', () => {
    const [entry] = serverJson.packages
    const config = json<McpConfig>(plugin.mcpConfig)
    expect(config).toEqual({
      mcpServers: {
        overleaf: {
          command: entry!.runtimeHint,
          args: ['-y', `${entry!.identifier}@${packageJson.version}`, ...entry!.packageArguments.map(arg => arg.value)],
        },
      },
    })
  })

  test('carries the skills byte for byte, and nothing else under skills/', () => {
    const skills = filesUnder(join(ROOT, 'skills'))
    expect(skills.length).toBeGreaterThan(0)
    expect(files.filter(path => path.startsWith('skills/'))).toEqual(skills.map(path => `skills/${path}`))
    for (const path of skills)
      expect(readFileSync(join(folder, 'skills', path), 'utf8'), path).toBe(
        readFileSync(join(ROOT, 'skills', path), 'utf8')
      )
  })

  test('has a README of at least 40 words outside code blocks', () => {
    const readme = readFileSync(join(folder, 'README.md'), 'utf8').replace(/```[\s\S]*?```/gu, '')
    expect(readme.split(/\s+/u).filter(Boolean).length).toBeGreaterThanOrEqual(40)
    expect(readme).toMatch(/unofficial/iu)
  })

  test('holds only small, regular files and nothing that installs packages', () => {
    expect(files.length).toBeLessThanOrEqual(512)
    for (const path of files) {
      const stat = lstatSync(join(folder, path))
      expect(stat.isFile(), `${path} is a regular file`).toBe(true)
      expect(stat.size, `${path} is under 256 KiB`).toBeLessThan(256 * 1024)
      expect(path, path).toMatch(/\.(json|md|svg)$/u)
    }
    const names = files.map(path => path.split('/').pop())
    for (const forbidden of [
      'package.json',
      'package-lock.json',
      'npm-shrinkwrap.json',
      'bun.lock',
      'bun.lockb',
      '.npmrc',
      '.DS_Store',
      'Thumbs.db',
      'desktop.ini',
    ])
      expect(names, forbidden).not.toContain(forbidden)
  })
})

describe.each([
  ['.claude-plugin/marketplace.json', 'plugins/claude', './plugins/claude'],
  ['.cursor-plugin/marketplace.json', 'plugins/cursor', 'plugins/cursor'],
])('%s', (path, folder, source) => {
  test('lists the one plugin by its name and folder', () => {
    const marketplace = json<{ plugins: Array<{ name: string; source: string }> }>(path)
    const plugin = PLUGINS.find(entry => entry.folder === folder)!
    expect(marketplace.plugins).toEqual([
      expect.objectContaining({ name: json<PluginManifest>(plugin.manifest).name, source }),
    ])
  })
})
