/**
 * Socket errors from Overleaf are free text. Only the error string can carry document content or
 * ids: a comment that no longer matches quotes the document's text, and `document not found: <id>`
 * names a document. An `otUpdateError` payload holds the project and document ids, and a
 * document-updater error adds a host-derived `_id`; none of those are surfaced either. Nothing of
 * it reaches a caller: a message this release knows, matched exactly and never by prefix, maps to a
 * short identifier for `details.reason`, and anything else is `unrecognized`.
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
  // real-time's reply to an update it failed on for a reason it does not name.
  'something went wrong in real-time service': 'realtime_error',
  'null bytes found in op': 'null_bytes_in_op',
  // document-updater, broadcast as `otUpdateError` to every client joined to the document.
  'update takes doc over max doc size': 'doc_over_max_size',
  'blocking doc update: doc is too large': 'doc_too_large',
  'ranges are too large': 'ranges_too_large',
  'resulting string would be too long': 'string_too_long',
  'doc ops range is not loaded in redis': 'ops_not_loaded',
  'too many comments or tracked changes': 'too_many_ranges',
  'unrecognized op': 'unrecognized_op',
  'delete ops delete different text in the same region of the document': 'conflicting_deletes',
  'op too old': 'op_too_old',
  'op at future version': 'op_at_future_version',
  'version missing': 'version_missing',
  'delete component does not match': 'delete_mismatch',
  'invalid hash': 'invalid_hash',
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
