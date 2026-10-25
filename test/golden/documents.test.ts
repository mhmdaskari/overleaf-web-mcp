import { writeFile } from 'node:fs/promises'
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
    { variant: 'untracked ShareJS', document: () => sharejs('Old placeholder.', 3), target: 'New placeholder.', applied: 1 },
    {
      variant: 'tracked ShareJS',
      document: () => sharejs('Old placeholder.', 3),
      target: 'New placeholder.',
      writeMode: 'tracked',
      applied: 1,
    },
    { variant: 'untracked history-OT', document: () => history('Draft sentence.', 5), target: 'Final sentence.', applied: 1 },
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
      const result = await service.write_file({ projectId: PROJECT, filePath: 'main.tex', revision: read.revision, localPath })
      expect(visible(server, 'd1')).toBe('Replacement placeholder.\n')
      expectGolden('write_file', result)
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
    const server = fakeOverleaf({ d1: history('Main.', 1) }, { trackChangesState: true, newDocumentProtocol: 'history-ot' })
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
