import { McpError } from '../core/errors.js'

/**
 * `write_file` takes its new text from exactly one of `content`, `localPath`, and `edits`. Run when
 * the input is parsed, so the command line and the SDK refuse before any session is opened, and
 * again by the service, which is where an MCP call meets it.
 */
export function assertOneTextSource(input: Record<string, unknown>): void {
  const given = ['content', 'localPath', 'edits'].filter(key => input[key] !== undefined)
  if (given.length !== 1) {
    throw new McpError(
      'INVALID_ARGUMENT',
      given.length === 0
        ? 'Provide the new text through one of content, localPath, or edits.'
        : `Provide exactly one of content, localPath, or edits; got ${given.join(' and ')}. Nothing was sent.`,
      { details: { parameters: given } }
    )
  }
}
