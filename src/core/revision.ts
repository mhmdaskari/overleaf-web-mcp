import { createHash } from 'node:crypto'

import { McpError } from './errors.js'

export type OtProtocol = 'sharejs' | 'history-ot'

export interface RevisionSource {
  projectId: string
  docId: string
  protocol: OtProtocol
  otVersion: number
  content: string
}

export interface RevisionPayload {
  format: 1
  tokenVersion: 1
  projectId: string
  docId: string
  protocol: OtProtocol
  otVersion: number
  sha256: string
}

export function contentHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

/**
 * Encodes document identity and state for optimistic concurrency checks.
 * Revisions are opaque to callers but are not secrets or authentication credentials.
 */
export function createRevision(source: RevisionSource): string {
  const payload: RevisionPayload = {
    format: 1,
    tokenVersion: 1,
    projectId: source.projectId,
    docId: source.docId,
    protocol: source.protocol,
    otVersion: source.otVersion,
    sha256: contentHash(source.content),
  }
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

export function decodeRevision(token: string): RevisionPayload {
  try {
    const payload = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as Partial<RevisionPayload>
    if (
      payload.format !== 1 ||
      payload.tokenVersion !== 1 ||
      typeof payload.projectId !== 'string' ||
      typeof payload.docId !== 'string' ||
      (payload.protocol !== 'sharejs' && payload.protocol !== 'history-ot') ||
      !Number.isInteger(payload.otVersion) ||
      typeof payload.sha256 !== 'string'
    ) {
      throw new Error('invalid fields')
    }
    return payload as RevisionPayload
  } catch (error) {
    throw new McpError('INVALID_ARGUMENT', 'Revision token is invalid.', { cause: error })
  }
}

export function assertRevisionMatches(token: string, live: RevisionSource): RevisionPayload {
  const revision = decodeRevision(token)
  if (revision.projectId !== live.projectId || revision.docId !== live.docId) {
    throw new McpError('REVISION_CONFLICT', 'Revision belongs to a different document.')
  }
  if (revision.protocol !== live.protocol) {
    // A protocol migration changes operation encoding even when text and version still appear valid.
    throw new McpError(
      'PROTOCOL_UNSUPPORTED',
      'The document OT protocol changed. Read the file again before writing.',
      { details: { expectedProtocol: revision.protocol, actualProtocol: live.protocol } }
    )
  }
  const liveHash = contentHash(live.content)
  if (revision.otVersion !== live.otVersion || revision.sha256 !== liveHash) {
    throw new McpError('REVISION_CONFLICT', 'The document changed. Read it again and retry with the new revision.', {
      details: {
        expectedVersion: revision.otVersion,
        actualVersion: live.otVersion,
        liveRevision: createRevision(live),
      },
    })
  }
  return revision
}

export const validateRevision = assertRevisionMatches
