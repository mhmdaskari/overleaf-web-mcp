import { readFile } from 'node:fs/promises'

import { McpError } from './errors.js'
import { AccessPolicy } from './policy.js'

export interface TextContentSource {
  content?: string | undefined
  localPath?: string | undefined
}

/**
 * Decodes bytes as UTF-8 text the way a document write sees them, without a leading byte order
 * mark, or returns `undefined` when they are not valid UTF-8.
 */
export function decodeUtf8Text(bytes: Uint8Array): string | undefined {
  let decoded: string
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return undefined
  }
  // A leading BOM would otherwise be written into the document as a literal character.
  return decoded.startsWith('﻿') ? decoded.slice(1) : decoded
}

function decodeUtf8(bytes: Uint8Array, localPath: string): string {
  const decoded = decodeUtf8Text(bytes)
  if (decoded === undefined) {
    throw new McpError(
      'INVALID_ARGUMENT',
      `${localPath} is not valid UTF-8 text. Use upload_file for binary content.`
    )
  }
  return decoded
}

/**
 * Resolves the text a write should apply from exactly one of `content` or `localPath`.
 *
 * `localPath` exists so a whole-file replacement can stay revision-checked without routing
 * the entire file through the MCP client's tool-argument budget. Server-side document and
 * update limits are far larger than the practical argument budget, so file size alone is
 * rarely the reason to choose one over the other.
 */
export async function resolveTextContent(
  source: TextContentSource,
  policy: AccessPolicy = AccessPolicy.permissive
): Promise<string> {
  const hasContent = source.content !== undefined
  const hasLocalPath = source.localPath !== undefined && source.localPath !== ''
  if (hasContent && hasLocalPath) {
    throw new McpError(
      'INVALID_ARGUMENT',
      'Provide either content or localPath, not both.'
    )
  }
  if (!hasContent && !hasLocalPath) {
    throw new McpError('INVALID_ARGUMENT', 'Provide either content or localPath.')
  }
  if (hasContent) return source.content!
  const localPath = source.localPath!
  const readPath = await policy.resolveLocalRead(localPath)
  let bytes: Uint8Array
  try {
    bytes = await readFile(readPath)
  } catch (error) {
    throw new McpError('NOT_FOUND', `Local file could not be read: ${localPath}`, {
      cause: error,
    })
  }
  return decodeUtf8(bytes, localPath)
}
