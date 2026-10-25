import { readConfig, type AppConfig } from './config.js'
import type { OperationContext } from './contracts/context.js'
import { OPERATION_NAMES, type OperationInput, type OperationName, type OperationOutput } from './contracts/operations.js'
import { parseOperationInput } from './contracts/parse.js'
import { McpError } from './core/errors.js'
import { OverleafRuntime, type RuntimeDependencies } from './runtime.js'
import { createOverleafService } from './service/operations.js'

/** `read_file` → `readFile`. */
export type CamelCase<S extends string> = S extends `${infer Head}_${infer Tail}` ? `${Head}${Capitalize<CamelCase<Tail>>}` : S

/** One operation as a client method: an operation without parameters may be called with none. */
export type OperationMethod<N extends OperationName> = OperationInput<N> extends Record<string, never>
  ? (input?: OperationInput<N>, context?: OperationContext) => Promise<OperationOutput<N>>
  : (input: OperationInput<N>, context?: OperationContext) => Promise<OperationOutput<N>>

/**
 * Every operation as a camelCase method (`readFile`, `syncDirectory`), plus `close()`. A method
 * resolves with the operation's result, the object the MCP server returns as `structuredContent`,
 * and rejects with `McpError` and the same codes.
 */
export type OverleafClient = { readonly [N in OperationName as CamelCase<N>]: OperationMethod<N> } & {
  /** Closes the project sockets the client opened. A method called afterwards is refused. */
  close(): Promise<void>
}

export interface OverleafClientOptions {
  /** Defaults to `readConfig()`, the same environment variables the MCP server reads. */
  config?: AppConfig
  /** @internal Replaces the HTTP fetcher and the project sockets, for tests. */
  dependencies?: RuntimeDependencies
}

function camelCase(name: string): string {
  return name.replace(/_([a-z])/gu, (_match, letter: string) => letter.toUpperCase())
}

/**
 * Opens the saved web session and returns a client over the same operations as the MCP server,
 * with the same safety defaults. Input is checked strictly: an unknown key, at any depth, is
 * `INVALID_ARGUMENT` before anything is sent, where the MCP server would drop it. Close the client
 * when done, so cached project sockets do not keep the process alive.
 *
 * ```ts
 * const client = await createOverleafClient()
 * try {
 *   const file = await client.readFile({ projectId, filePath: 'main.tex' })
 *   await client.writeFile({ projectId, filePath: 'main.tex', revision: file.revision, content })
 * } finally {
 *   await client.close()
 * }
 * ```
 */
export async function createOverleafClient(options: OverleafClientOptions = {}): Promise<OverleafClient> {
  const runtime = await OverleafRuntime.create(options.config ?? readConfig(), options.dependencies)
  const service = createOverleafService(runtime)
  let closed = false
  const client: Record<string, unknown> = {
    close: async () => {
      if (closed) return
      closed = true
      await runtime.close()
    },
  }
  for (const name of OPERATION_NAMES) {
    const call = service[name] as (input: unknown, context?: OperationContext) => Promise<unknown>
    client[camelCase(name)] = async (input?: unknown, context?: OperationContext) => {
      if (closed) throw new McpError('INVALID_ARGUMENT', 'This client is closed; create a new one.')
      return await call(parseOperationInput(name, input ?? {}), context)
    }
  }
  return client as OverleafClient
}
