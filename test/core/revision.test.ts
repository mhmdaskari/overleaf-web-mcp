import { describe, expect, test } from 'vitest'

import { createRevision, decodeRevision, validateRevision } from '../../src/core/revision.js'

describe('opaque revisions', () => {
  test('round-trips project, document, protocol, version, and content hash', () => {
    const revision = createRevision({
      projectId: 'project-1',
      docId: 'doc-1',
      protocol: 'sharejs',
      otVersion: 12,
      content: 'hello',
    })

    expect(decodeRevision(revision)).toMatchObject({
      tokenVersion: 1,
      projectId: 'project-1',
      docId: 'doc-1',
      protocol: 'sharejs',
      otVersion: 12,
    })
  })

  test('rejects stale content and protocol migration', () => {
    const revision = createRevision({
      projectId: 'p',
      docId: 'd',
      protocol: 'sharejs',
      otVersion: 2,
      content: 'before',
    })

    expect(() =>
      validateRevision(revision, {
        projectId: 'p',
        docId: 'd',
        protocol: 'history-ot',
        otVersion: 2,
        content: 'before',
      })
    ).toThrowError(expect.objectContaining({ code: 'PROTOCOL_UNSUPPORTED' }))

    expect(() =>
      validateRevision(revision, {
        projectId: 'p',
        docId: 'd',
        protocol: 'sharejs',
        otVersion: 2,
        content: 'after',
      })
    ).toThrowError(expect.objectContaining({ code: 'REVISION_CONFLICT' }))
  })
})
