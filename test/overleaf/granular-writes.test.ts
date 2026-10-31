import { rm } from 'node:fs/promises'

import { describe, expect, test } from 'vitest'

import { MAX_TRACKED_CHANGES } from '../../src/overleaf/documents.js'
import {
  fakeOverleaf,
  history,
  openFakeRuntime,
  PROJECT,
  sharejs,
  snapshotOf,
  visible,
  type FakeOverleaf,
  type ServerDocument,
  type ShareChange,
} from '../helpers/fake-overleaf.js'

// Granular writes through the real runtime over the fake Overleaf: one tracked change per changed
// word group, covered by the tracked-write check, and the fallbacks for cost and for Overleaf's
// limit on tracked changes.

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

async function write(service: Opened['service'], content: string, writeMode: 'tracked' | 'untracked' = 'tracked') {
  const read = (await service.read_file({ projectId: PROJECT, filePath: 'main.tex' })) as { revision: string }
  return await service.write_file({
    projectId: PROJECT,
    filePath: 'main.tex',
    revision: read.revision,
    content,
    writeMode,
  })
}

/** Tracked changes in the stored document, in either protocol. */
function storedChanges(document: ServerDocument): number {
  return document.protocol === 'sharejs'
    ? (document.changes ?? []).filter(change => change.metadata.user_id === 'user').length
    : (snapshotOf(document).trackedChanges ?? []).length
}

const BEFORE = 'The quick brown fox jumps over the dog.\n'
const AFTER = 'The slow brown fox leaps over the dog.\n'

describe('granular tracked writes', () => {
  for (const [protocol, document] of [
    ['ShareJS', () => sharejs(BEFORE, 3)],
    ['history-OT', () => history(BEFORE, 3)],
  ] as const) {
    test(`a ${protocol} tracked write of two separated words is two small replacements, each covered`, async () => {
      const server = fakeOverleaf({ d1: document() })
      await withService(server, async ({ service }) => {
        await expect(write(service, AFTER)).resolves.toMatchObject({ writeMode: 'tracked' })
        expect(server.applied).toBe(1)
        expect(visible(server, 'd1')).toBe(AFTER)

        const listed = await service.list_tracked_changes({ projectId: PROJECT, filePath: 'main.tex' })
        const changes = listed.documents[0]!.changes
        expect(changes.map(change => [change.type, change.excerpt])).toEqual([
          ['insert', 'slow'],
          ['delete', 'quick'],
          ['insert', 'leaps'],
          ['delete', 'jumps'],
        ])
        for (const change of changes) {
          const partner = changes.find(other => other.changeId === change.pairedChangeId)
          expect(partner?.type).toBe(change.type === 'insert' ? 'delete' : 'insert')
          expect(partner?.pairedChangeId).toBe(change.changeId)
        }
      })
    })
  }
})

// Two changed words on each of two lines with an unchanged line between: four edits word by word,
// two by runs of lines, one as a single span.
const BUDGET_BEFORE = 'first alpha and beta.\nmiddle.\nlast gamma and delta.\n'
const BUDGET_AFTER = 'first ALPHA and BETA.\nmiddle.\nlast GAMMA and DELTA.\n'

function shareJsWithChanges(existing: number): ServerDocument {
  // Another author's tracked deletes, each at its own point on a last line, out of the write's way.
  const document = sharejs(`${BUDGET_BEFORE}${'q'.repeat(existing)}\n`, 3)
  document.changes = Array.from({ length: existing }, (_, index): ShareChange => ({
    id: `${index.toString(16).padStart(24, '0')}`,
    op: { p: BUDGET_BEFORE.length + 1 + index, d: 'x' },
    metadata: { user_id: 'someone-else', ts: '2026-01-01T00:00:00.000Z' },
  }))
  return document
}

function historyWithChanges(existing: number): ServerDocument {
  // Each `a` of the last line is its own tracked insert.
  const content = `${BUDGET_BEFORE}${'ab'.repeat(existing)}\n`
  const document = history(content, 3)
  document.marks = document.marks.map((_, index) =>
    index >= BUDGET_BEFORE.length && (index - BUDGET_BEFORE.length) % 2 === 0 && index < content.length - 1
      ? 'insert'
      : undefined
  )
  return document
}

describe("a tracked write within Overleaf's limit on tracked changes", () => {
  for (const [protocol, build] of [
    ['ShareJS', shareJsWithChanges],
    ['history-OT', historyWithChanges],
  ] as const) {
    for (const [existing, added, shape] of [
      [MAX_TRACKED_CHANGES - 8, 8, 'one change per word'],
      [MAX_TRACKED_CHANGES - 7, 4, 'one edit per run of lines'],
      [MAX_TRACKED_CHANGES - 4, 4, 'one edit per run of lines'],
      [MAX_TRACKED_CHANGES - 3, 2, 'a single span'],
    ] as const) {
      test(`a ${protocol} document holding ${existing} tracked changes is written as ${shape}`, async () => {
        const server = fakeOverleaf({ d1: build(existing) })
        const baseline = storedChanges(server.documents.get('d1')!)
        const target = visible(server, 'd1').replace(BUDGET_BEFORE, BUDGET_AFTER)
        await withService(server, async ({ service }) => {
          await expect(write(service, target)).resolves.toMatchObject({ writeMode: 'tracked' })
        })
        expect(visible(server, 'd1')).toBe(target)
        expect(storedChanges(server.documents.get('d1')!) - baseline).toBe(added)
      })
    }
  }
})

describe('a tracked write on a document with characters outside the BMP near the limit', () => {
  test('counts the edits split around those characters, and sends the plan that fits', async () => {
    // Word by word, and by runs of lines, the split edits send 8 changes; one span split around
    // both emoji sends 6, which is what the write before granular edits sent.
    const before = 'a \u{1F600} b\nkeep\nc \u{1F600} d\n'
    const after = 'x \u{1F600} y\nkeep\nz \u{1F600} w\n'
    const document = sharejs(before, 3)
    document.changes = Array.from({ length: MAX_TRACKED_CHANGES - 6 }, (_, index): ShareChange => ({
      id: `${index.toString(16).padStart(24, '0')}`,
      op: { p: before.length, d: 'x' },
      metadata: { user_id: 'someone-else', ts: '2026-01-01T00:00:00.000Z' },
    }))
    const server = fakeOverleaf({ d1: document })
    await withService(server, async ({ service }) => {
      await expect(write(service, after)).resolves.toMatchObject({ writeMode: 'tracked' })
    })
    expect(visible(server, 'd1')).toBe(after)
    expect(storedChanges(server.documents.get('d1')!)).toBe(6)
  })
})

describe("another author's tracked deletion in or next to a changed word", () => {
  // "colour" with its "u" deleted reads "color"; "bar " deleted sits right before "baz".
  const BEFORE_VISIBLE = 'The color is red; foo baz.\n'
  const TARGET = 'The colors is red; foo bat.\n'
  const points = [8, 22]

  for (const writeMode of ['tracked', 'untracked'] as const) {
    test(`a ShareJS ${writeMode} write leaves both deletions to their author`, async () => {
      const document = sharejs(BEFORE_VISIBLE, 3)
      const theirs = (p: number, d: string, id: string): ShareChange => ({
        id,
        op: { p, d },
        metadata: { user_id: 'someone-else', ts: '2026-01-01T00:00:00.000Z' },
      })
      document.changes = [theirs(points[0]!, 'u', 'their-u'), theirs(points[1]!, 'bar ', 'their-bar')]
      const server = fakeOverleaf({ d1: document })
      await withService(server, async ({ service }) => {
        await expect(write(service, TARGET, writeMode)).resolves.toMatchObject({ writeMode })
      })
      expect(visible(server, 'd1')).toBe(TARGET)
      const changes = server.documents.get('d1')!.changes!
      expect(changes.filter(change => change.metadata.user_id === 'someone-else')).toEqual([
        theirs(8, 'u', 'their-u'),
        theirs(points[1]! + 1, 'bar ', 'their-bar'),
      ])
      // Only the characters that differ: "s", and "z" to "t".
      expect(changes.filter(change => change.metadata.user_id === 'user').map(change => change.op)).toEqual(
        writeMode === 'tracked'
          ? [
              { p: 9, i: 's' },
              { p: 25, i: 't' },
              { p: 26, d: 'z' },
            ]
          : []
      )
    })

    test(`a history-OT ${writeMode} write retains both deletions`, async () => {
      const content = 'The colour is red; foo bar baz.\n'
      const document = history(content, 3)
      document.marks = document.marks.map((_, index) =>
        index === 8 || (index >= 23 && index < 27) ? 'delete' : undefined
      )
      const server = fakeOverleaf({ d1: document })
      expect(visible(server, 'd1')).toBe(BEFORE_VISIBLE)
      await withService(server, async ({ service }) => {
        await expect(write(service, TARGET, writeMode)).resolves.toMatchObject({ writeMode })
      })
      expect(visible(server, 'd1')).toBe(TARGET)
      const stored = server.documents.get('d1')!
      const deletions = (snapshotOf(stored).trackedChanges ?? []).filter(change => change.tracking.type === 'delete')
      // "baz" starts at their deletion of "bar ", so the edit is cut down to "z" to "t", clear of it.
      expect(
        deletions.map(change => stored.content.slice(change.range.pos, change.range.pos + change.range.length))
      ).toEqual(writeMode === 'tracked' ? ['u', 'bar ', 'z'] : ['u', 'bar '])
    })
  }
})

describe('granular untracked writes', () => {
  const middle = BUDGET_BEFORE.indexOf('middle.')

  test("an untracked write near Overleaf's limit still edits word by word", async () => {
    for (const build of [shareJsWithChanges, historyWithChanges]) {
      const document = build(MAX_TRACKED_CHANGES - 3)
      if (document.protocol === 'sharejs') {
        document.changes!.unshift({
          id: 'kept-change',
          op: { p: middle, i: 'middle.' },
          metadata: { user_id: 'someone-else', ts: '2026-01-01T00:00:00.000Z' },
        })
      } else {
        for (let index = middle; index < middle + 7; index += 1) document.marks[index] = 'insert'
      }
      const server = fakeOverleaf({ d1: document })
      const baseline = storedChanges(server.documents.get('d1')!)
      const target = visible(server, 'd1').replace(BUDGET_BEFORE, BUDGET_AFTER)
      await withService(server, async ({ service }) => {
        await expect(write(service, target, 'untracked')).resolves.toMatchObject({ writeMode: 'untracked' })
      })
      expect(visible(server, 'd1')).toBe(target)
      const stored = server.documents.get('d1')!
      // One span from the first change to the last would have taken the change on "middle." with it.
      if (stored.protocol === 'sharejs') {
        expect(stored.changes!.find(change => change.id === 'kept-change')?.op).toEqual({ p: middle, i: 'middle.' })
      } else {
        expect(storedChanges(stored)).toBe(baseline)
        expect(stored.marks.slice(middle, middle + 7)).toEqual(Array(7).fill('insert'))
      }
    }
  })

  test('a ShareJS write leaves a tracked change on the unchanged line between its edits', async () => {
    const document = sharejs(BUDGET_BEFORE, 3)
    const kept: ShareChange = {
      id: 'kept-change',
      op: { p: middle, i: 'middle.' },
      metadata: { user_id: 'someone-else', ts: '2026-01-01T00:00:00.000Z' },
    }
    document.changes = [structuredClone(kept)]
    const server = fakeOverleaf({ d1: document })
    await withService(server, async ({ service }) => {
      await expect(write(service, BUDGET_AFTER, 'untracked')).resolves.toMatchObject({ writeMode: 'untracked' })
    })
    expect(visible(server, 'd1')).toBe(BUDGET_AFTER)
    expect(server.documents.get('d1')!.changes).toEqual([kept])
  })

  test('a history-OT write leaves a tracked range on the unchanged line between its edits', async () => {
    const document = history(BUDGET_BEFORE, 3)
    document.marks = document.marks.map((_, index) => (index >= middle && index < middle + 7 ? 'insert' : undefined))
    const server = fakeOverleaf({ d1: document })
    await withService(server, async ({ service }) => {
      await expect(write(service, BUDGET_AFTER, 'untracked')).resolves.toMatchObject({ writeMode: 'untracked' })
    })
    expect(visible(server, 'd1')).toBe(BUDGET_AFTER)
    expect(snapshotOf(server.documents.get('d1')!).trackedChanges).toEqual([
      { range: { pos: middle, length: 7 }, tracking: { type: 'insert', userId: 'user', ts: expect.any(String) } },
    ])
  })
})

describe('a write past the diff limits', () => {
  test('is one span when the line diff gives up, and still tracked and verified', async () => {
    // Every other line of 2,002 changed: an edit distance of 2,002 lines, past the limit of 2,000.
    const lines = Array.from({ length: 2_002 }, (_, index) => `line ${index} old\n`)
    const before = lines.join('')
    const after = lines.map((line, index) => (index % 2 === 0 ? line.replace('old', 'new') : line)).join('')
    const server = fakeOverleaf({ d1: sharejs(before, 3) })
    await withService(server, async ({ service }) => {
      await expect(write(service, after)).resolves.toMatchObject({ writeMode: 'tracked' })
    })
    expect(visible(server, 'd1')).toBe(after)
    expect(storedChanges(server.documents.get('d1')!)).toBe(2)
  })
})

function theirs(id: string, op: ShareChange['op']): ShareChange {
  return { id, op, metadata: { user_id: 'someone-else', ts: '2026-01-01T00:00:00.000Z' } }
}

describe("another author's tracked insertion in or around a changed word", () => {
  for (const writeMode of ['tracked', 'untracked'] as const) {
    test(`a ShareJS ${writeMode} write keeps an insertion inside the word it changes`, async () => {
      // Their "s" ends "tests"; replacing the word would cancel it.
      const document = sharejs('Run the tests now.\n', 3)
      document.changes = [theirs('their-s', { p: 12, i: 's' })]
      const server = fakeOverleaf({ d1: document })
      await withService(server, async ({ service }) => {
        await expect(write(service, 'Run the Tests now.\n', writeMode)).resolves.toMatchObject({ writeMode })
      })
      expect(visible(server, 'd1')).toBe('Run the Tests now.\n')
      const changes = server.documents.get('d1')!.changes!
      expect(changes.filter(change => change.metadata.user_id === 'someone-else')).toEqual([
        theirs('their-s', { p: 12, i: 's' }),
      ])
      expect(changes.filter(change => change.metadata.user_id === 'user').map(change => change.op)).toEqual(
        writeMode === 'tracked'
          ? [
              { p: 8, i: 'T' },
              { p: 9, d: 't' },
            ]
          : []
      )
    })

    test(`a ShareJS ${writeMode} write keeps an insertion that is the whole word it changes`, async () => {
      const document = sharejs('The cat sat.\n', 3)
      document.changes = [theirs('their-cat', { p: 4, i: 'cat' })]
      const server = fakeOverleaf({ d1: document })
      await withService(server, async ({ service }) => {
        await expect(write(service, 'The cats sat.\n', writeMode)).resolves.toMatchObject({ writeMode })
      })
      expect(visible(server, 'd1')).toBe('The cats sat.\n')
      const changes = server.documents.get('d1')!.changes!
      expect(changes.filter(change => change.metadata.user_id === 'someone-else')).toEqual([
        theirs('their-cat', { p: 4, i: 'cat' }),
      ])
      expect(changes.filter(change => change.metadata.user_id === 'user').map(change => change.op)).toEqual(
        writeMode === 'tracked' ? [{ p: 7, i: 's' }] : []
      )
    })

    test(`a history-OT ${writeMode} write keeps a tracked insertion inside the word it changes`, async () => {
      const content = 'Run the tests now.\n'
      const document = history(content, 3)
      document.marks = document.marks.map((_, index) => (index === 12 ? 'insert' : undefined))
      const server = fakeOverleaf({ d1: document })
      await withService(server, async ({ service }) => {
        await expect(write(service, 'Run the Tests now.\n', writeMode)).resolves.toMatchObject({ writeMode })
      })
      expect(visible(server, 'd1')).toBe('Run the Tests now.\n')
      const stored = server.documents.get('d1')!
      const inserted = (snapshotOf(stored).trackedChanges ?? [])
        .filter(change => change.tracking.type === 'insert')
        .map(change => stored.content.slice(change.range.pos, change.range.pos + change.range.length))
      expect(inserted).toEqual(writeMode === 'tracked' ? ['T', 's'] : ['s'])
    })
  }

  for (const writeMode of ['tracked', 'untracked'] as const) {
    test(`a history-OT ${writeMode} write keeps a tracked insertion that is the whole word it changes`, async () => {
      const document = history('The cat sat.\n', 3)
      document.marks = document.marks.map((_, index) => (index >= 4 && index < 7 ? 'insert' : undefined))
      const server = fakeOverleaf({ d1: document })
      await withService(server, async ({ service }) => {
        await expect(write(service, 'The cats sat.\n', writeMode)).resolves.toMatchObject({ writeMode })
      })
      expect(visible(server, 'd1')).toBe('The cats sat.\n')
      const stored = server.documents.get('d1')!
      // No tracked deletion of the word: only its "s" is new.
      expect(stored.content).toBe('The cats sat.\n')
      expect(stored.marks.slice(4, 7)).toEqual(['insert', 'insert', 'insert'])
      expect(stored.marks[7]).toBe(writeMode === 'tracked' ? 'insert' : undefined)
    })
  }

  test("a ShareJS tracked write keeps another author's deletion at the end of the word it changes", async () => {
    // Their deletion's point is right after "beta", which Overleaf folds into a deletion of it.
    const document = sharejs('alpha beta gamma\n', 3)
    document.changes = [theirs('their-gone', { p: 10, d: 'GONE' })]
    const server = fakeOverleaf({ d1: document })
    await withService(server, async ({ service }) => {
      await expect(write(service, 'alpha delta gamma\n')).resolves.toMatchObject({ writeMode: 'tracked' })
    })
    expect(visible(server, 'd1')).toBe('alpha delta gamma\n')
    expect(server.documents.get('d1')!.changes!.filter(change => change.metadata.user_id === 'someone-else')).toEqual([
      theirs('their-gone', { p: 11, d: 'GONE' }),
    ])
  })
})

describe('the tracked-change budget counts what is sent', () => {
  test("charges an insertion strictly inside another author's insertion, which Overleaf splits", async () => {
    // Every line is another author's insertion; "new " goes inside three of them. Word by word
    // that is 6 changes, not 3, and the document has room for 4.
    const lines = Array.from({ length: MAX_TRACKED_CHANGES - 4 }, (_, index) => `alpha${index} beta${index}\n`)
    const document = sharejs(lines.join(''), 3)
    let offset = 0
    document.changes = lines.map((line, index) => {
      const change = theirs(index.toString(16).padStart(24, '0'), { p: offset, i: line })
      offset += line.length
      return change
    })
    const server = fakeOverleaf({ d1: document })
    const target = lines.map((line, index) => ([0, 2, 4].includes(index) ? line.replace(' ', ' new ') : line)).join('')
    await withService(server, async ({ service }) => {
      await expect(write(service, target)).resolves.toMatchObject({ writeMode: 'tracked' })
    })
    expect(visible(server, 'd1')).toBe(target)
    expect(server.documents.get('d1')!.changes!.length).toBeLessThanOrEqual(MAX_TRACKED_CHANGES)
  })

  test('on history-OT, counts an edit after it is cut down at a tracked deletion', async () => {
    // "colour" with its "u" deleted reads "color". Cut down, "color" to "colors" is the insertion
    // of "s", so with "blue" to "green" the word plan adds 3 changes, which just fit.
    const first = 'The colour is red and blue.\n'
    const existing = MAX_TRACKED_CHANGES - 3
    const content = `${first}${'ab'.repeat(existing - 1)}\n`
    const document = history(content, 3)
    document.marks = document.marks.map((_, index) =>
      index === 8
        ? 'delete'
        : index >= first.length && (index - first.length) % 2 === 0 && index < content.length - 1
          ? 'insert'
          : undefined
    )
    const server = fakeOverleaf({ d1: document })
    const baseline = storedChanges(server.documents.get('d1')!)
    expect(baseline).toBe(existing)
    const target = visible(server, 'd1').replace('The color is red and blue.', 'The colors is red and green.')
    await withService(server, async ({ service }) => {
      await expect(write(service, target)).resolves.toMatchObject({ writeMode: 'tracked' })
    })
    expect(visible(server, 'd1')).toBe(target)
    const stored = server.documents.get('d1')!
    const mine = (snapshotOf(stored).trackedChanges ?? [])
      .filter(change => change.range.pos < first.length + 2)
      .map(change => [
        change.tracking.type,
        stored.content.slice(change.range.pos, change.range.pos + change.range.length),
      ])
    expect(mine).toEqual([
      ['delete', 'u'],
      ['insert', 's'],
      ['insert', 'green'],
      ['delete', 'blue'],
    ])
  })
})
