import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, test } from 'vitest'

import {
  fakeOverleaf,
  history,
  openFakeRuntime,
  PROJECT,
  sharejs,
  visible,
  type FakeOverleaf,
  type ServerDocument,
} from '../helpers/fake-overleaf.js'
import { expectGolden } from '../helpers/golden.js'

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

describe('read_file', () => {
  test('a ShareJS document', async () => {
    const server = fakeOverleaf({ d1: sharejs('First placeholder line.\nSecond placeholder line.', 7) })
    await withService(server, async ({ service }) => {
      expectGolden('read_file', await service.read_file({ projectId: PROJECT, filePath: 'main.tex' }))
    })
  })

  test('a history-OT document, with a tracked deletion left out of content', async () => {
    const server = fakeOverleaf({ d1: history('Kept text. Dropped text.', 12, { pos: 10, length: 14 }) })
    await withService(server, async ({ service }) => {
      const result = await service.read_file({ projectId: PROJECT, filePath: 'main.tex' })
      expect((result as { content: string }).content).toBe('Kept text.')
      expectGolden('read_file', result)
    })
  })

  test('an empty document', async () => {
    const server = fakeOverleaf({ d1: sharejs('', 0) })
    await withService(server, async ({ service }) => {
      expectGolden('read_file', await service.read_file({ projectId: PROJECT, filePath: 'main.tex' }))
    })
  })

  test('a document in a project with track changes on', async () => {
    const server = fakeOverleaf({ d1: history('Placeholder text.', 2) }, { trackChangesState: true })
    await withService(server, async ({ service }) => {
      expectGolden('read_file', await service.read_file({ projectId: PROJECT, filePath: 'main.tex' }))
    })
  })
})

describe('write_file', () => {
  const cases: Array<{
    variant: string
    document: () => ServerDocument
    target: string
    writeMode?: 'untracked' | 'tracked'
    trackChangesState?: boolean
    applied: number
  }> = [
    {
      variant: 'untracked ShareJS',
      document: () => sharejs('Old placeholder.', 3),
      target: 'New placeholder.',
      applied: 1,
    },
    {
      variant: 'tracked ShareJS',
      document: () => sharejs('Old placeholder.', 3),
      target: 'New placeholder.',
      writeMode: 'tracked',
      applied: 1,
    },
    {
      variant: 'untracked history-OT',
      document: () => history('Draft sentence.', 5),
      target: 'Final sentence.',
      applied: 1,
    },
    {
      variant: 'tracked history-OT',
      document: () => history('Draft sentence.', 5),
      target: 'Final sentence.',
      writeMode: 'tracked',
      trackChangesState: true,
      applied: 1,
    },
    { variant: 'no-op untracked', document: () => sharejs('Same text.', 4), target: 'Same text.', applied: 0 },
    {
      variant: 'no-op tracked',
      document: () => history('Same text.', 4),
      target: 'Same text.',
      writeMode: 'tracked',
      applied: 0,
    },
    { variant: 'emptying the document', document: () => sharejs('Only line.', 9), target: '', applied: 1 },
  ]

  for (const entry of cases) {
    test(entry.variant, async () => {
      const server = fakeOverleaf(
        { d1: entry.document() },
        entry.trackChangesState === undefined ? {} : { trackChangesState: entry.trackChangesState }
      )
      await withService(server, async ({ service }) => {
        const read = (await service.read_file({ projectId: PROJECT, filePath: 'main.tex' })) as { revision: string }
        const result = await service.write_file({
          projectId: PROJECT,
          filePath: 'main.tex',
          revision: read.revision,
          content: entry.target,
          ...(entry.writeMode === undefined ? {} : { writeMode: entry.writeMode }),
        })
        expect(server.applied).toBe(entry.applied)
        expect(visible(server, 'd1')).toBe(entry.target)
        expectGolden('write_file', result)
      })
    })
  }

  test('content from a local file', async () => {
    const server = fakeOverleaf({ d1: sharejs('Old placeholder.', 3) })
    await withService(server, async ({ service, directory }) => {
      const localPath = join(directory, 'replacement.tex')
      await writeFile(localPath, 'Replacement placeholder.\r\n')
      const read = (await service.read_file({ projectId: PROJECT, filePath: 'main.tex' })) as { revision: string }
      const result = await service.write_file({
        projectId: PROJECT,
        filePath: 'main.tex',
        revision: read.revision,
        localPath,
      })
      expect(visible(server, 'd1')).toBe('Replacement placeholder.\n')
      expectGolden('write_file', result)
    })
  })

  describe('edits', () => {
    const BEFORE = 'Alpha beta gamma.\nDelta epsilon, delta.\n'
    const EDITS = [
      { oldText: 'beta', newText: 'BETA' },
      // Applied to the text the first edit left; "Delta e" occurs once though "elta" occurs twice.
      { oldText: 'Delta e', newText: 'Omega e' },
    ]
    const AFTER = 'Alpha BETA gamma.\nOmega epsilon, delta.\n'
    /** The ops, with history-OT tracking timestamps left out, since each write stamps its own. */
    const ops = (server: FakeOverleaf): unknown =>
      JSON.parse(JSON.stringify(server.sentOps, (key: string, value: unknown) => (key === 'ts' ? undefined : value)))

    for (const entry of [
      { variant: 'untracked ShareJS', document: () => sharejs(BEFORE, 3) },
      { variant: 'tracked ShareJS', document: () => sharejs(BEFORE, 3), writeMode: 'tracked' as const },
      {
        variant: 'tracked history-OT',
        document: () => history(BEFORE, 5),
        writeMode: 'tracked' as const,
        trackChangesState: true,
      },
    ]) {
      test(`${entry.variant}: two edits send the update the resulting content would`, async () => {
        const write = async (source: { content: string } | { edits: typeof EDITS }) => {
          const server = fakeOverleaf(
            { d1: entry.document() },
            entry.trackChangesState === undefined ? {} : { trackChangesState: entry.trackChangesState }
          )
          let result: unknown
          await withService(server, async ({ service }) => {
            const read = (await service.read_file({ projectId: PROJECT, filePath: 'main.tex' })) as {
              revision: string
            }
            result = await service.write_file({
              projectId: PROJECT,
              filePath: 'main.tex',
              revision: read.revision,
              ...source,
              ...(entry.writeMode === undefined ? {} : { writeMode: entry.writeMode }),
            })
          })
          return { server, result }
        }
        const edited = await write({ edits: EDITS })
        const replaced = await write({ content: AFTER })
        expect(edited.server.applied).toBe(1)
        expect(ops(edited.server)).toEqual(ops(replaced.server))
        expect(visible(edited.server, 'd1')).toBe(AFTER)
        expect(edited.server.documents.get('d1')!.changes ?? []).toHaveLength(
          (replaced.server.documents.get('d1')!.changes ?? []).length
        )
        expectGolden('write_file', edited.result)
      })
    }

    test('a stale revision is REVISION_CONFLICT, and nothing is sent', async () => {
      const server = fakeOverleaf({ d1: sharejs(BEFORE, 3) })
      await withService(server, async ({ service }) => {
        const read = (await service.read_file({ projectId: PROJECT, filePath: 'main.tex' })) as { revision: string }
        await service.write_file({ projectId: PROJECT, filePath: 'main.tex', revision: read.revision, content: AFTER })
        await expect(
          service.write_file({ projectId: PROJECT, filePath: 'main.tex', revision: read.revision, edits: EDITS })
        ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
        expect(server.sentOps).toHaveLength(1)
      })
    })

    test('an oldText that matches nowhere or twice is refused by index, without document text', async () => {
      const server = fakeOverleaf({ d1: sharejs(BEFORE, 3) })
      await withService(server, async ({ service }) => {
        const read = (await service.read_file({ projectId: PROJECT, filePath: 'main.tex' })) as { revision: string }
        for (const [edits, details] of [
          [[EDITS[0]!, { oldText: 'Zeta', newText: 'z' }], { kind: 'edit_not_found', editIndex: 1 }],
          [[{ oldText: 'elta', newText: 'x' }], { kind: 'edit_ambiguous', editIndex: 0 }],
          // The first edit removes the only "beta", so the second finds none.
          [[EDITS[0]!, { oldText: 'beta', newText: 'b' }], { kind: 'edit_not_found', editIndex: 1 }],
        ] as const) {
          const error = await service
            .write_file({ projectId: PROJECT, filePath: 'main.tex', revision: read.revision, edits: [...edits] })
            .then(
              () => undefined,
              (caught: unknown) => caught as { code: string; message: string; details: unknown }
            )
          expect(error).toMatchObject({ code: 'INVALID_ARGUMENT' })
          expect(error!.details).toEqual(details)
          for (const fragment of ['Alpha', 'elta', 'Zeta', 'epsilon']) expect(error!.message).not.toContain(fragment)
        }
        expect(server.sentOps).toEqual([])
        expect(visible(server, 'd1')).toBe(BEFORE)
      })
    })

    test('edits that leave the text as it is change nothing, as an unchanged write does', async () => {
      const server = fakeOverleaf({ d1: sharejs(BEFORE, 3) })
      await withService(server, async ({ service }) => {
        const read = (await service.read_file({ projectId: PROJECT, filePath: 'main.tex' })) as { revision: string }
        const result = await service.write_file({
          projectId: PROJECT,
          filePath: 'main.tex',
          revision: read.revision,
          edits: [{ oldText: 'beta', newText: 'beta' }],
        })
        expect(result).toMatchObject({ revision: read.revision })
        expect(server.sentOps).toEqual([])
      })
    })

    test('edits with content or localPath, or no text source at all, are refused before any request', async () => {
      const server = fakeOverleaf({ d1: sharejs(BEFORE, 3) })
      await withService(server, async ({ service }) => {
        const base = { projectId: PROJECT, filePath: 'main.tex', revision: 'r' }
        for (const input of [
          { ...base, edits: EDITS, content: AFTER },
          { ...base, edits: EDITS, localPath: '/tmp/x.tex' },
          { ...base, content: AFTER, localPath: '/tmp/x.tex' },
          base,
        ]) {
          await expect(service.write_file(input)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
        }
        expect(server.requests).toEqual([])
        expect(server.sentOps).toEqual([])
      })
    })
  })

  for (const failure of ['timeout', 'lost-socket'] as const) {
    test(`recovered after a ${failure} once the update applied`, async () => {
      const server = fakeOverleaf({ d1: sharejs('Old placeholder.', 3) })
      await withService(server, async ({ service }) => {
        const read = (await service.read_file({ projectId: PROJECT, filePath: 'main.tex' })) as { revision: string }
        server.failNextApply = failure
        const result = await service.write_file({
          projectId: PROJECT,
          filePath: 'main.tex',
          revision: read.revision,
          content: 'New placeholder.',
        })
        expect(server.applied).toBe(1)
        expect(result).toMatchObject({ recoveredAfterTimeout: true })
        expectGolden('write_file', result)
      })
    })
  }
})

describe('create_file', () => {
  test('an empty document', async () => {
    const server = fakeOverleaf({ d1: sharejs('Main.', 1) })
    await withService(server, async ({ service }) => {
      const result = await service.create_file({ projectId: PROJECT, filePath: 'empty.tex' })
      expect(server.applied).toBe(0)
      expectGolden('create_file', result)
    })
  })

  test('untracked initial content on a ShareJS document', async () => {
    const server = fakeOverleaf({ d1: sharejs('Main.', 1) })
    await withService(server, async ({ service }) => {
      const result = await service.create_file({
        projectId: PROJECT,
        filePath: 'chapter.tex',
        content: 'Chapter placeholder.',
      })
      expect(visible(server, 'new-doc-1')).toBe('Chapter placeholder.')
      expectGolden('create_file', result)
    })
  })

  test('tracked initial content on a history-OT document with track changes on', async () => {
    const server = fakeOverleaf(
      { d1: history('Main.', 1) },
      { trackChangesState: true, newDocumentProtocol: 'history-ot' }
    )
    await withService(server, async ({ service }) => {
      const result = await service.create_file({
        projectId: PROJECT,
        filePath: 'chapter.tex',
        content: 'Chapter placeholder.',
        writeMode: 'tracked',
      })
      expect(visible(server, 'new-doc-1')).toBe('Chapter placeholder.')
      expectGolden('create_file', result)
    })
  })

  test('initial content recovered after a timeout', async () => {
    const server = fakeOverleaf({ d1: sharejs('Main.', 1) })
    await withService(server, async ({ service }) => {
      server.failNextApply = 'timeout'
      const result = await service.create_file({
        projectId: PROJECT,
        filePath: 'chapter.tex',
        content: 'Chapter placeholder.',
        writeMode: 'tracked',
      })
      expect(result).toMatchObject({ recoveredAfterTimeout: true })
      expectGolden('create_file', result)
    })
  })
})
