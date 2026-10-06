import type { Readable, Writable } from 'node:stream'

import { McpServer, type Transport } from '@modelcontextprotocol/server'
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio'

import { SERVER_INSTRUCTIONS } from './mcp/instructions.js'
import { registerOverleafTools, ToolActivity, type OverleafToolRuntime } from './mcp/tools.js'
import { SERVER_NAME, SERVER_VERSION } from './version.js'

export { SERVER_INSTRUCTIONS } from './mcp/instructions.js'
export { SERVER_NAME, SERVER_VERSION } from './version.js'

/**
 * How long a closed stdin waits for tool calls that are still running before the Overleaf sockets
 * close. MCP clients send SIGTERM about two seconds after closing stdin, so this stays below that.
 */
export const STDIN_CLOSE_GRACE_MS = 1500

/**
 * Creates one transport-agnostic MCP server instance. Its usage instructions reach the client in
 * the `initialize` result on 2025-era protocol versions and in the `server/discover` result on
 * 2026-07-28, so clients that surface them give the model the safety contract without reading the
 * documentation.
 */
export function createMcpServer(runtime: OverleafToolRuntime, activity?: ToolActivity): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: SERVER_INSTRUCTIONS }
  )
  registerOverleafTools(
    server as unknown as Parameters<typeof registerOverleafTools>[0],
    runtime,
    activity
  )
  return server
}

export interface StdioConnection {
  /** Closes the connection now; a call still running loses its reply. */
  close(): Promise<void>
  /** Resolves true once no tool call is running, or false when timeoutMs passes first. */
  whenIdle(timeoutMs: number): Promise<boolean>
}

/**
 * Serves the tools over stdio, or over `transport` in tests. The client's opening message picks
 * the protocol era (`initialize` for 2025-era versions, `server/discover` for 2026-07-28), and the
 * SDK builds server instances from createMcpServer as it needs them. The runtime is shared; the
 * caller closes it.
 */
export function serveOverStdio(runtime: OverleafToolRuntime, transport?: Transport): StdioConnection {
  const activity = new ToolActivity()
  const handle = serveStdio(
    () => createMcpServer(runtime, activity),
    transport === undefined ? {} : { transport }
  )
  return {
    close: () => handle.close(),
    whenIdle: timeoutMs => activity.whenIdle(timeoutMs),
  }
}

export interface StdioServerOptions {
  input?: Readable
  output?: Writable
  /** Defaults to STDIN_CLOSE_GRACE_MS. */
  stdinCloseGraceMs?: number
  /** Defaults to process.exit. */
  exit?: (code: number) => void
}

/**
 * Runs `overleaf-web-mcp serve`: serves until the client closes stdin or shutdown() is called,
 * then closes the runtime once and exits with code 0. A closed stdin first lets running tool calls
 * finish for up to stdinCloseGraceMs, so a multi-step operation is not cut off between its steps;
 * shutdown(), used for signals, closes at once.
 */
export function runStdioServer(
  runtime: OverleafToolRuntime & { close(): Promise<void> },
  options: StdioServerOptions = {}
): { shutdown(): Promise<void> } {
  const input = options.input ?? process.stdin
  const exit = options.exit ?? ((code: number) => process.exit(code))
  const graceMs = options.stdinCloseGraceMs ?? STDIN_CLOSE_GRACE_MS
  const connection = serveOverStdio(
    runtime,
    new StdioServerTransport(input, options.output ?? process.stdout)
  )
  let closed: Promise<void> | undefined
  const close = (waitMs: number): Promise<void> =>
    (closed ??= (async () => {
      if (waitMs > 0) await connection.whenIdle(waitMs)
      await connection.close().catch(() => undefined)
      await runtime.close().catch(() => undefined)
      exit(0)
    })())
  const onStdinClosed = (): void => {
    void close(graceMs)
  }
  input.once('end', onStdinClosed)
  input.once('close', onStdinClosed)
  return { shutdown: () => close(0) }
}
