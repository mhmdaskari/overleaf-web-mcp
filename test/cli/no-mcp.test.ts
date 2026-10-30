import { rm } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, test, vi } from 'vitest'

// Operation commands and the SDK client must work where the MCP SDK and the MCP adapter cannot
// even be loaded: only `serve` may load them.
vi.mock('@modelcontextprotocol/server', () => {
  throw new Error('the MCP SDK was loaded')
})
vi.mock('@modelcontextprotocol/server/stdio', () => {
  throw new Error('the MCP SDK was loaded')
})
vi.mock('../../src/mcp/tools.js', () => {
  throw new Error('the MCP adapter was loaded')
})
vi.mock('../../src/server.js', () => {
  throw new Error('the MCP server was loaded')
})

/** Streams that record what an operation command prints. stdin is never read here. */
function captureIo() {
  const stdout: string[] = []
  const stderr: string[] = []
  return {
    io: {
      stdout: (text: string) => {
        stdout.push(text)
      },
      stderr: (text: string) => {
        stderr.push(text)
      },
      readStdin: async (): Promise<Uint8Array> => {
        throw new Error('stdin is not read by these commands')
      },
    },
    stdout: () => stdout.join(''),
    stderr: () => stderr.join(''),
  }
}

/** readConfig reads this instead of process.env; with the runtime injected, nothing reads the paths. */
const ENV: NodeJS.ProcessEnv = {
  OVERLEAF_BASE_URL: 'https://overleaf.test',
  OVERLEAF_COOKIE_JAR_FILE: '/nonexistent/overleaf-no-mcp/cookies.txt',
  OVERLEAF_BROWSER_PROFILE_DIR: '/nonexistent/overleaf-no-mcp/profile',
}

describe('operation commands never load MCP', () => {
  test('schema, capabilities, call, and an alias run through the command line', async () => {
    const { runCommandLine } = await import('../../src/cli/run.js')
    const { OPERATION_NAMES } = await import('../../src/contracts/operations.js')
    const { fakeServiceRuntime } = await import('../helpers/fake-runtime.js')
    const { OUTPUTS } = await import('../helpers/operation-outputs.js')

    const unused = vi.fn(async () => {
      throw new Error('this command opens no session')
    })
    const schema = captureIo()
    expect(
      await runCommandLine(['schema', 'read_file', '--input'], schema.io, { env: ENV, createRuntime: unused })
    ).toBe(0)
    expect(schema.stderr()).toBe('')
    expect(JSON.parse(schema.stdout())).toMatchObject({
      type: 'object',
      properties: { projectId: expect.any(Object), filePath: expect.any(Object) },
    })

    const capabilities = captureIo()
    expect(await runCommandLine(['capabilities'], capabilities.io, { env: ENV, createRuntime: unused })).toBe(0)
    expect(capabilities.stderr()).toBe('')
    const report = JSON.parse(capabilities.stdout()) as {
      operations: Array<{ name: string }>
      project: Record<string, unknown>
    }
    expect(report.operations.map(operation => operation.name)).toEqual(OPERATION_NAMES)
    expect(Object.values(report.project).every(value => value === 'unknown')).toBe(true)
    expect(unused).not.toHaveBeenCalled()

    const runtime = fakeServiceRuntime()
    const call = captureIo()
    const exitCode = await runCommandLine(
      ['call', 'read_file', '--json', JSON.stringify({ projectId: 'p', filePath: 'main.tex' })],
      call.io,
      { env: ENV, createRuntime: async () => runtime }
    )
    expect(call.stderr()).toBe('')
    expect(exitCode).toBe(0)
    expect(JSON.parse(call.stdout())).toEqual(OUTPUTS.read_file)
    expect(runtime.documents.readFile).toHaveBeenCalledWith('p', 'main.tex')
    expect(runtime.close).toHaveBeenCalledTimes(1)

    const tree = captureIo()
    expect(await runCommandLine(['tree', 'p'], tree.io, { env: ENV, createRuntime: async () => runtime })).toBe(0)
    expect(tree.stderr()).toBe('')
    expect(JSON.parse(tree.stdout())).toEqual(OUTPUTS.get_project_tree)
    expect(runtime.entities.getProjectTree).toHaveBeenCalledWith('p')
  })

  test('the SDK client opens a session and lists projects', async () => {
    const { createOverleafClient } = await import('../../src/client.js')
    const { readConfig } = await import('../../src/config.js')
    const { BOOTSTRAP_PAGE, cookieJar } = await import('../helpers/runtime.js')

    const { cookiePath, directory } = await cookieJar()
    const requests: string[] = []
    try {
      const client = await createOverleafClient({
        config: readConfig({
          OVERLEAF_BASE_URL: 'https://overleaf.test',
          OVERLEAF_COOKIE_JAR_FILE: cookiePath,
          OVERLEAF_BROWSER_PROFILE_DIR: join(directory, 'profile'),
        }),
        dependencies: {
          fetcher: async (input, init) => {
            const url = new URL(input instanceof Request ? input.url : String(input))
            const method = init?.method ?? 'GET'
            requests.push(`${method} ${url.pathname}`)
            if (method === 'GET' && url.pathname === '/project') return new Response(BOOTSTRAP_PAGE)
            if (method === 'POST' && url.pathname === '/api/project') {
              return new Response(JSON.stringify({ projects: [{ _id: 'p', name: 'Paper', accessLevel: 'owner' }] }), {
                headers: { 'content-type': 'application/json' },
              })
            }
            throw new Error(`unexpected ${method} ${url.pathname}`)
          },
          connectionFactory: async () => {
            throw new Error('listing projects opens no socket')
          },
        },
      })
      try {
        expect(await client.listProjects({})).toEqual({
          projects: [{ id: 'p', name: 'Paper', accessLevel: 'owner', archived: false, trashed: false }],
          totalMatched: 1,
          totalProjects: 1,
        })
      } finally {
        await client.close()
      }
      expect(requests).toEqual(['GET /project', 'POST /api/project'])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('the mocks above are in force: loading MCP here fails', async () => {
    // Without this, a test above could pass because nothing was mocked at all. Vitest wraps the
    // factory's error, so its own message is the cause.
    const failure = async (load: Promise<unknown>): Promise<string> => {
      try {
        await load
      } catch (error) {
        return String((error as Error).cause ?? error)
      }
      return 'loaded'
    }
    expect(await failure(import('../../src/server.js'))).toMatch(/the MCP server was loaded/u)
    expect(await failure(import('../../src/mcp/tools.js'))).toMatch(/the MCP adapter was loaded/u)
    expect(await failure(import('@modelcontextprotocol/server'))).toMatch(/the MCP SDK was loaded/u)
    expect(await failure(import('@modelcontextprotocol/server/stdio'))).toMatch(/the MCP SDK was loaded/u)
  })
})
