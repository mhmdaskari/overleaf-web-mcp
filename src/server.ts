import { McpServer, type Transport } from '@modelcontextprotocol/server'
import { serveStdio, type StdioServerHandle } from '@modelcontextprotocol/server/stdio'

import { SERVER_INSTRUCTIONS } from './mcp/instructions.js'
import { registerOverleafTools, type OverleafToolRuntime } from './mcp/tools.js'
import { SERVER_NAME, SERVER_VERSION } from './version.js'

export { SERVER_INSTRUCTIONS } from './mcp/instructions.js'
export { SERVER_NAME, SERVER_VERSION } from './version.js'

/**
 * Creates one transport-agnostic MCP server instance. Its usage instructions reach the client in
 * the `initialize` result on 2025-era protocol versions and in the `server/discover` result on
 * 2026-07-28, so clients that surface them give the model the safety contract without reading the
 * documentation.
 */
export function createMcpServer(runtime: OverleafToolRuntime): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: SERVER_INSTRUCTIONS }
  )
  registerOverleafTools(
    server as unknown as Parameters<typeof registerOverleafTools>[0],
    runtime
  )
  return server
}

/**
 * Serves the tools over stdio, or over `transport` in tests. The client's opening message picks
 * the protocol era (`initialize` for 2025-era versions, `server/discover` for 2026-07-28), and the
 * SDK builds server instances from createMcpServer as it needs them. The runtime is shared; the
 * caller closes it.
 */
export function serveOverStdio(
  runtime: OverleafToolRuntime,
  transport?: Transport
): StdioServerHandle {
  return serveStdio(() => createMcpServer(runtime), transport === undefined ? {} : { transport })
}
