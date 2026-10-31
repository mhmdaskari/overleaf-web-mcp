import { readConfig, type AppConfig } from './config.js'
import type { OperationContext } from './contracts/context.js'
import {
  OPERATION_NAMES,
  type OperationInput,
  type OperationName,
  type OperationOutput,
} from './contracts/operations.js'
import { parseOperationInput } from './contracts/parse.js'
import { asMcpError, McpError } from './core/errors.js'
import { OverleafRuntime, type RuntimeDependencies } from './runtime.js'
import { createOverleafService } from './service/operations.js'

/** `read_file` → `readFile`. */
export type CamelCase<S extends string> = S extends `${infer Head}_${infer Tail}`
  ? `${Head}${Capitalize<CamelCase<Tail>>}`
  : S

/** One operation as a client method: one whose parameters are all optional may be called with none. */
export type OperationMethod<N extends OperationName> =
  Record<string, never> extends OperationInput<N>
    ? (input?: OperationInput<N>, context?: OperationContext) => Promise<OperationOutput<N>>
    : (input: OperationInput<N>, context?: OperationContext) => Promise<OperationOutput<N>>

/**
 * Every operation as a camelCase method (`readFile`, `syncDirectory`), plus `close()`. A method
 * resolves with the operation's result, the object the MCP server returns as `structuredContent`,
 * and rejects with `McpError` and the same codes.
 */
export type OverleafClient = { readonly [N in OperationName as CamelCase<N>]: OperationMethod<N> } & {
  /**
   * Waits for calls still running, then closes the project sockets the client opened. A method
   * called once `close()` has been called is refused with `INVALID_ARGUMENT`.
   */
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
  let runtime: OverleafRuntime
  try {
    runtime = await OverleafRuntime.create(options.config ?? readConfig(), options.dependencies)
  } catch (error) {
    // Opening fails the way a method does: an unreadable cookie jar surfaces from Node as a plain Error.
    throw asMcpError(error)
  }
  const service = createOverleafService(runtime)
  const running = new Set<Promise<unknown>>()
  let closing: Promise<void> | undefined
  const client: Record<string, unknown> = {
    close: async () => {
      // Calls still running finish first: closing a socket under a submitted write would force a
      // recovery, and the recovery's fresh socket would outlive the close.
      closing ??= Promise.allSettled(running).then(async () => {
        try {
          await runtime.close()
        } catch (error) {
          throw asMcpError(error)
        }
      })
      await closing
    },
  }
  for (const name of OPERATION_NAMES) {
    const call = service[name] as (input: unknown, context?: OperationContext) => Promise<unknown>
    client[camelCase(name)] = async (input?: unknown, context?: OperationContext) => {
      if (closing !== undefined) throw new McpError('INVALID_ARGUMENT', 'This client is closed; create a new one.')
      // Only a missing input means none; null is refused like any other value that is not an object.
      const pending = call(parseOperationInput(name, input === undefined ? {} : input), context)
      running.add(pending)
      try {
        return await pending
      } finally {
        running.delete(pending)
      }
    }
  }
  return Object.freeze(client) as OverleafClient
}
