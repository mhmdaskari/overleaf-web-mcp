import { McpError } from '../core/errors.js'

/**
 * A history read or restore names its version once: by `version` or by `labelId`. Run when the
 * input is parsed and again by the service, as `assertOneTextSource` is.
 */
export function assertOneVersion(input: Record<string, unknown>): void {
  const given = ['version', 'labelId'].filter(key => input[key] !== undefined)
  if (given.length !== 1) {
    throw new McpError(
      'INVALID_ARGUMENT',
      given.length === 0 ? 'Name the version with version or labelId.' : 'Pass version or labelId, not both.',
      { details: { parameters: given } }
    )
  }
}

/** Each `manage_history` action takes its own parameters and none of the other's. */
export function assertHistoryAction(input: Record<string, unknown>): void {
  const unexpected = (keys: string[]): string[] => keys.filter(key => input[key] !== undefined)
  if (input.action === 'create_label') {
    if (typeof input.comment !== 'string') {
      throw new McpError('INVALID_ARGUMENT', 'create_label needs comment.', { details: { parameters: ['comment'] } })
    }
    const extra = unexpected(['filePath', 'version', 'labelId', 'confirmPath'])
    if (extra.length > 0) {
      throw new McpError('INVALID_ARGUMENT', `create_label takes no ${extra.join(' or ')}.`, {
        details: { parameters: extra },
      })
    }
    return
  }
  if (typeof input.filePath !== 'string') {
    throw new McpError('INVALID_ARGUMENT', 'restore_file needs filePath.', { details: { parameters: ['filePath'] } })
  }
  if (input.comment !== undefined) {
    throw new McpError('INVALID_ARGUMENT', 'restore_file takes no comment.', { details: { parameters: ['comment'] } })
  }
  assertOneVersion(input)
}
