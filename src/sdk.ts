/**
 * `overleaf-web-mcp/core`: the operations behind the MCP server, without MCP. It never loads the
 * MCP SDK. During v0.5.0 it exposes the same service as the MCP server, safety defaults and their
 * deprecations included; v0.7.0 documents which parts are stable and adds a client facade.
 *
 * ```ts
 * import { createOverleafService, OverleafRuntime, readConfig } from 'overleaf-web-mcp/core'
 *
 * const runtime = await OverleafRuntime.create(readConfig())
 * try {
 *   const service = createOverleafService(runtime)
 *   const file = await service.read_file({ projectId, filePath: 'main.tex' })
 * } finally {
 *   await runtime.close()
 * }
 * ```
 */
export { readConfig, type AppConfig } from './config.js'
export * from './contracts/index.js'
export { McpError, type McpErrorCode } from './core/errors.js'
export type { WriteMode } from './overleaf/documents.js'
export { OverleafRuntime, type RuntimeDependencies } from './runtime.js'
export { createOverleafService } from './service/operations.js'
export { SERVER_VERSION } from './version.js'
