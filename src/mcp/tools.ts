import type { OperationContext, OperationDiagnostic, ProgressReporter } from '../contracts/context.js'
import { OPERATION_NAMES, OPERATIONS, type OperationName } from '../contracts/operations.js'
import { isSignInCapable, type OverleafServiceRuntime, type SignInCapable } from '../contracts/service.js'
import type { Toolset } from '../contracts/toolsets.js'
import { asMcpError } from '../core/errors.js'
import { createOverleafService } from '../service/operations.js'
import { SIGN_IN_TOOL } from './sign-in.js'

/** The operations, in order: every tool except the MCP-only ones, and every `call` command and SDK method. */
export const TOOL_NAMES = OPERATION_NAMES

/** Tools that are not operations, so not commands or SDK methods either. */
export const MCP_ONLY_TOOLS = [SIGN_IN_TOOL.name] as const

/** Every tool `serve` can list, in order: `sign_in` follows `auth_status`, in the Account group. */
export const LISTED_TOOL_NAMES: readonly string[] = OPERATION_NAMES.flatMap(name =>
  name === 'auth_status' ? [name, SIGN_IN_TOOL.name] : [name]
)

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
      registrar.registerTool(name, config, (args, extra) => activity.track(() => handler(args, extra))),
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
  /** Registers only the tools of these groups, from `OVERLEAF_TOOLSETS`; absent registers every tool. */
  toolsets?: readonly Toolset[] | undefined
}

/** Whether `sign_in` is offered: a runtime that can sign in, the account toolset, and the `sign-in` effect. */
function offersSignIn(
  options: Pick<ToolRegistrationOptions, 'toolsets'>,
  runtime: object | undefined
): runtime is SignInCapable & { policy?: OverleafServiceRuntime['policy'] } {
  if (runtime === undefined || !isSignInCapable(runtime)) return false
  if (options.toolsets !== undefined && !options.toolsets.includes(SIGN_IN_TOOL.toolset)) return false
  const policy = (runtime as { policy?: OverleafServiceRuntime['policy'] }).policy
  return policy === undefined || SIGN_IN_TOOL.effects.every(effect => policy.allowsEffect(effect))
}

/** The tools `registerOverleafTools` registers for this runtime under these options, in order. */
export function offeredToolNames(options: Pick<ToolRegistrationOptions, 'toolsets'> = {}, runtime?: object): string[] {
  const signIn = offersSignIn(options, runtime)
  return LISTED_TOOL_NAMES.filter(name =>
    name === SIGN_IN_TOOL.name
      ? signIn
      : options.toolsets === undefined || options.toolsets.includes(OPERATIONS[name as OperationName].toolset)
  )
}

/**
 * Registers one MCP tool per operation in the contract registry. A handler parses nothing (the
 * SDK validated the input against the same schema), makes one service call, and renders the
 * result as `structuredContent`, mirrored as the JSON text block older clients read.
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
    // A tool left out is never registered, so the SDK refuses a call to it as an unknown tool.
    if (options.toolsets !== undefined && !options.toolsets.includes(contract.toolset)) continue
    const call = service[name] as (input: unknown, context: OperationContext) => Promise<unknown>
    const run = async (args: unknown, extra: ToolCallExtra | undefined): Promise<Record<string, unknown>> => {
      try {
        const value = await call(args, {
          onProgress: progressReporter(extra),
          onDiagnostic: options.onDiagnostic,
        })
        return { ...success(value), structuredContent: value }
      } catch (error) {
        return failure(error)
      }
    }
    server.registerTool(
      name,
      {
        description: contract.description,
        ...('inputSchema' in contract ? { inputSchema: contract.inputSchema } : {}),
        outputSchema: contract.outputSchema,
        annotations: contract.annotations,
      },
      // The SDK calls a tool without an input schema with its request context alone.
      'inputSchema' in contract
        ? (args: unknown, extra?: ToolCallExtra) => run(args, extra)
        : (extra?: ToolCallExtra) => run({}, extra)
    )
    if (name === 'auth_status' && offersSignIn(options, runtime)) registerSignIn(server, runtime)
  }
}

function registerSignIn(server: ToolRegistrar, runtime: SignInCapable): void {
  server.registerTool(
    SIGN_IN_TOOL.name,
    {
      description: SIGN_IN_TOOL.description,
      outputSchema: SIGN_IN_TOOL.outputSchema,
      annotations: SIGN_IN_TOOL.annotations,
    },
    async (extra?: ToolCallExtra) => {
      try {
        const value = await runtime.signIn(progressReporter(extra))
        return { ...success(value), structuredContent: value }
      } catch (error) {
        return failure(error)
      }
    }
  )
}
