/** Reports progress to a caller that asked for it; failures to deliver are ignored. */
export type ProgressReporter = (progress: number, total: number, message: string) => Promise<void>

/**
 * A notice about one operation, for logs. It carries the operation and a code, never a message,
 * path, or anything read from Overleaf.
 */
export interface OperationDiagnostic {
  tool: string
  /** An error code when the operation failed, or `DEPRECATED` when it relied on a deprecated default. */
  code: string
}

/**
 * What an interface hands an operation besides its input. Cancelling `signal` stops waiting; it
 * never aborts a write that was already submitted, so no write path receives it.
 */
export interface OperationContext {
  onProgress?: ProgressReporter | undefined
  signal?: AbortSignal | undefined
  onDiagnostic?: ((diagnostic: OperationDiagnostic) => void) | undefined
}
