import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, expectTypeOf, test, vi } from 'vitest'

import { readConfig } from '../src/config.js'
import { TOOL_NAMES } from '../src/mcp/tools.js'
import { DocumentsApi } from '../src/overleaf/documents.js'
import {
  createOverleafClient,
  ERROR_CODES,
  McpError,
  OPERATION_NAMES,
  OPERATIONS,
  OverleafRuntime,
  type AppConfig,
  type OperationContext,
  type OperationDiagnostic,
  type OperationName,
  type OperationOutput,
  type OverleafClient,
} from '../src/sdk.js'
import { fakeOverleaf, fakeSession, history, PROJECT, sharejs, visible, type FakeOverleaf } from './helpers/fake-overleaf.js'
import { INPUTS } from './helpers/operation-inputs.js'

type AnyMethod = (input?: unknown, context?: OperationContext) => Promise<unknown>

/** `read_file` → `readFile`, worked out here rather than by the code under test. */
function camel(name: string): string {
  const [head = '', ...rest] = name.split('_')
  return head + rest.map(word => word.charAt(0).toUpperCase() + word.slice(1)).join('')
}

function method(client: OverleafClient, name: OperationName): AnyMethod {
  return (client as unknown as Record<string, AnyMethod>)[camel(name)]!
}

async function failure(promise: Promise<unknown>): Promise<McpError> {
  try {
    await promise
  } catch (error) {
    return error as McpError
  }
  throw new Error('expected the call to reject')
}

const opened: OverleafClient[] = []
/** Folders holding a test's cookie jar, removed once its clients are closed. */
const directories: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(opened.splice(0).map(async client => await client.close()))
  await Promise.all(directories.splice(0).map(async directory => await rm(directory, { recursive: true, force: true })))
})

/** A folder for a test's own cookie jar, removed after the test. */
async function temporaryFolder(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'overleaf-client-'))
  directories.push(directory)
  return directory
}

/** A client over the fake Overleaf, closed after the test. */
async function openClient(server: FakeOverleaf, adjust: (config: AppConfig) => AppConfig = config => config) {
  const { config, dependencies, directory } = await fakeSession(server)
  directories.push(directory)
  const client = await createOverleafClient({ config: adjust(config), dependencies })
  opened.push(client)
  return client
}

describe('createOverleafClient', () => {
  test('has one camelCase method per tool, plus close, and nothing else', async () => {
    const server = fakeOverleaf({ d1: sharejs('Placeholder.', 1) })
    const client = await openClient(server)

    expect(TOOL_NAMES).toEqual(OPERATION_NAMES)
    const expected = [...TOOL_NAMES.map(camel), 'close'].sort()
    expect(Object.keys(client).sort()).toEqual(expected)
    expect(expected).toEqual(
      expect.arrayContaining(['authStatus', 'readFile', 'writeFile', 'syncDirectory', 'getSectionContent'])
    )
    for (const key of expected) expect(typeof (client as unknown as Record<string, unknown>)[key], key).toBe('function')
    // Opening the client bootstraps the session and nothing else.
    expect(server.bootstraps).toBe(1)
    expect(server.requests).toEqual([])
    expect(server.peers).toEqual([])
  })

  test('each method runs the operation of the same name', async () => {
    const server = fakeOverleaf({ d1: sharejs('Placeholder.', 1) })
    // Every operation needs a project or an effect this policy refuses, so each fails at its first check.
    const client = await openClient(server, config => ({
      ...config,
      allowedProjects: ['elsewhere'],
      allowedEffects: ['compile'],
    }))
    for (const name of OPERATION_NAMES) {
      const diagnostics: OperationDiagnostic[] = []
      const error = await failure(
        method(client, name)(structuredClone(INPUTS[name]), { onDiagnostic: diagnostic => diagnostics.push(diagnostic) })
      )
      expect(error, name).toBeInstanceOf(McpError)
      expect(error.code, name).toBe('POLICY_DENIED')
      expect(diagnostics).toEqual([{ tool: name, code: 'POLICY_DENIED' }])
    }
    expect(server.requests).toEqual([])
    expect(server.peers).toEqual([])
  })

  test('reads a file, writes it with the returned revision, and refuses the stale revision', async () => {
    const server = fakeOverleaf({ d1: sharejs('Old placeholder.', 3) })
    const client = await openClient(server)

    const read = await client.readFile({ projectId: PROJECT, filePath: 'main.tex' })
    expect(read).toMatchObject({ content: 'Old placeholder.', protocol: 'sharejs', newline: 'LF' })
    expect(OPERATIONS.read_file.outputSchema.strict().safeParse(read).success).toBe(true)

    const written = await client.writeFile({
      projectId: PROJECT,
      filePath: 'main.tex',
      revision: read.revision,
      content: 'New placeholder.',
    })
    expect(written).toMatchObject({ protocol: 'sharejs', writeMode: 'untracked' })
    expect(written.revision).not.toBe(read.revision)
    expect(server.applied).toBe(1)
    expect(visible(server, 'd1')).toBe('New placeholder.')
    // The revision a write returns is the live one: a fresh read sees it.
    expect((await client.readFile({ projectId: PROJECT, filePath: 'main.tex' })).revision).toBe(written.revision)

    const stale = await failure(
      client.writeFile({ projectId: PROJECT, filePath: 'main.tex', revision: read.revision, content: 'Other text.' })
    )
    expect(stale).toBeInstanceOf(McpError)
    expect(stale).toMatchObject({ code: 'REVISION_CONFLICT', details: { liveRevision: written.revision } })
    expect(server.applied).toBe(1)
    expect(visible(server, 'd1')).toBe('New placeholder.')

    await client.close()
    expect(server.peers.length).toBeGreaterThan(0)
    expect(server.peers.every(peer => peer.closed)).toBe(true)
  })

  test('authStatus takes no argument', async () => {
    const server = fakeOverleaf({ d1: sharejs('Placeholder.', 1) })
    const client = await openClient(server)
    const status = await client.authStatus()
    expect(status).toMatchObject({
      authenticated: true,
      baseUrl: 'https://overleaf.test',
      userId: 'user',
      projectCount: 1,
    })
    expect(server.requests).toEqual(['POST /api/project'])
  })

  test('listProjects takes no argument, null is refused as input, and the client cannot be changed', async () => {
    const server = fakeOverleaf({ d1: sharejs('Placeholder.', 1) })
    const client = await openClient(server)
    expect(await client.listProjects()).toMatchObject({ totalProjects: 1 })
    const refused = await failure(client.authStatus(null as never))
    expect(refused).toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(Object.isFrozen(client)).toBe(true)
    expect(server.requests).toEqual(['POST /api/project'])
  })

  test('an unknown key, at any depth, is INVALID_ARGUMENT naming it, and nothing is sent', async () => {
    const server = fakeOverleaf({ d1: sharejs('Placeholder.', 1) })
    const client = await openClient(server)
    const writeDocument = vi.spyOn(DocumentsApi.prototype, 'writeFile')

    // A plain JavaScript caller, or a variable typed wider than the literal, gets past the compiler.
    const misspelled = { projectId: PROJECT, filePath: 'main.tex', revision: 'r', content: 'x', writemode: 'tracked' }
    const error = await failure(client.writeFile(misspelled))
    expect(error).toBeInstanceOf(McpError)
    expect(error).toMatchObject({ code: 'INVALID_ARGUMENT', details: { unknownKeys: ['writemode'] } })

    const files = [{ localPath: '/tmp/a.png', destinationPath: 'a.png', overwrit: true }]
    const nested = await failure(client.batchUpload({ projectId: PROJECT, files }))
    expect(nested).toMatchObject({ code: 'INVALID_ARGUMENT', details: { unknownKeys: ['files.0.overwrit'] } })

    const missing = await failure(client.writeFile({ projectId: PROJECT, filePath: 'main.tex', content: 'x' } as never))
    expect(missing).toMatchObject({ code: 'INVALID_ARGUMENT', details: { issues: [{ path: 'revision' }] } })

    expect(writeDocument).not.toHaveBeenCalled()
    expect(server.requests).toEqual([])
    expect(server.peers).toEqual([])
  })

  test('applies contract defaults: writeFile without writeMode writes untracked', async () => {
    // A project in review mode, where only the client's own default keeps the write untracked.
    const server = fakeOverleaf({ d1: history('Draft sentence.', 5) }, { trackChangesState: true })
    const client = await openClient(server)
    const writeDocument = vi.spyOn(DocumentsApi.prototype, 'writeFile')

    const read = await client.readFile({ projectId: PROJECT, filePath: 'main.tex' })
    const written = await client.writeFile({
      projectId: PROJECT,
      filePath: 'main.tex',
      revision: read.revision,
      content: 'Final sentence.',
    })

    // The default arrives as a value, as the MCP server passes it, not as an absent field.
    expect(writeDocument).toHaveBeenCalledWith(PROJECT, 'main.tex', read.revision, 'Final sentence.', 'untracked')
    expect(written).toMatchObject({ writeMode: 'untracked', trackChangesActive: true })
    const document = server.documents.get('d1')!
    expect(document.content).toBe('Final sentence.')
    expect(document.marks.every(mark => mark === undefined)).toBe(true)
  })

  test('after close every method is refused with INVALID_ARGUMENT, and closing twice is harmless', async () => {
    const server = fakeOverleaf({ d1: sharejs('Placeholder.', 1) })
    const client = await openClient(server)
    const closeRuntime = vi.spyOn(OverleafRuntime.prototype, 'close')

    await client.close()
    await expect(client.close()).resolves.toBeUndefined()
    expect(closeRuntime).toHaveBeenCalledTimes(1)

    for (const name of OPERATION_NAMES) {
      const error = await failure(method(client, name)(structuredClone(INPUTS[name])))
      expect(error, name).toBeInstanceOf(McpError)
      expect(error.code, name).toBe('INVALID_ARGUMENT')
      expect(error.message, name).toMatch(/closed/u)
    }
    expect(server.requests).toEqual([])
    expect(server.peers).toEqual([])
  })

  test('close closes the project sockets the client opened', async () => {
    const server = fakeOverleaf({ d1: sharejs('Placeholder.', 1) })
    const client = await openClient(server)
    await client.readFile({ projectId: PROJECT, filePath: 'main.tex' })
    await client.readFile({ projectId: PROJECT, filePath: 'main.tex' })
    // One cached socket, still open between calls.
    expect(server.peers).toHaveLength(1)
    expect(server.peers[0]!.closed).toBe(false)

    await client.close()
    expect(server.peers[0]!.closed).toBe(true)
  })

  test('close lets calls still running finish, and leaves no socket open', async () => {
    const server = fakeOverleaf({ d1: sharejs('Old placeholder.', 3) })
    const client = await openClient(server)
    const read = await client.readFile({ projectId: PROJECT, filePath: 'main.tex' })

    const reading = client.readFile({ projectId: PROJECT, filePath: 'main.tex' })
    const writing = client.writeFile({
      projectId: PROJECT,
      filePath: 'main.tex',
      revision: read.revision,
      content: 'New placeholder.',
    })
    // Let both calls reach the socket before closing.
    await new Promise(resolve => setImmediate(resolve))
    await client.close()

    await expect(reading).resolves.toMatchObject({ content: 'Old placeholder.' })
    // Written cleanly: no socket was closed under it, so nothing had to be recovered.
    const written = await writing
    expect(written).not.toHaveProperty('recoveredAfterTimeout')
    expect(server.applied).toBe(1)
    expect(server.peers).toHaveLength(1)
    expect(server.peers.every(peer => peer.closed)).toBe(true)
  })

  test('a missing cookie jar is AUTH_EXPIRED, and no request is made', async () => {
    const directory = await temporaryFolder()
    const config = readConfig({
      OVERLEAF_COOKIE_JAR_FILE: join(directory, 'cookies.txt'),
      OVERLEAF_BASE_URL: 'https://overleaf.test',
      OVERLEAF_BROWSER_PROFILE_DIR: join(directory, 'profile'),
    })
    const fetcher = vi.fn(async () => new Response(null, { status: 500 }))
    const connectionFactory = vi.fn()

    const error = await failure(createOverleafClient({ config, dependencies: { fetcher, connectionFactory } }))
    expect(error).toBeInstanceOf(McpError)
    expect(error.code).toBe('AUTH_EXPIRED')
    expect(fetcher).not.toHaveBeenCalled()
    expect(connectionFactory).not.toHaveBeenCalled()
  })

  test('a cookie jar that cannot be read still rejects with McpError', async () => {
    const directory = await temporaryFolder()
    // An owner-only folder where the jar file should be: it passes the permission check, then cannot be read.
    const jar = join(directory, 'cookies.txt')
    await mkdir(jar, { mode: 0o700 })
    const config = readConfig({
      OVERLEAF_COOKIE_JAR_FILE: jar,
      OVERLEAF_BASE_URL: 'https://overleaf.test',
      OVERLEAF_BROWSER_PROFILE_DIR: join(directory, 'profile'),
    })
    const fetcher = vi.fn(async () => new Response(null, { status: 500 }))

    const error = await failure(createOverleafClient({ config, dependencies: { fetcher, connectionFactory: vi.fn() } }))
    expect(error).toBeInstanceOf(McpError)
    expect(ERROR_CODES).toContain(error.code)
    expect(fetcher).not.toHaveBeenCalled()
  })

  test('types: results are the contract outputs, and required inputs are required', () => {
    expectTypeOf<OverleafClient['readFile']>().returns.resolves.toEqualTypeOf<OperationOutput<'read_file'>>()
    expectTypeOf<OverleafClient['writeFile']>().returns.resolves.toEqualTypeOf<OperationOutput<'write_file'>>()
    expectTypeOf<OverleafClient['writeFile']>().parameter(0).toHaveProperty('revision').toEqualTypeOf<string>()
    expectTypeOf<OverleafClient['readFile']>().parameter(1).toEqualTypeOf<OperationContext | undefined>()
    expectTypeOf<OverleafClient['authStatus']>().toBeCallableWith()
    // A tool whose parameters are all optional may be called with none, as list_projects can.
    expectTypeOf<OverleafClient['listProjects']>().toBeCallableWith()

    const compileOnly = (client: OverleafClient): Promise<unknown> =>
      // @ts-expect-error -- writeFile requires the revision readFile returned
      client.writeFile({ projectId: PROJECT, filePath: 'main.tex', content: 'x' })
    expect(compileOnly).toBeTypeOf('function')
  })
})
