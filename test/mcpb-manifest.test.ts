import { readFileSync } from 'node:fs'

import { describe, expect, test } from 'vitest'

import { extensionEnvironment } from '../scripts/build-mcpb.js'
import { readConfig } from '../src/config.js'

interface UserConfigEntry {
  type: string
  title: string
  description: string
  required?: boolean
  default?: string | number | boolean
}

interface Manifest {
  manifest_version: string
  name: string
  version: string
  description: string
  license: string
  server: {
    type: string
    entry_point: string
    mcp_config: { command: string; args: string[]; env: Record<string, string> }
  }
  user_config: Record<string, UserConfigEntry>
  compatibility: { platforms: string[]; runtimes: { node: string } }
  tools_generated: boolean
  prompts_generated: boolean
}

const json = <T>(path: string): T => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as T
const manifest = json<Manifest>('../manifest.json')
const packageJson = json<{ name: string; license: string; engines: { node: string } }>('../package.json')

const substitute = (values: Record<string, string>): Record<string, string> => extensionEnvironment(manifest, values)

describe('Claude Desktop extension manifest', () => {
  test('carries the package name, license, and Node.js range', () => {
    expect(manifest.name).toBe(packageJson.name)
    expect(manifest.license).toBe(packageJson.license)
    expect(manifest.compatibility.runtimes.node).toBe(packageJson.engines.node)
  })

  test('runs serve from the bundled dist/cli.js with the host’s Node.js', () => {
    expect(manifest.manifest_version).toBe('0.4')
    expect(manifest.server.type).toBe('node')
    expect(manifest.server.entry_point).toBe('dist/cli.js')
    expect(manifest.server.mcp_config.command).toBe('node')
    expect(manifest.server.mcp_config.args).toEqual(['${__dirname}/dist/cli.js', 'serve'])
  })

  test('lists no tools or prompts by hand: the host asks the server', () => {
    expect(manifest.tools_generated).toBe(true)
    expect(manifest.prompts_generated).toBe(true)
    expect(manifest).not.toHaveProperty('tools')
    expect(manifest).not.toHaveProperty('prompts')
  })

  test('every setting the server receives is optional and has a default', () => {
    const used = Object.values(manifest.server.mcp_config.env).flatMap(value =>
      [...value.matchAll(/\$\{user_config\.([^}]+)\}/gu)].map(match => match[1]!)
    )
    expect(used.sort()).toEqual(Object.keys(manifest.user_config).sort())
    for (const key of used) {
      expect(manifest.user_config[key]!.required ?? false, key).toBe(false)
      expect(manifest.user_config[key]!.default, key).toBeTypeOf('string')
    }
    for (const name of Object.keys(manifest.server.mcp_config.env)) expect(name).toMatch(/^OVERLEAF_[A-Z_]+$/u)
  })

  test('with every setting left at its default, the server reads overleaf.com and no project limit', () => {
    const config = readConfig(substitute({}))
    expect(config.baseUrl).toBe('https://www.overleaf.com')
    expect(config.allowedProjects).toBeUndefined()
    expect(config.browserPath).toBeUndefined()
  })

  test('the settings reach the configuration the server reads', () => {
    const config = readConfig(
      substitute({
        base_url: 'https://latex.example.edu',
        allowed_projects: 'aaaaaaaaaaaaaaaaaaaaaaaa, bbbbbbbbbbbbbbbbbbbbbbbb',
        browser_path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      })
    )
    expect(config.browserPath).toBe('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')
    expect(config.baseUrl).toBe('https://latex.example.edu')
    expect(config.allowedProjects).toEqual(['aaaaaaaaaaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbbbbbbbbbb'])
  })

  test('targets the systems Claude Desktop runs on', () => {
    expect([...manifest.compatibility.platforms].sort()).toEqual(['darwin', 'linux', 'win32'])
  })
})
