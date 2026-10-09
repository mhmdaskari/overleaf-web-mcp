import type { OperationContext, OperationDiagnostic, ProgressReporter } from '../contracts/context.js'
import { OPERATION_NAMES, OPERATIONS } from '../contracts/operations.js'
import type { OverleafServiceRuntime } from '../contracts/service.js'
import { asMcpError } from '../core/errors.js'
import { createOverleafService } from '../service/operations.js'

/** The registered tools, in order: exactly the operations in the contract registry. */
export const TOOL_NAMES = OPERATION_NAMES

/**
 * The part of the SDK's per-request context (`ServerContext.mcpReq`) a tool uses: the progress
 * token the client sent in `_meta` and the notifier bound to this request.
 */
export interface ToolCallExtra {
  mcpReq?:
    | {
        _meta?: { progressToken?: string | number | undefined } | undefined
        notify?: (notification: {
          method: 'notifications/progress'
          params: { progressToken: string | number; progress: number; total?: number; message?: string }
        }) => Promise<void>
      }
    | undefined
}

interface ToolRegistrar {
  registerTool(
    name: string,
    config: Record<string, unknown>,
    handler: (args: any, extra?: any) => Promise<Record<string, unknown>>
  ): unknown
}

/**
 * Counts tool calls whose operation has started and not yet settled, so the stdio server can let
 * them finish against Overleaf after the client closes stdin instead of closing their sockets
 * mid-operation. The SDK has already dropped their replies by then; this protects the project,
 * not the answer.
 */
export class ToolActivity {
  #running = 0
  #idle = new Set<() => void>()

  get running(): number {
    return this.#running
  }

  async track<T>(work: () => Promise<T>): Promise<T> {
    this.#running += 1
    try {
      return await work()
    } finally {
      this.#running -= 1
      if (this.#running === 0) {
        for (const resolve of this.#idle) resolve()
        this.#idle.clear()
      }
    }
  }

  /** Resolves true once no call is running, or false when timeoutMs passes first. */
  whenIdle(timeoutMs: number): Promise<boolean> {
    if (this.#running === 0) return Promise.resolve(true)
    return new Promise(resolve => {
      const done = (): void => {
        clearTimeout(timer)
        resolve(true)
      }
      const timer = setTimeout(() => {
        this.#idle.delete(done)
        resolve(false)
      }, timeoutMs)
      this.#idle.add(done)
    })
  }
}

function trackedRegistrar(registrar: ToolRegistrar, activity: ToolActivity): ToolRegistrar {
  return {
    registerTool: (name, config, handler) =>
      registrar.registerTool(name, config, (args, extra) =>
        activity.track(() => handler(args, extra))
      ),
  }
}

function success(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  }
}

function failure(error: unknown): Record<string, unknown> {
  const normalized = asMcpError(error)
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(normalized.toJSON(), null, 2) }],
  }
}

/**
 * Sends `notifications/progress` when the client asked for them with a progress token.
 * Progress is advisory, so a notification that cannot be delivered never fails the call.
 */
function progressReporter(extra: ToolCallExtra | undefined): ProgressReporter | undefined {
  const progressToken = extra?.mcpReq?._meta?.progressToken
  const send = extra?.mcpReq?.notify
  if (progressToken === undefined || send === undefined) return undefined
  return async (progress, total, message) => {
    try {
      await send({
        method: 'notifications/progress',
        params: { progressToken, progress, total, message },
      })
    } catch {
      // The call's own result is what matters.
    }
  }
}

export interface ToolRegistrationOptions {
  /** Receives `{ tool, code }` notices; `overleaf-web-mcp serve` writes them to stderr. */
  onDiagnostic?: ((diagnostic: OperationDiagnostic) => void) | undefined
}

/**
 * Registers one MCP tool per operation in the contract registry. A handler parses nothing (the
 * SDK validated the input against the same schema), makes one service call, and renders the
 * result: as `structuredContent` plus the JSON text block older clients read when the operation
 * declares an `outputSchema`, as the text block alone otherwise.
 */
export function registerOverleafTools(
  registrar: ToolRegistrar,
  runtime: OverleafServiceRuntime,
  activity?: ToolActivity,
  options: ToolRegistrationOptions = {}
): void {
  const server = activity === undefined ? registrar : trackedRegistrar(registrar, activity)
  const service = createOverleafService(runtime)
  for (const name of OPERATION_NAMES) {
    const contract = OPERATIONS[name]
    const call = service[name] as (input: unknown, context: OperationContext) => Promise<unknown>
    const run = async (args: unknown, extra: ToolCallExtra | undefined): Promise<Record<string, unknown>> => {
      try {
        const value = await call(args, {
          onProgress: progressReporter(extra),
          onDiagnostic: options.onDiagnostic,
        })
        return 'outputSchema' in contract
          ? { ...success(value), structuredContent: value }
          : success(value)
      } catch (error) {
        return failure(error)
      }
    }
    server.registerTool(
      name,
      {
        description: contract.description,
        ...('inputSchema' in contract ? { inputSchema: contract.inputSchema } : {}),
        ...('outputSchema' in contract ? { outputSchema: contract.outputSchema } : {}),
        annotations: contract.annotations,
      },
      // The SDK calls a tool without an input schema with its request context alone.
      'inputSchema' in contract
        ? (args: unknown, extra?: ToolCallExtra) => run(args, extra)
        : (extra?: ToolCallExtra) => run({}, extra)
    )
  }
}
