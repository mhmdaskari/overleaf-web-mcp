import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { McpServer, type ServerContext } from '@modelcontextprotocol/server'
import { describe, expect, test, vi } from 'vitest'

import { SERVER_INSTRUCTIONS } from '../src/mcp/instructions.js'
import { TOOL_NAMES, type ToolCallExtra } from '../src/mcp/tools.js'
import { createMcpServer, SERVER_NAME, serveOverStdio } from '../src/server.js'

function fakeRuntime() {
  return {
    authStatus: vi.fn(),
    account: { listProjects: vi.fn() },
    projects: {
      createProject: vi.fn(),
      cloneProject: vi.fn(),
      importProjectZip: vi.fn(),
      manageProject: vi.fn(),
      updateProjectSettings: vi.fn(),
    },
    entities: {
      getProjectTree: vi.fn(),
      manageEntity: vi.fn(),
      uploadFile: vi.fn(),
      downloadFile: vi.fn(),
    },
    documents: { readFile: vi.fn(), writeFile: vi.fn() },
    createFile: vi.fn(),
    sections: {
      getSections: vi.fn(),
      getSectionContent: vi.fn(),
      writeSection: vi.fn(),
    },
    compile: { compileProject: vi.fn(), stopCompile: vi.fn() },
    comments: {
      listComments: vi.fn(),
      replyToComment: vi.fn(),
      addComment: vi.fn(),
      setCommentStatus: vi.fn(),
    },
    history: { monitorProjectHistory: vi.fn() },
    sync: { planSync: vi.fn(), syncDirectory: vi.fn(), deleteEntities: vi.fn() },
  }
}

/** A runtime whose plan_sync reports two progress steps before returning a schema-valid plan. */
function runtimeWithPlanProgress() {
  const runtime = fakeRuntime()
  const plan = {
    planToken: 'token',
    localFolderPath: '/work/paper',
    destinationFolderPath: '',
    toUpload: [{ localPath: 'a.png', destinationPath: 'a.png', reason: 'new' }],
    identical: { count: 0, paths: [] },
    remoteOnly: [{ destinationPath: 'old', entityId: 'e', type: 'folder', contains: 2 }],
    conflicts: [],
    ignored: { count: 1, entries: [{ localPath: 'main.aux', matchedPattern: '*.aux' }] },
  }
  runtime.sync.planSync.mockImplementation(async (_id: string, _path: string, options: {
    onProgress?: (progress: number, total: number, message: string) => Promise<void>
  }) => {
    await options.onProgress?.(1, 2, 'Read 1 of 2 documents')
    await options.onProgress?.(2, 2, 'Read 2 of 2 documents')
    return plan
  })
  return { runtime, plan }
}

async function connectedPair() {
  const server = createMcpServer(fakeRuntime())
  const client = new Client({ name: 'smoke-client', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return { server, client }
}

describe('MCP server', () => {
  test('constructs the SDK server with the full tool surface', () => {
    const registerTool = vi.spyOn(McpServer.prototype, 'registerTool')
    try {
      const server = createMcpServer(fakeRuntime())

      expect(server).toBeInstanceOf(McpServer)
      expect(registerTool.mock.calls.map(call => call[0])).toEqual(TOOL_NAMES)
    } finally {
      registerTool.mockRestore()
    }
  })

  test('lists all tools over an MCP transport handshake', async () => {
    const { server, client } = await connectedPair()
    const result = await client.listTools()

    expect(result.tools.map(tool => tool.name)).toEqual(TOOL_NAMES)
    // Parameter descriptions survive the schema conversion the SDK performs.
    expect(result.tools.find(tool => tool.name === 'list_projects')?.inputSchema.properties?.query)
      .toMatchObject({ description: 'Case-insensitive substring of the project name' })
    await client.close()
    await server.close()
  })

  test('returns structuredContent that satisfies the declared outputSchema over the transport', async () => {
    const runtime = fakeRuntime()
    const listing = {
      projects: [{ id: 'p', name: 'Paper', accessLevel: 'owner', archived: false, trashed: false }],
      totalMatched: 1,
      totalProjects: 1,
    }
    runtime.account.listProjects.mockResolvedValue(listing)
    const server = createMcpServer(runtime)
    const client = new Client({ name: 'smoke-client', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    const listed = await client.listTools()
    expect(listed.tools.find(tool => tool.name === 'list_projects')?.outputSchema).toBeDefined()
    const result = await client.callTool({ name: 'list_projects', arguments: { query: 'Pap' } })
    expect(result.structuredContent).toEqual(listing)
    expect(runtime.account.listProjects).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'Pap', includeArchived: false, limit: 50 })
    )
    await client.close()
    await server.close()
  })

  test('validates auth_status structuredContent against its output schema over the transport', async () => {
    const runtime = fakeRuntime()
    const status = {
      authenticated: true,
      baseUrl: 'https://overleaf.test',
      userId: 'user',
      projectCount: 3,
      sessionExpiresAt: '2026-09-19T00:00:00.000Z',
      permissionsUnchecked: false,
      socketPresenceNotice: 'notice',
    }
    runtime.authStatus.mockResolvedValue(status)
    const server = createMcpServer(runtime)
    const client = new Client({ name: 'smoke-client', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    const result = await client.callTool({ name: 'auth_status', arguments: {} })
    expect(result.isError).toBeFalsy()
    expect(result.structuredContent).toEqual(status)
    await client.close()
    await server.close()
  })

  test('delivers sync progress notifications and a schema-valid plan over the transport', async () => {
    const { runtime, plan } = runtimeWithPlanProgress()
    const server = createMcpServer(runtime)
    const client = new Client({ name: 'smoke-client', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    const progress: Array<{ progress: number; total?: number | undefined }> = []
    const result = await client.callTool(
      { name: 'plan_sync', arguments: { projectId: 'p', localFolderPath: '/work/paper' } },
      { onprogress: update => progress.push({ progress: update.progress, total: update.total }) }
    )

    expect(result.isError).toBeFalsy()
    expect(result.structuredContent).toEqual(plan)
    expect(progress).toEqual([
      { progress: 1, total: 2 },
      { progress: 2, total: 2 },
    ])
    expect(runtime.sync.planSync).toHaveBeenCalledWith(
      'p',
      '/work/paper',
      expect.objectContaining({ destinationFolderPath: '', verbose: false })
    )
    await client.close()
    await server.close()
  })

  test('sends bounded usage instructions to a connecting client', async () => {
    const { server, client } = await connectedPair()
    const instructions = client.getInstructions()

    expect(instructions).toBe(SERVER_INSTRUCTIONS)
    // The contract an assistant must know without reading the docs.
    for (const term of ['read_file', 'revision', 'REVISION_CONFLICT', 'upload_file', 'confirmPath', 'confirmName', 'manage_project', 'plan_sync', 'planToken', 'confirmDeleteCount', 'REMOTE_DRIFT', 'AUTH_EXPIRED']) {
      expect(instructions).toContain(term)
    }
    // Instructions ride along on every session; keep them short enough to be read.
    expect(instructions!.split(/\s+/u).length).toBeLessThan(450)
    await client.close()
    await server.close()
  })
})

// serveOverStdio is what `overleaf-web-mcp serve` runs. The client's opening message decides the
// protocol era, and both eras must receive the same tools and the same usage instructions.
describe('protocol eras', () => {
  function served(runtime: ReturnType<typeof fakeRuntime> = fakeRuntime()) {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const connection = serveOverStdio(runtime, serverTransport)
    return { clientTransport, connection }
  }

  test.each(['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'])(
    'serves a client on protocol %s through initialize',
    async version => {
      const { clientTransport, connection } = served()
      const client = new Client(
        { name: 'legacy-client', version: '1.0.0' },
        { supportedProtocolVersions: [version] }
      )
      await client.connect(clientTransport)

      expect(client.getProtocolEra()).toBe('legacy')
      expect(client.getNegotiatedProtocolVersion()).toBe(version)
      expect(client.getDiscoverResult()).toBeUndefined()
      expect(client.getInstructions()).toBe(SERVER_INSTRUCTIONS)
      expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(TOOL_NAMES)
      await client.close()
      await connection.close()
    }
  )

  test('answers a bare initialize from a client without the v2 SDK', async () => {
    const { clientTransport: peer, connection } = served()
    const waiting = new Map<number, (message: { result?: Record<string, unknown> }) => void>()
    peer.onmessage = (message: unknown) => {
      const response = message as { id?: unknown; result?: Record<string, unknown> }
      if (typeof response.id === 'number') waiting.get(response.id)?.(response)
    }
    await peer.start()
    const request = (id: number, method: string, params: Record<string, unknown>) =>
      new Promise<{ result?: Record<string, unknown> }>(resolve => {
        waiting.set(id, resolve)
        void peer.send({ jsonrpc: '2.0', id, method, params })
      })

    const initialized = await request(1, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'bare', version: '0' },
    })
    expect(initialized.result).toMatchObject({
      protocolVersion: '2024-11-05',
      serverInfo: { name: SERVER_NAME },
      capabilities: { tools: {} },
      instructions: SERVER_INSTRUCTIONS,
    })
    await peer.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    const listed = await request(2, 'tools/list', {})
    const tools = listed.result?.tools as Array<{ name: string }>
    expect(tools.map(tool => tool.name)).toEqual(TOOL_NAMES)
    await peer.close()
    await connection.close()
  })

  test('serves a 2026-07-28 client through server/discover with the same instructions', async () => {
    const { clientTransport, connection } = served()
    const client = new Client(
      { name: 'modern-client', version: '1.0.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } }
    )
    await client.connect(clientTransport)

    expect(client.getProtocolEra()).toBe('modern')
    expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28')
    expect(client.getDiscoverResult()?.instructions).toBe(SERVER_INSTRUCTIONS)
    expect(client.getInstructions()).toBe(SERVER_INSTRUCTIONS)
    expect((await client.discover()).instructions).toBe(SERVER_INSTRUCTIONS)
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(TOOL_NAMES)
    await client.close()
    await connection.close()
  })

  test('delivers sync progress to a 2026-07-28 client', async () => {
    const { runtime, plan } = runtimeWithPlanProgress()
    const { clientTransport, connection } = served(runtime)
    const client = new Client(
      { name: 'modern-client', version: '1.0.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } }
    )
    await client.connect(clientTransport)

    const progress: number[] = []
    const result = await client.callTool(
      { name: 'plan_sync', arguments: { projectId: 'p', localFolderPath: '/work/paper' } },
      { onprogress: update => progress.push(update.progress) }
    )

    expect(result.isError).toBeFalsy()
    expect(result.structuredContent).toEqual(plan)
    expect(progress).toEqual([1, 2])
    await client.close()
    await connection.close()
  })

  test('rejects a tool name the server does not register', async () => {
    const { clientTransport, connection } = served()
    const client = new Client({ name: 'legacy-client', version: '1.0.0' })
    await client.connect(clientTransport)

    await expect(client.callTool({ name: 'no_such_tool', arguments: {} })).rejects.toMatchObject({
      code: -32602,
    })
    await client.close()
    await connection.close()
  })

  test('tools read the progress token and notifier where the SDK puts them', () => {
    // Compile-time guard: npm run check fails if ServerContext stops matching ToolCallExtra.
    const toExtra = (context: ServerContext): ToolCallExtra => context
    expect(toExtra).toBeTypeOf('function')
  })
})
