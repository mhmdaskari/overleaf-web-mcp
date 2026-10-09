import { describe, expect, test, vi } from 'vitest'

// overleaf-web-mcp/core must work where the MCP SDK and the MCP adapter cannot even be loaded.
vi.mock('@modelcontextprotocol/server', () => {
  throw new Error('the MCP SDK was loaded')
})
vi.mock('@modelcontextprotocol/server/stdio', () => {
  throw new Error('the MCP SDK was loaded')
})
vi.mock('../src/mcp/tools.js', () => {
  throw new Error('the MCP adapter was loaded')
})
vi.mock('../src/server.js', () => {
  throw new Error('the MCP server was loaded')
})

describe('overleaf-web-mcp/core', () => {
  test('reads a file through the service without loading MCP', async () => {
    const core = await import('../src/sdk.js')
    const { createTestRuntime } = await import('./helpers/runtime.js')
    const { runtime, socketCalls } = await createTestRuntime({ documentLines: ['\\section{Intro}'] })
    try {
      const service = core.createOverleafService(runtime)
      const file = await service.read_file({ projectId: 'p', filePath: 'main.tex' })
      expect(file).toMatchObject({ content: '\\section{Intro}', protocol: 'sharejs' })
      expect(socketCalls).toEqual(['joinDoc', 'leaveDoc'])
    } finally {
      await runtime.close()
    }
  })

  test('exposes the contracts and the same error class, and no internal connection class', async () => {
    const core = await import('../src/sdk.js')
    const errors = await import('../src/core/errors.js')
    expect(core.McpError).toBe(errors.McpError)
    expect(core.OPERATION_NAMES).toHaveLength(Object.keys(core.OPERATIONS).length)
    expect(core.ERROR_CODES).toContain('CONFIRMATION_MISMATCH')
    expect('ProjectConnection' in core).toBe(false)
    expect('createMcpServer' in core).toBe(false)
  })
})
