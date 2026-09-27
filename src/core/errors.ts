export type McpErrorCode =
  | 'AUTH_EXPIRED'
  | 'PERMISSION_DENIED'
  | 'NOT_FOUND'
  | 'REVISION_CONFLICT'
  | 'PROTOCOL_UNSUPPORTED'
  | 'UPDATE_TOO_LARGE'
  | 'DOC_TOO_LARGE'
  | 'TIMEOUT'
  | 'OUTCOME_UNKNOWN'
  | 'COMPILE_FAILED'
  | 'PARTIAL_CLEANUP'
  | 'INVALID_ARGUMENT'
  | 'CONFIRMATION_MISMATCH'
  | 'RATE_LIMITED'
  | 'REMOTE_DRIFT'
  | 'PATH_OUTSIDE_ROOT'
  | 'REMOTE_ERROR'

export const AUTH_LOGIN_INSTRUCTION =
  'Run `npx overleaf-web-mcp login` and sign in again.'

export class McpError extends Error {
  readonly code: McpErrorCode
  readonly retryable: boolean
  readonly details?: Record<string, unknown>

  constructor(
    code: McpErrorCode,
    message: string,
    options: {
      retryable?: boolean
      details?: Record<string, unknown>
      cause?: unknown
    } = {}
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'McpError'
    this.code = code
    this.retryable = options.retryable ?? false
    if (options.details !== undefined) this.details = options.details
  }

  toJSON(): Record<string, unknown> {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.details === undefined ? {} : { details: this.details }),
    }
  }
}

export function asMcpError(error: unknown): McpError {
  if (error instanceof McpError) return error
  return new McpError(
    'REMOTE_ERROR',
    error instanceof Error ? error.message : 'Unexpected Overleaf error',
    { cause: error }
  )
}
