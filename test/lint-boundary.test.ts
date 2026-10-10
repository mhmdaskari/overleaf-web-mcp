import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'

import { ESLint } from 'eslint'
import { describe, expect, test } from 'vitest'

const root = new URL('..', import.meta.url).pathname

async function sourceFiles(folder: string): Promise<string[]> {
  const entries = await readdir(folder, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map(async entry => {
      const path = join(folder, entry.name)
      if (entry.isDirectory()) return await sourceFiles(path)
      return entry.name.endsWith('.ts') ? [path] : []
    })
  )
  return nested.flat()
}

const ADAPTER_FILES = /^src\/(mcp\/|server\.ts$|cli\.ts$|index\.ts$)/u

describe('interface boundary', () => {
  test('only the MCP adapter and its entry points import the MCP SDK or the adapter', async () => {
    const offenders: string[] = []
    for (const file of await sourceFiles(join(root, 'src'))) {
      const path = relative(root, file)
      if (ADAPTER_FILES.test(path)) continue
      const text = await readFile(file, 'utf8')
      if (/from '(\.\.\/)*\.?\/?mcp\/|@modelcontextprotocol|from '(\.\.\/)*\.?\/?server\.js'/u.test(text)) {
        offenders.push(path)
      }
    }
    expect(offenders).toEqual([])
  })

  test('the lint configuration refuses an MCP import, console, or process streams outside the adapter', async () => {
    const eslint = new ESLint({ cwd: root })
    const lint = async (filePath: string, code: string): Promise<Array<string | null>> => {
      const [result] = await eslint.lintText(code, { filePath })
      return result!.messages.map(message => message.ruleId)
    }

    expect(await lint('src/runtime.ts', "import { TOOL_NAMES } from './mcp/tools.js'\nexport const names = TOOL_NAMES\n"))
      .toContain('@typescript-eslint/no-restricted-imports')
    expect(await lint('src/sdk.ts', "import type { McpServer } from '@modelcontextprotocol/server'\nexport type Server = McpServer\n"))
      .toContain('@typescript-eslint/no-restricted-imports')
    expect(await lint('src/overleaf/tree.ts', "export { createMcpServer } from '../server.js'\n"))
      .toContain('@typescript-eslint/no-restricted-imports')
    expect(await lint('src/runtime.ts', "console.error('x')\n")).toContain('no-console')
    expect(await lint('src/runtime.ts', "process.stderr.write('x')\n")).toContain('no-restricted-properties')
    expect(await lint('src/server.ts', "import { McpServer } from '@modelcontextprotocol/server'\nexport const Server = McpServer\n"))
      .toEqual([])
  }, 60_000)
})
