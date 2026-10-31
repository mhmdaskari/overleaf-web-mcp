import { McpError } from '../core/errors.js'
import { contentHash } from '../core/revision.js'
import type { JoinedDocument } from '../protocol/project-connection.js'

/**
 * What one fresh observation shows after a write whose outcome is unconfirmed: the intended
 * state, the state from before the write, or a third state.
 */
export type RecoveryState = 'target' | 'original' | 'other'

export interface ObserveUnconfirmedWriteOptions<T> {
  /** One fresh observation, for example a join of the document on a new connection. */
  observe: () => Promise<T>
  /**
   * Classifies one observation. A throw is not an observation failure: it ends recovery at once
   * and reaches the caller unchanged.
   */
  classify: (observed: T) => RecoveryState | Promise<RecoveryState>
  /**
   * True for an observation error that ends recovery at once and reaches the caller unchanged,
   * such as one that would recur on every attempt. Any other observation error is retried.
   */
  rethrow?: (error: unknown) => boolean
  timeoutMs: number
  pollIntervalMs: number
  /** The error for a third state. It is thrown at the first sighting, without polling further. */
  onOther?: (observed: T) => McpError
  /** The error when the last observation of the window failed. */
  onUnobserved?: (cause: unknown) => McpError
}

export interface UnconfirmedWriteObservation<T> {
  /** `target`: the write is live. `original`: the state from before it was live to the end of the window. */
  state: 'target' | 'original'
  observed: T
}

/**
 * True for a submit error after which the update may or may not have applied: a timeout, a socket
 * lost after sending, or an `otUpdateError` other than too-large, which Overleaf can send after
 * applying the update, or for another client's update. Such a write is observed, never resent.
 */
export function isUnconfirmedWriteError(error: unknown): error is McpError {
  return error instanceof McpError && (error.code === 'TIMEOUT' || error.code === 'OUTCOME_UNKNOWN')
}

/** The known reason of an `otUpdateError` that left a write unconfirmed, for the error reporting it. */
export function refusedUpdateReason(error: unknown): string | undefined {
  if (!(error instanceof McpError) || error.details?.event !== 'otUpdateError') return undefined
  const reason = error.details.reason
  return typeof reason === 'string' ? reason : undefined
}

/** Whether a fresh join still shows the document exactly as it was before the write. */
export function isUnchangedDocument(live: JoinedDocument, before: JoinedDocument): boolean {
  return (
    live.protocol === before.protocol &&
    live.version === before.version &&
    contentHash(live.content) === contentHash(before.content)
  )
}

/**
 * The error for an unconfirmed write whose original state stayed live through the recovery
 * window: `TIMEOUT` after a timeout, otherwise `REMOTE_ERROR`, never retryable, with
 * `details.outcome: "not_applied"` after any details the caller gives.
 */
export function notAppliedError(
  submitError: unknown,
  message: string,
  details: Record<string, unknown> = {}
): McpError {
  const timedOut = submitError instanceof McpError && submitError.code === 'TIMEOUT'
  return new McpError(timedOut ? 'TIMEOUT' : 'REMOTE_ERROR', message, {
    retryable: false,
    details: { ...details, outcome: 'not_applied' },
  })
}

function defaultOther(): McpError {
  return new McpError('REVISION_CONFLICT', 'The live state changed after the unconfirmed write.', {
    retryable: false,
    details: { outcome: 'unknown' },
  })
}

function defaultUnobserved(cause: unknown): McpError {
  return new McpError('OUTCOME_UNKNOWN', 'Could not observe the live state after the unconfirmed write.', { cause })
}

/**
 * Settles a write whose outcome is unconfirmed by observing it, never by sending it again.
 *
 * Observations repeat every `pollIntervalMs` until the target state is seen or `timeoutMs` has
 * passed; there is always at least one. A failed observation is retried within the window, unless
 * `rethrow` claims its error. The result is the target state as soon as it is seen, or the
 * original state when that was the last observation of the window. A third state throws
 * `onOther` (by default `REVISION_CONFLICT` with `details.outcome: "unknown"`), and a window whose
 * last observation failed throws `onUnobserved` (by default `OUTCOME_UNKNOWN`), because the write
 * could have applied after an earlier sighting of the original state. The caller reports an
 * original result with `notAppliedError`, unless it knows the write was acknowledged.
 *
 * The caller invalidates any cached connection first, so each observation starts fresh.
 */
export async function observeUnconfirmedWrite<T>(
  options: ObserveUnconfirmedWriteOptions<T>
): Promise<UnconfirmedWriteObservation<T>> {
  const deadline = Date.now() + options.timeoutMs
  // The last observation decides: an original sighting followed by a failed observation is unobserved.
  let last: { ok: true; observed: T } | { ok: false; error: unknown } | undefined
  do {
    try {
      last = { ok: true, observed: await options.observe() }
    } catch (error) {
      if (options.rethrow?.(error)) throw error
      last = { ok: false, error }
    }
    if (last.ok) {
      const state = await options.classify(last.observed)
      if (state === 'target') return { state, observed: last.observed }
      if (state === 'other') throw (options.onOther ?? defaultOther)(last.observed)
    }
    if (Date.now() >= deadline) break
    await new Promise<void>(resolve => setTimeout(resolve, options.pollIntervalMs))
  } while (Date.now() <= deadline)

  if (last?.ok) return { state: 'original', observed: last.observed }
  throw (options.onUnobserved ?? defaultUnobserved)(last?.error)
}
