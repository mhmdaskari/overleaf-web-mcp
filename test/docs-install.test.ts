import { readFileSync } from 'node:fs'

import { describe, expect, test } from 'vitest'

import { fencedBlocks } from './helpers/markdown.js'

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

/** The one way to start the server, as the MCP Registry entry describes it. */
function canonicalServer(): { command: string; args: string[] } {
  const server = JSON.parse(read('server.json')) as {
    packages: Array<{ identifier: string; runtimeHint: string; packageArguments: Array<{ value: string }> }>
  }
  const [npm] = server.packages
  return { command: npm!.runtimeHint, args: ['-y', npm!.identifier, ...npm!.packageArguments.map(arg => arg.value)] }
}

/** The "Add to Cursor" link for a server definition, in the format Cursor documents. */
function cursorLink(server: object): string {
  const config = Buffer.from(JSON.stringify(server)).toString('base64')
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=overleaf&config=${encodeURIComponent(config)}`
}

const PAGES = ['README.md', 'docs/install.md', 'docs/configuration.md']

/** Each client configuration block that starts this server, with the page it is on. */
function clientBlocks() {
  return PAGES.flatMap(page =>
    fencedBlocks(read(page))
      .filter(block => block.text.includes('overleaf-web-mcp') && /"command"|^command =/mu.test(block.text))
      .map(block => ({ page, ...block }))
  )
}

describe('install instructions', () => {
  const canonical = canonicalServer()

  test('the canonical definition is npx -y overleaf-web-mcp serve', () => {
    expect(canonical).toEqual({ command: 'npx', args: ['-y', 'overleaf-web-mcp', 'serve'] })
  })

  test('finds the client blocks inside tabs and lists too', () => {
    const install = clientBlocks().filter(block => block.page === 'docs/install.md')
    // Claude Desktop, Cursor, VS Code, Antigravity, Codex (TOML), and self-hosted Overleaf.
    expect(install.length).toBeGreaterThanOrEqual(6)
  })

  test('every JSON client block starts the server the one canonical way', () => {
    for (const block of clientBlocks().filter(entry => entry.lang === 'json')) {
      const where = `${block.page}:${block.line}`
      const parsed = JSON.parse(block.text) as Record<string, Record<string, Record<string, unknown>>>
      const servers = parsed.mcpServers ?? parsed.servers
      expect(servers, where).toBeDefined()
      const { command, args, env, type, ...rest } = servers!.overleaf!
      expect({ command, args }, where).toEqual(canonical)
      expect(rest, where).toEqual({})
      // VS Code's servers key needs the transport; mcpServers clients infer it.
      if (parsed.servers !== undefined) expect(type, where).toBe('stdio')
      else expect(type, where).toBeUndefined()
      if (env !== undefined) {
        for (const name of Object.keys(env as Record<string, string>))
          expect(name, where).toMatch(/^(OVERLEAF_[A-Z_]+|HTTPS?_PROXY|NO_PROXY)$/u)
      }
    }
  })

  test('every TOML client block starts the server the one canonical way', () => {
    const toml = clientBlocks().filter(block => block.lang === 'toml')
    expect(toml.length).toBeGreaterThan(0)
    for (const block of toml) {
      const command = /^command = "([^"]*)"$/mu.exec(block.text)?.[1]
      const args = /^args = (\[.*\])$/mu.exec(block.text)?.[1]
      expect({ command, args: JSON.parse(args!) as string[] }, `${block.page}:${block.line}`).toEqual(canonical)
    }
  })

  test('every claude and codex registration command ends the same way', () => {
    const tail = `-- ${canonical.command} ${canonical.args.join(' ')}`
    const commands = PAGES.flatMap(page =>
      fencedBlocks(read(page))
        .flatMap(block => block.text.split('\n'))
        .filter(line => /^(claude|codex) mcp add /u.test(line))
        .map(line => ({ page, line }))
    )
    expect(commands.length).toBeGreaterThanOrEqual(4)
    // The one exception registers an absolute node binary, for nvm users; its line continues.
    for (const { page, line } of commands.filter(entry => !entry.line.endsWith('\\'))) {
      expect(line, page).toMatch(new RegExp(`${tail.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}$`, 'u'))
    }
  })

  test('the Add to Cursor link installs exactly the canonical definition', () => {
    const page = read('docs/install.md')
    const links = [...page.matchAll(/cursor:\/\/anysphere\.cursor-deeplink\/mcp\/install\?[^)\s"']+/gu)].map(
      match => match[0]
    )
    expect(links.length).toBeGreaterThan(0)
    for (const link of links) {
      expect(link).toBe(cursorLink(canonical))
      const config = new URL(link).searchParams.get('config')!
      expect(JSON.parse(Buffer.from(config, 'base64').toString('utf8'))).toEqual(canonical)
    }
  })
})
