import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { describe, expect, test, vi } from 'vitest'

import { SERVER_INSTRUCTIONS } from '../src/mcp/instructions.js'
import { TOOL_NAMES } from '../src/mcp/tools.js'
import { createMcpServer } from '../src/server.js'

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

async function connectedPair() {
  const server = createMcpServer(fakeRuntime())
  const client = new Client({ name: 'smoke-client', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return { server, client }
}

describe('MCP server', () => {
  test('constructs the SDK server with the full tool surface', () => {
    const server = createMcpServer(fakeRuntime())

    expect(server).toBeInstanceOf(McpServer)
    const registered = (server as unknown as { _registeredTools: Record<string, unknown> })
      ._registeredTools
    expect(Object.keys(registered)).toEqual(TOOL_NAMES)
  })

  test('lists all tools over an MCP transport handshake', async () => {
    const { server, client } = await connectedPair()
    const result = await client.listTools()

    expect(result.tools.map(tool => tool.name)).toEqual(TOOL_NAMES)
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
    const server = createMcpServer(runtime)
    const client = new Client({ name: 'smoke-client', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    const progress: Array<{ progress: number; total?: number | undefined }> = []
    const result = await client.callTool(
      { name: 'plan_sync', arguments: { projectId: 'p', localFolderPath: '/work/paper' } },
      undefined,
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

  test('sends bounded usage instructions in the initialize response', async () => {
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
