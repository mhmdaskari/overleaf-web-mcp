import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { afterAll, describe, expect, test, vi, type Mock } from 'vitest'

import { operationJsonSchema } from '../src/cli/json-schema.js'
import type { OperationCommand } from '../src/cli/parse.js'
import { runCommandLine, runOperationCommand, type CliIo, type CliRuntime } from '../src/cli/run.js'
import { createOverleafClient } from '../src/client.js'
import { readConfig, type AppConfig } from '../src/config.js'
import { OPERATION_NAMES, operationContract, type OperationName } from '../src/contracts/operations.js'
import { parseOperationInput } from '../src/contracts/parse.js'
import type { OverleafServiceRuntime } from '../src/contracts/service.js'
import { McpError } from '../src/core/errors.js'
import { OverleafRuntime, type RuntimeDependencies } from '../src/runtime.js'
import { createMcpServer, serveOverStdio } from '../src/server.js'
import { createOverleafService } from '../src/service/operations.js'
import { fakeServiceRuntime } from './helpers/fake-runtime.js'
import { INPUTS } from './helpers/operation-inputs.js'
import { OUTPUTS } from './helpers/operation-outputs.js'
import { BOOTSTRAP_PAGE, cookieJar } from './helpers/runtime.js'

// The v0.7.0 parity acceptance: one operation gives the same result, the same error, and the same
// schema through the MCP server, the command line, and overleaf-web-mcp/core.

type FakeRuntime = ReturnType<typeof fakeServiceRuntime>
type Call = (input?: unknown, context?: unknown) => Promise<unknown>
type ToolResult = { isError?: boolean; structuredContent?: unknown; content: unknown }

const BASE_URL = 'https://overleaf.test'

/** Folders the tests create, removed after the file runs. */
const scratch: string[] = []
afterAll(async () => {
  await Promise.all(scratch.map(folder => rm(folder, { recursive: true, force: true })))
})

async function folder(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix))
  scratch.push(path)
  return path
}

/** `read_file` → `readFile`, as createOverleafClient names its methods. */
function camelCase(name: string): string {
  return name.replace(/_([a-z])/gu, (_match, letter: string) => letter.toUpperCase())
}

/** Every domain call a fake runtime received, by the method's path (`sync.planSync`). */
function ledger(runtime: FakeRuntime): Record<string, unknown[][]> {
  const calls: Record<string, unknown[][]> = {}
  for (const [key, value] of Object.entries(runtime)) {
    if (key === 'close') continue
    if (typeof value === 'function') {
      calls[key] = (value as Mock).mock.calls
      continue
    }
    for (const [method, mock] of Object.entries(value as Record<string, Mock>)) {
      calls[`${key}.${method}`] = mock.mock.calls
    }
  }
  return calls
}

/** Makes every domain method of a fake runtime fail with `error`. */
function failEverywhere(runtime: FakeRuntime, error: unknown): void {
  for (const [key, value] of Object.entries(runtime)) {
    if (key === 'close') continue
    const mocks = typeof value === 'function' ? [value as Mock] : Object.values(value as Record<string, Mock>)
    for (const mock of mocks) mock.mockRejectedValue(error)
  }
}

/** One MCP client connected over an in-memory transport to a server over `runtime`. */
async function connectMcp(runtime: OverleafServiceRuntime, era: 'legacy' | 'modern' = 'legacy') {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  if (era === 'modern') {
    // serveOverStdio is what `serve` runs; it answers a 2026-07-28 client through server/discover.
    const connection = serveOverStdio(runtime, serverTransport)
    const client = new Client(
      { name: 'parity-client', version: '1.0.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } }
    )
    await client.connect(clientTransport)
    return {
      client,
      close: async () => {
        await client.close()
        await connection.close()
      },
    }
  }
  const server = createMcpServer(runtime)
  const client = new Client({ name: 'parity-client', version: '1.0.0' })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return {
    client,
    close: async () => {
      await client.close()
      await server.close()
    },
  }
}

/** The JSON text block of a tool result. */
function textBlock(result: ToolResult): unknown {
  const content = result.content as Array<{ type: string; text?: string }>
  expect(content).toHaveLength(1)
  expect(content[0]?.type).toBe('text')
  return JSON.parse(content[0]?.text ?? '')
}

/** Calls one tool and returns the result's text block and structuredContent. */
async function callMcp(runtime: OverleafServiceRuntime, name: OperationName, input: Record<string, unknown>) {
  const mcp = await connectMcp(runtime)
  try {
    // The client validates structuredContent only against a tools/list it holds.
    await mcp.client.listTools()
    const result = (await mcp.client.callTool({ name, arguments: input })) as ToolResult
    return { isError: result.isError === true, structuredContent: result.structuredContent, text: textBlock(result) }
  } finally {
    await mcp.close()
  }
}

/** Streams that record what an operation command prints. stdin is never read here. */
function captureIo() {
  const stdout: string[] = []
  const stderr: string[] = []
  const io: CliIo = {
    stdout: text => {
      stdout.push(text)
    },
    stderr: text => {
      stderr.push(text)
    },
    readStdin: async () => {
      throw new Error('stdin is not read by these commands')
    },
  }
  return { io, stdout: () => stdout.join(''), stderr: () => stderr.join('') }
}

async function runCli(
  command: OperationCommand,
  createRuntime: (config: AppConfig) => Promise<CliRuntime>,
  env: NodeJS.ProcessEnv
) {
  const { io, stdout, stderr } = captureIo()
  const exitCode = await runOperationCommand(command, io, { env, createRuntime })
  return { exitCode, stdout: stdout(), stderr: stderr() }
}

/** `overleaf-web-mcp call <name> --json <input>`. */
async function callCli(
  name: OperationName,
  input: Record<string, unknown>,
  createRuntime: (config: AppConfig) => Promise<CliRuntime>,
  env: NodeJS.ProcessEnv
) {
  return await runCli(
    { kind: 'call', tool: name, request: { from: 'json', text: JSON.stringify(input) }, progress: false },
    createRuntime,
    env
  )
}

/** `overleaf-web-mcp call <name> --request <file>`, parsed from the command line. */
async function callCliWithRequestFile(
  name: OperationName,
  input: Record<string, unknown>,
  createRuntime: (config: AppConfig) => Promise<CliRuntime>,
  env: NodeJS.ProcessEnv
) {
  const request = join(await folder('overleaf-parity-request-'), 'request.json')
  await writeFile(request, JSON.stringify(input))
  const { io, stdout, stderr } = captureIo()
  const exitCode = await runCommandLine(['call', name, '--request', request], io, { env, createRuntime })
  return { exitCode, stdout: stdout(), stderr: stderr() }
}

/** A failed command: stdout empty, exactly one JSON line on stderr. */
function stderrError(result: { stdout: string; stderr: string }): unknown {
  expect(result.stdout).toBe('')
  expect(result.stderr.endsWith('\n')).toBe(true)
  const lines = result.stderr.trimEnd().split('\n')
  expect(lines).toHaveLength(1)
  return JSON.parse(lines[0] ?? '')
}

/**
 * The environment for calls whose runtime is injected: readConfig reads it, so nothing from the
 * maintainer's own OVERLEAF_* variables reaches the call, and nothing reads these paths.
 */
const FAKE_ENV: NodeJS.ProcessEnv = {
  OVERLEAF_BASE_URL: BASE_URL,
  OVERLEAF_COOKIE_JAR_FILE: join(tmpdir(), 'overleaf-parity-unused', 'cookies.txt'),
  OVERLEAF_BROWSER_PROFILE_DIR: join(tmpdir(), 'overleaf-parity-unused', 'profile'),
}

/**
 * The real createOverleafClient over a fake runtime: OverleafRuntime.create is the one place it
 * opens a session, so answering that call with the fake keeps every other line of the client real.
 */
async function sdkCall(runtime: FakeRuntime, name: OperationName, input: Record<string, unknown>): Promise<unknown> {
  const create = vi.spyOn(OverleafRuntime, 'create').mockResolvedValueOnce(runtime as unknown as OverleafRuntime)
  try {
    const config = readConfig(FAKE_ENV)
    const client = await createOverleafClient({ config })
    expect(create).toHaveBeenCalledWith(config, undefined)
    try {
      const method = (client as unknown as Record<string, Call>)[camelCase(name)]
      expect(method, camelCase(name)).toBeTypeOf('function')
      return await method!(input)
    } finally {
      await client.close()
    }
  } finally {
    create.mockRestore()
  }
}

/** The service path the client takes: strict parsing, then the operation. */
async function serviceCall(
  runtime: FakeRuntime,
  name: OperationName,
  input: Record<string, unknown>
): Promise<unknown> {
  const service = createOverleafService(runtime) as unknown as Record<OperationName, Call>
  return await service[name](parseOperationInput(name, input))
}

/** The `{ code, message, retryable, details? }` a rejected call carries. */
async function rejection(call: Promise<unknown>): Promise<unknown> {
  try {
    await call
  } catch (error) {
    expect(error).toBeInstanceOf(McpError)
    return (error as McpError).toJSON()
  }
  throw new Error('the call was expected to fail')
}

describe('one operation, one result, through MCP, the CLI, and the SDK', () => {
  test.each(OPERATION_NAMES)('%s', async name => {
    const runtimes = {
      mcp: fakeServiceRuntime(),
      cli: fakeServiceRuntime(),
      cliFile: fakeServiceRuntime(),
      sdk: fakeServiceRuntime(),
      service: fakeServiceRuntime(),
    }
    const input = INPUTS[name]

    const mcp = await callMcp(runtimes.mcp, name, input)
    const cli = await callCli(name, input, async () => runtimes.cli, FAKE_ENV)
    const cliFile = await callCliWithRequestFile(name, input, async () => runtimes.cliFile, FAKE_ENV)
    const sdk = await sdkCall(runtimes.sdk, name, input)
    const service = await serviceCall(runtimes.service, name, input)

    expect(mcp.isError).toBe(false)
    expect(mcp.structuredContent).toEqual(OUTPUTS[name])
    expect(mcp.text).toEqual(mcp.structuredContent)
    expect(cli.exitCode).toBe(0)
    expect(cli.stderr).toBe('')
    expect(cli.stdout.endsWith('\n')).toBe(true)
    expect(JSON.parse(cli.stdout)).toEqual(mcp.structuredContent)
    expect(cliFile.exitCode).toBe(0)
    expect(cliFile.stderr).toBe('')
    expect(cliFile.stdout).toBe(cli.stdout)
    expect(sdk).toEqual(mcp.structuredContent)
    expect(service).toEqual(mcp.structuredContent)

    // The domain engine is reached once, with the same arguments: the MCP SDK's parse (defaults
    // applied, unknown keys dropped) and parseOperationInput hand the service the same input.
    const reached = ledger(runtimes.mcp)
    expect(Object.values(reached).flat()).toHaveLength(1)
    expect(ledger(runtimes.cli)).toEqual(reached)
    expect(ledger(runtimes.cliFile)).toEqual(reached)
    expect(ledger(runtimes.sdk)).toEqual(reached)
    expect(ledger(runtimes.service)).toEqual(reached)
    // A command closes the runtime it opened; so does a closed client.
    expect(runtimes.cli.close).toHaveBeenCalledTimes(1)
    expect(runtimes.cliFile.close).toHaveBeenCalledTimes(1)
    expect(runtimes.sdk.close).toHaveBeenCalledTimes(1)
  })
})

describe('one failure, one error object, through every interface', () => {
  const conflict = new McpError('REVISION_CONFLICT', 'The write was cut off; its outcome is unknown.', {
    details: { outcome: 'unknown' },
  })

  test.each(OPERATION_NAMES)('an injected REVISION_CONFLICT from %s', async name => {
    const runtimes = {
      mcp: fakeServiceRuntime(),
      cli: fakeServiceRuntime(),
      sdk: fakeServiceRuntime(),
      service: fakeServiceRuntime(),
    }
    for (const runtime of Object.values(runtimes)) failEverywhere(runtime, conflict)
    const input = INPUTS[name]

    const mcp = await callMcp(runtimes.mcp, name, input)
    const cli = await callCli(name, input, async () => runtimes.cli, FAKE_ENV)
    const sdk = await rejection(sdkCall(runtimes.sdk, name, input))
    const service = await rejection(serviceCall(runtimes.service, name, input))

    const expected = {
      code: 'REVISION_CONFLICT',
      message: 'The write was cut off; its outcome is unknown.',
      retryable: false,
      details: { outcome: 'unknown' },
    }
    expect(mcp.isError).toBe(true)
    expect(mcp.structuredContent).toBeUndefined()
    expect(mcp.text).toStrictEqual(expected)
    expect(stderrError(cli)).toStrictEqual(expected)
    expect(sdk).toStrictEqual(expected)
    expect(service).toStrictEqual(expected)
    // details.outcome "unknown" wins over the code: read before acting, never re-run.
    expect(cli.exitCode).toBe(5)
  })

  test.each([
    {
      label: 'a retryable McpError with details',
      error: new McpError('RATE_LIMITED', 'Overleaf asked for fewer requests.', {
        retryable: true,
        details: { retryAfterSeconds: 30 },
      }),
      expected: {
        code: 'RATE_LIMITED',
        message: 'Overleaf asked for fewer requests.',
        retryable: true,
        details: { retryAfterSeconds: 30 },
      },
      exitCode: 7,
    },
    {
      label: 'an error without details',
      error: new McpError('NOT_FOUND', 'No such file.'),
      expected: { code: 'NOT_FOUND', message: 'No such file.', retryable: false },
      exitCode: 1,
    },
    {
      label: 'a plain Error, wrapped as REMOTE_ERROR',
      error: new Error('socket closed'),
      expected: { code: 'REMOTE_ERROR', message: 'socket closed', retryable: false },
      exitCode: 1,
    },
  ])('$label from read_file', async ({ error, expected, exitCode }) => {
    const runtimes = {
      mcp: fakeServiceRuntime(),
      cli: fakeServiceRuntime(),
      sdk: fakeServiceRuntime(),
      service: fakeServiceRuntime(),
    }
    for (const runtime of Object.values(runtimes)) runtime.documents.readFile.mockRejectedValue(error)
    const input = INPUTS.read_file

    const mcp = await callMcp(runtimes.mcp, 'read_file', input)
    const cli = await callCli('read_file', input, async () => runtimes.cli, FAKE_ENV)

    expect(mcp.isError).toBe(true)
    expect(mcp.text).toStrictEqual(expected)
    expect(stderrError(cli)).toStrictEqual(expected)
    expect(await rejection(sdkCall(runtimes.sdk, 'read_file', input))).toStrictEqual(expected)
    expect(await rejection(serviceCall(runtimes.service, 'read_file', input))).toStrictEqual(expected)
    expect(cli.exitCode).toBe(exitCode)
  })

  test('a read-only result outside its output schema is PROTOCOL_UNSUPPORTED everywhere', async () => {
    const runtimes = {
      mcp: fakeServiceRuntime(),
      cli: fakeServiceRuntime(),
      sdk: fakeServiceRuntime(),
      service: fakeServiceRuntime(),
    }
    // An Overleaf answer this release does not understand: the tree without its entities.
    for (const runtime of Object.values(runtimes)) runtime.entities.getProjectTree.mockResolvedValue({ projectId: 'p' })
    const input = INPUTS.get_project_tree

    const mcp = await callMcp(runtimes.mcp, 'get_project_tree', input)
    const cli = await callCli('get_project_tree', input, async () => runtimes.cli, FAKE_ENV)
    const sdk = await rejection(sdkCall(runtimes.sdk, 'get_project_tree', input))
    const service = await rejection(serviceCall(runtimes.service, 'get_project_tree', input))

    expect(mcp.isError).toBe(true)
    expect(mcp.structuredContent).toBeUndefined()
    expect(mcp.text).toMatchObject({
      code: 'PROTOCOL_UNSUPPORTED',
      retryable: false,
      details: { kind: 'response_shape', paths: expect.arrayContaining(['entities']) },
    })
    expect(stderrError(cli)).toStrictEqual(mcp.text)
    expect(sdk).toStrictEqual(mcp.text)
    expect(service).toStrictEqual(mcp.text)
    expect(cli.exitCode).toBe(1)
  })

  test('a write result outside its output schema is returned, never failed after the write applied', async () => {
    const offSchema = { projectId: 'p', unexpected: true }
    const runtimes = { cli: fakeServiceRuntime(), sdk: fakeServiceRuntime(), service: fakeServiceRuntime() }
    for (const runtime of Object.values(runtimes)) runtime.createFile.mockResolvedValue(offSchema)
    const input = INPUTS.create_file

    const cli = await callCli('create_file', input, async () => runtimes.cli, FAKE_ENV)
    expect(cli.exitCode).toBe(0)
    expect(cli.stderr).toBe('')
    expect(JSON.parse(cli.stdout)).toEqual(offSchema)
    expect(await sdkCall(runtimes.sdk, 'create_file', input)).toEqual(offSchema)
    expect(await serviceCall(runtimes.service, 'create_file', input)).toEqual(offSchema)
  })
})

/**
 * An HTTP fetcher that answers only the session bootstrap (`GET /project`) and records anything
 * else, plus a connection factory that must never be called: together, proof that nothing left.
 */
function upstream() {
  const fetches: string[] = []
  let bootstraps = 0
  const fetcher: NonNullable<RuntimeDependencies['fetcher']> = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const method = init?.method ?? 'GET'
    if (method === 'GET' && url.pathname === '/project') {
      bootstraps += 1
      return new Response(BOOTSTRAP_PAGE)
    }
    fetches.push(`${method} ${url.pathname}`)
    throw new Error('no request may leave in this test')
  }
  const connectionFactory = vi.fn<NonNullable<RuntimeDependencies['connectionFactory']>>(async () => {
    throw new Error('no socket may open in this test')
  })
  return { dependencies: { fetcher, connectionFactory }, fetches, connectionFactory, bootstraps: () => bootstraps }
}

/** An environment for a real runtime: its own protected cookie jar, plus the policy under test. */
async function realEnv(policy: Record<string, string>): Promise<NodeJS.ProcessEnv> {
  const { cookiePath, directory } = await cookieJar()
  scratch.push(directory)
  return {
    OVERLEAF_COOKIE_JAR_FILE: cookiePath,
    OVERLEAF_BASE_URL: BASE_URL,
    OVERLEAF_BROWSER_PROFILE_DIR: join(directory, 'profile'),
    ...policy,
  }
}

/**
 * Real runtimes, one per interface (the CLI closes the one each command opens), all refusing the
 * same calls. Each call returns the error object the interface reported.
 */
async function realInterfaces(policy: Record<string, string>) {
  const mcpSide = upstream()
  const cliSide = upstream()
  const sdkSide = upstream()
  const mcpRuntime = await OverleafRuntime.create(readConfig(await realEnv(policy)), mcpSide.dependencies)
  const mcp = await connectMcp(mcpRuntime)
  await mcp.client.listTools()
  const cliEnv = await realEnv(policy)
  const sdk = await createOverleafClient({
    config: readConfig(await realEnv(policy)),
    dependencies: sdkSide.dependencies,
  })
  const sides = { mcp: mcpSide, cli: cliSide, sdk: sdkSide }
  return {
    sides,
    async call(name: OperationName, input: Record<string, unknown>) {
      const mcpResult = (await mcp.client.callTool({ name, arguments: input })) as ToolResult
      expect(mcpResult.isError, name).toBe(true)
      const cli = await callCli(
        name,
        input,
        async config => await OverleafRuntime.create(config, cliSide.dependencies),
        cliEnv
      )
      const method = (sdk as unknown as Record<string, Call>)[camelCase(name)]!
      return {
        mcp: textBlock(mcpResult),
        cli: stderrError(cli),
        cliExitCode: cli.exitCode,
        sdk: await rejection(method(input)),
      }
    },
    /** Nothing but the bootstrap left any interface, and no socket opened. */
    expectNothingSent() {
      for (const [label, side] of Object.entries(sides)) {
        expect(side.fetches, label).toEqual([])
        expect(side.connectionFactory, label).not.toHaveBeenCalled()
        // The session really was opened, so the refusal came after it, from the policy.
        expect(side.bootstraps(), label).toBeGreaterThan(0)
      }
    },
    async close() {
      await mcp.close()
      await mcpRuntime.close()
      await sdk.close()
    },
  }
}

describe('real refusals, identical everywhere, with nothing sent', () => {
  test('PATH_OUTSIDE_ROOT from download_file outside OVERLEAF_LOCAL_WRITE_ROOTS', async () => {
    const base = await folder('overleaf-parity-roots-')
    const allowed = join(base, 'allowed')
    const outside = join(base, 'outside')
    await mkdir(allowed)
    await mkdir(outside)
    await symlink(outside, join(allowed, 'escape'))
    const interfaces = await realInterfaces({ OVERLEAF_LOCAL_WRITE_ROOTS: allowed })
    try {
      // The message embeds the path as given, so every interface receives the very same string.
      for (const localPath of [join(outside, 'copy.png'), join(allowed, 'escape', 'copy.png')]) {
        const input = { projectId: 'p', filePath: 'a.png', localPath }
        const seen = await interfaces.call('download_file', input)
        expect(seen.mcp).toMatchObject({
          code: 'PATH_OUTSIDE_ROOT',
          retryable: false,
          details: { kind: 'outside_write_roots' },
        })
        expect((seen.mcp as { message: string }).message).toContain(localPath)
        expect(seen.cli).toStrictEqual(seen.mcp)
        expect(seen.sdk).toStrictEqual(seen.mcp)
        expect(seen.cliExitCode).toBe(2)
      }
      interfaces.expectNothingSent()
    } finally {
      await interfaces.close()
    }
  })

  test('POLICY_DENIED from OVERLEAF_ALLOWED_PROJECTS, for every operation that names a project', async () => {
    const interfaces = await realInterfaces({ OVERLEAF_ALLOWED_PROJECTS: 'a' })
    try {
      let checked = 0
      for (const name of OPERATION_NAMES) {
        const input = { ...INPUTS[name] }
        const parameter =
          'sourceProjectId' in input ? 'sourceProjectId' : 'projectId' in input ? 'projectId' : undefined
        if (parameter === undefined) continue
        input[parameter] = 'b'
        const seen = await interfaces.call(name, input)
        expect(seen.mcp, name).toMatchObject({ code: 'POLICY_DENIED', retryable: false, details: { parameter } })
        expect(seen.cli, name).toStrictEqual(seen.mcp)
        expect(seen.sdk, name).toStrictEqual(seen.mcp)
        expect(seen.cliExitCode, name).toBe(3)
        checked += 1
      }
      expect(checked).toBeGreaterThan(20)
      interfaces.expectNothingSent()
    } finally {
      await interfaces.close()
    }
  })
})

describe('one schema, as tools/list advertises it and as `schema` prints it', () => {
  test.each(['legacy', 'modern'] as const)('every tool on the %s protocol era', async era => {
    const mcp = await connectMcp(fakeServiceRuntime(), era)
    try {
      const { tools } = await mcp.client.listTools()
      expect(tools.map(tool => tool.name)).toEqual(OPERATION_NAMES)
      for (const tool of tools) {
        const name = tool.name as OperationName
        expect(tool.inputSchema.type, name).toBe('object')
        expect(tool.outputSchema, name).toBeDefined()
        expect(tool.inputSchema, name).toEqual(operationJsonSchema(name, 'input'))
        expect(tool.outputSchema, name).toEqual(operationJsonSchema(name, 'output'))
        for (const io of ['input', 'output'] as const) {
          const printed = await runCli(
            { kind: 'schema', tool: name, io },
            async () => {
              throw new Error('schema opens no session')
            },
            FAKE_ENV
          )
          expect(printed.exitCode, `${name} ${io}`).toBe(0)
          expect(printed.stderr).toBe('')
          expect(JSON.parse(printed.stdout), `${name} ${io}`).toEqual(
            io === 'input' ? tool.inputSchema : tool.outputSchema
          )
        }
      }
    } finally {
      await mcp.close()
    }
  })

  test.each(['legacy', 'modern'] as const)(
    "the client accepts every tool's structuredContent on the %s protocol era",
    async era => {
      const runtime = fakeServiceRuntime()
      const mcp = await connectMcp(runtime, era)
      try {
        // Without a held tools/list the client has no outputSchema to validate against.
        await mcp.client.listTools()
        for (const name of OPERATION_NAMES) {
          const result = (await mcp.client.callTool({ name, arguments: INPUTS[name] })) as ToolResult
          expect(result.isError, name).toBeFalsy()
          expect(result.structuredContent, name).toEqual(OUTPUTS[name])
        }
      } finally {
        await mcp.close()
      }
    }
  )

  test('the client really validates: a key the advertised outputSchema does not list is refused', async () => {
    // write_file's result is typed, not checked, in the service, and zod on the server strips an
    // unknown key instead of failing; the advertised schema's additionalProperties: false does not.
    expect(operationContract('write_file').annotations.readOnlyHint).not.toBe(true)
    expect(operationJsonSchema('write_file', 'output')).toMatchObject({ additionalProperties: false })
    const runtime = fakeServiceRuntime()
    runtime.documents.writeFile.mockResolvedValue({ ...OUTPUTS.write_file, unexpected: true })
    const mcp = await connectMcp(runtime)
    try {
      await mcp.client.listTools()
      await expect(mcp.client.callTool({ name: 'write_file', arguments: INPUTS.write_file })).rejects.toThrow(
        /does not match the tool's output schema/u
      )
    } finally {
      await mcp.close()
    }
  })
})
