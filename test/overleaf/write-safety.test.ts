import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'vitest'

import { exitCodeForError } from '../../src/cli/exit-codes.js'
import { McpError } from '../../src/core/errors.js'
import {
  fakeOverleaf,
  history,
  openFakeRuntime,
  PROJECT,
  sharejs,
  visible,
  type FakeOverleaf,
} from '../helpers/fake-overleaf.js'

// The write-path safety checks of 0.8.0 through the real runtime over the fake Overleaf: the access
// check before sending, the otUpdateError classification, and the tracked-write fidelity check.

type Opened = Awaited<ReturnType<typeof openFakeRuntime>>

async function withService(server: FakeOverleaf, run: (opened: Opened) => Promise<void>): Promise<void> {
  const opened = await openFakeRuntime(server)
  try {
    await run(opened)
  } finally {
    await opened.runtime.close()
    await rm(opened.directory, { recursive: true, force: true })
  }
}

async function failure(promise: Promise<unknown>): Promise<McpError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught
  )
  expect(error).toBeInstanceOf(McpError)
  return error as McpError
}

/** Every applyOtUpdate any socket of the session sent. */
function applyCalls(server: FakeOverleaf): number {
  return server.peers.flatMap(peer => peer.calls).filter(name => name === 'applyOtUpdate').length
}

async function write(service: Opened['service'], content: string, writeMode?: 'tracked' | 'untracked') {
  const read = (await service.read_file({ projectId: PROJECT, filePath: 'main.tex' })) as { revision: string }
  return await service.write_file({
    projectId: PROJECT,
    filePath: 'main.tex',
    revision: read.revision,
    content,
    ...(writeMode === undefined ? {} : { writeMode }),
  })
}

describe('the access check before an OT write', () => {
  test('a review-only collaborator may write tracked, and an untracked write is refused unsent', async () => {
    const server = fakeOverleaf({ d1: sharejs('Old placeholder.', 3) })
    server.permissionsLevel = 'review'
    await withService(server, async ({ service }) => {
      const error = await failure(write(service, 'New placeholder.'))
      expect(error.toJSON()).toMatchObject({
        code: 'PERMISSION_DENIED',
        details: { accessLevel: 'review', required: 'edit' },
      })
      expect(exitCodeForError(error, 'write_file')).toBe(3)
      expect(applyCalls(server)).toBe(0)
      expect(visible(server, 'd1')).toBe('Old placeholder.')

      await expect(write(service, 'New placeholder.', 'tracked')).resolves.toMatchObject({ writeMode: 'tracked' })
      expect(visible(server, 'd1')).toBe('New placeholder.')
    })
  })

  test('a read-only collaborator cannot write tracked either', async () => {
    const server = fakeOverleaf({ d1: history('Draft sentence.', 5) })
    server.permissionsLevel = 'readOnly'
    await withService(server, async ({ service }) => {
      const error = await failure(write(service, 'Final sentence.', 'tracked'))
      expect(error).toMatchObject({
        code: 'PERMISSION_DENIED',
        details: { accessLevel: 'readOnly', required: 'review' },
      })
      expect(applyCalls(server)).toBe(0)
    })
  })
})

describe('otUpdateError', () => {
  test('too large is UPDATE_TOO_LARGE not applied after exactly one submitUpdate, with no observation', async () => {
    const server = fakeOverleaf({ d1: sharejs('Old placeholder.', 3) })
    server.failNextApply = 'too-large'
    await withService(server, async ({ service }) => {
      const error = await failure(write(service, 'New placeholder.'))
      expect(error.toJSON()).toEqual({
        code: 'UPDATE_TOO_LARGE',
        message: expect.any(String),
        retryable: false,
        details: { outcome: 'not_applied', reason: 'update_too_large' },
      })
      expect(exitCodeForError(error, 'write_file')).toBe(4)
      expect(applyCalls(server)).toBe(1)
      expect(server.applied).toBe(0)
      expect(server.documents.get('d1')).toMatchObject({ version: 3, content: 'Old placeholder.' })
      // The socket Overleaf dropped is not reused: the next call opens a fresh one and works.
      await expect(write(service, 'New placeholder.')).resolves.toMatchObject({ protocol: 'sharejs' })
      expect(server.peers.length).toBe(2)
    })
  })

  test('another error that stored nothing is observed on a fresh connection and reported not applied', async () => {
    const server = fakeOverleaf({ d1: sharejs('Old placeholder.', 3) })
    server.failNextApply = 'update-error'
    await withService(server, async ({ service }) => {
      const error = await failure(write(service, 'New placeholder.'))
      expect(error.toJSON()).toMatchObject({
        code: 'REMOTE_ERROR',
        retryable: false,
        details: { outcome: 'not_applied', reason: 'invalid_hash' },
      })
      expect(error.message).toBe('The write met an Overleaf error and the original revision is still live.')
      expect(applyCalls(server)).toBe(1)
      expect(server.peers.length).toBeGreaterThan(1)
    })
  })

  test('another error that followed the update being stored is observed and returned as recovered', async () => {
    const server = fakeOverleaf({ d1: history('Draft sentence.', 5) })
    server.failNextApply = 'applied-update-error'
    await withService(server, async ({ service }) => {
      await expect(write(service, 'Final sentence.')).resolves.toMatchObject({ recoveredAfterTimeout: true })
      expect(applyCalls(server)).toBe(1)
      expect(visible(server, 'd1')).toBe('Final sentence.')
    })
  })
})

describe('the tracked-write fidelity check', () => {
  for (const [protocol, document] of [
    ['ShareJS', () => sharejs('Old placeholder.', 3)],
    ['history-OT', () => history('Old placeholder.', 3)],
  ] as const) {
    test(`a ${protocol} tracked write recorded untracked is applied_untracked after exactly one submitUpdate`, async () => {
      const server = fakeOverleaf({ d1: document() })
      server.ignoreTracking = true
      await withService(server, async ({ service }) => {
        const error = await failure(write(service, 'New placeholder.', 'tracked'))
        expect(error.toJSON()).toEqual({
          code: 'PROTOCOL_UNSUPPORTED',
          message: expect.any(String),
          retryable: false,
          details: { kind: 'applied_untracked', liveRevision: expect.any(String) },
        })
        expect(exitCodeForError(error, 'write_file')).toBe(4)
        expect(applyCalls(server)).toBe(1)
        // It applied and is never reverted, and the revision it names is the live one.
        expect(visible(server, 'd1')).toBe('New placeholder.')
        const read = (await service.read_file({ projectId: PROJECT, filePath: 'main.tex' })) as { revision: string }
        expect(error.details?.liveRevision).toBe(read.revision)
      })
    })

    for (const failNextApply of ['applied-update-error', 'timeout'] as const) {
      test(`a ${protocol} tracked write recovered after ${failNextApply} is still checked`, async () => {
        const server = fakeOverleaf({ d1: document() })
        server.failNextApply = failNextApply
        server.ignoreTracking = true
        await withService(server, async ({ service }) => {
          const error = await failure(write(service, 'New placeholder.', 'tracked'))
          expect(error.toJSON()).toEqual({
            code: 'PROTOCOL_UNSUPPORTED',
            message: expect.any(String),
            retryable: false,
            details: { kind: 'applied_untracked', liveRevision: expect.any(String) },
          })
          expect(applyCalls(server)).toBe(1)
          expect(visible(server, 'd1')).toBe('New placeholder.')
        })
      })
    }

    test(`a ${protocol} tracked write followed by another update before the check is not called untracked`, async () => {
      const server = fakeOverleaf({ d1: document() })
      // Another client's update that keeps the text, such as accepting the new tracked changes.
      server.afterNextApply = stored => {
        stored.changes = []
        stored.marks = stored.marks.map(mark => (mark === 'insert' ? undefined : mark))
        stored.version += 1
      }
      await withService(server, async ({ service }) => {
        const error = await failure(write(service, 'New placeholder.', 'tracked'))
        expect(error.toJSON()).toEqual({
          code: 'REVISION_CONFLICT',
          message: expect.any(String),
          retryable: false,
          details: { outcome: 'unknown', liveRevision: expect.any(String) },
        })
        expect(applyCalls(server)).toBe(1)
        expect(visible(server, 'd1')).toBe('New placeholder.')
        const read = (await service.read_file({ projectId: PROJECT, filePath: 'main.tex' })) as { revision: string }
        expect(error.details?.liveRevision).toBe(read.revision)
      })
    })

    test(`a ${protocol} tracked write recorded as tracked changes passes, and so does a no-op`, async () => {
      const server = fakeOverleaf({ d1: document() })
      await withService(server, async ({ service }) => {
        await expect(write(service, 'New placeholder.', 'tracked')).resolves.toMatchObject({ writeMode: 'tracked' })
        server.ignoreTracking = true
        await expect(write(service, 'New placeholder.', 'tracked')).resolves.toMatchObject({ writeMode: 'tracked' })
        expect(applyCalls(server)).toBe(1)
      })
    })
  }

  test('an untracked write is not checked', async () => {
    const server = fakeOverleaf({ d1: sharejs('Old placeholder.', 3) })
    server.ignoreTracking = true
    await withService(server, async ({ service }) => {
      await expect(write(service, 'New placeholder.')).resolves.toMatchObject({ writeMode: 'untracked' })
    })
  })

  test('a tracked sync_directory step that applied untracked reports the kind', async () => {
    const server = fakeOverleaf({ d1: sharejs('Old placeholder.\n', 3) })
    server.ignoreTracking = true
    const folder = await mkdtemp(join(tmpdir(), 'overleaf-sync-untracked-'))
    try {
      await writeFile(join(folder, 'main.tex'), 'New placeholder.\n')
      await writeFile(join(folder, 'intro.tex'), 'Intro placeholder.\n')
      await withService(server, async ({ service }) => {
        const result = (await service.sync_directory({
          projectId: PROJECT,
          localFolderPath: folder,
          mode: 'additive',
          unplanned: true,
          writeMode: 'tracked',
        })) as { status: string; failed: unknown[] }
        expect(result.status).toBe('partial')
        expect(result.failed).toEqual([
          {
            destinationPath: 'intro.tex',
            action: 'create',
            errorCode: 'PROTOCOL_UNSUPPORTED',
            message: expect.any(String),
            details: { kind: 'applied_untracked', liveRevision: expect.any(String), created: true },
            kind: 'applied_untracked',
          },
          {
            destinationPath: 'main.tex',
            action: 'write',
            errorCode: 'PROTOCOL_UNSUPPORTED',
            message: expect.any(String),
            details: { kind: 'applied_untracked', liveRevision: expect.any(String) },
            kind: 'applied_untracked',
          },
        ])
        expect(applyCalls(server)).toBe(2)
        expect(visible(server, 'd1')).toBe('New placeholder.\n')
      })
    } finally {
      await rm(folder, { recursive: true, force: true })
    }
  })
})
