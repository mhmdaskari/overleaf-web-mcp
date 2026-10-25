/**
 * `overleaf-web-mcp/core`: the operations behind the MCP server, without MCP. It never loads the
 * MCP SDK, and has the same safety defaults. docs/sdk.md lists the stable surface:
 * `createOverleafClient`, `createOverleafService`, the contract types, `McpError`, `ERROR_CODES`,
 * `readConfig`, and `OverleafRuntime.create` and `close`.
 *
 * ```ts
 * import { createOverleafClient } from 'overleaf-web-mcp/core'
 *
 * const client = await createOverleafClient()
 * try {
 *   const file = await client.readFile({ projectId, filePath: 'main.tex' })
 * } finally {
 *   await client.close()
 * }
 * ```
 */
export {
  createOverleafClient,
  type CamelCase,
  type OperationMethod,
  type OverleafClient,
  type OverleafClientOptions,
} from './client.js'
export { readConfig, type AppConfig } from './config.js'
export * from './contracts/index.js'
export { McpError, type McpErrorCode } from './core/errors.js'
export type { WriteMode } from './overleaf/documents.js'
export { OverleafRuntime, type RuntimeDependencies } from './runtime.js'
export { createOverleafService } from './service/operations.js'
export { SERVER_VERSION } from './version.js'
