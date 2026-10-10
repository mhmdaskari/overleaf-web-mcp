/**
 * Socket errors from Overleaf are free text, and an `otUpdateError` can quote the update it
 * rejected, document text included. None of it reaches a caller: a message this release knows
 * maps to a short identifier for `details.reason`, and anything else is `unrecognized`.
 */
const KNOWN_REASONS: Record<string, string> = {
  'invalid session': 'invalid_session',
  retry: 'retry',
  'not authorized': 'not_authorized',
  unauthorized: 'unauthorized',
  'project not found': 'project_not_found',
  'doc not found': 'doc_not_found',
  'update is too large': 'update_too_large',
  'too many requests': 'rate_limited',
  'client not handshaken': 'not_handshaken',
}

function messageOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (value instanceof Error) return value.message
  const message = (value as { message?: unknown } | null)?.message
  return typeof message === 'string' ? message : undefined
}

export function upstreamReason(value: unknown): string {
  const message = messageOf(value)?.trim().toLowerCase()
  return (message === undefined ? undefined : KNOWN_REASONS[message]) ?? 'unrecognized'
}
