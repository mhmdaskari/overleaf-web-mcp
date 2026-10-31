import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { createOverleafClient, type OverleafClient } from '../../src/client.js'
import type { OperationOutput } from '../../src/contracts/operations.js'
import { asMcpError } from '../../src/core/errors.js'

/**
 * Tracked-change review against a throwaway project this test creates and trashes, through the
 * SDK client: listing, rejecting, accepting, a replacement pair on non-ASCII text, a tracked write
 * of two separated words, a comment on non-ASCII text, a comment kept through typo fixes inside it,
 * and a tracked word change inside the account's own tracked insertion. It never opens any other
 * project. New documents in a new project are ShareJS documents today, so the history-OT test runs
 * only when Overleaf created them as history-OT.
 */
const enabled =
  process.env.RUN_OVERLEAF_LIVE_TESTS === '1' && process.env.RUN_OVERLEAF_LIVE_TRACKED_REVIEW_TESTS === '1'

const TEST_TIMEOUT_MS = 120_000

type ListedDocument = OperationOutput<'list_tracked_changes'>['documents'][number]
type Protocol = ListedDocument['protocol']

/** 1-based line and UTF-16 column of the first occurrence, with an end just past it. */
function locate(content: string, text: string) {
  const lines = content.split('\n')
  for (const [index, line] of lines.entries()) {
    const column = line.indexOf(text)
    if (column >= 0) {
      return {
        start: { line: index + 1, column: column + 1 },
        end: { line: index + 1, column: column + 1 + text.length },
      }
    }
  }
  throw new Error('The anchor text is not in the document.')
}

/** A ShareJS id is the update's 18-hex `tc` seed plus a 6-hex counter; a history-OT id is made up here. */
const CHANGE_ID: Record<Protocol, RegExp> = {
  sharejs: /^[0-9a-f]{24}$/u,
  'history-ot': /^ht_[A-Za-z0-9_-]{22}$/u,
}

describe.skipIf(!enabled)('tracked-change review on a throwaway project', () => {
  const name = `mcp-tracked-review-${Date.now()}`
  const protocols = new Set<Protocol>()
  let client: OverleafClient
  let projectId: string | undefined
  let userId: string

  beforeAll(async () => {
    client = await createOverleafClient()
    const auth = await client.authStatus({})
    if (auth.userId === undefined) throw new Error('auth_status reported no userId; tracked writes need one.')
    userId = auth.userId
    projectId = (await client.createProject({ name })).projectId
  }, TEST_TIMEOUT_MS)

  afterAll(async () => {
    try {
      if (projectId !== undefined) {
        // Trash, never delete: a failed assertion must leave something a human can inspect.
        await client.manageProject({ projectId, action: 'trash', confirmName: name })
      }
    } finally {
      await client?.close()
    }
  }, TEST_TIMEOUT_MS)

  function project(): string {
    if (projectId === undefined) throw new Error('The throwaway project was not created.')
    return projectId
  }

  /** Creates `filePath` with `original`, then writes `revised` over it as tracked changes. */
  async function writeTracked(filePath: string, original: string, revised: string): Promise<void> {
    await client.createFile({ projectId: project(), filePath, content: original })
    const read = await client.readFile({ projectId: project(), filePath })
    expect(read.content).toBe(original)
    const written = await client.writeFile({
      projectId: project(),
      filePath,
      revision: read.revision,
      content: revised,
      writeMode: 'tracked',
    })
    expect(written.writeMode).toBe('tracked')
  }

  async function listDocument(filePath: string): Promise<ListedDocument> {
    const listed = await client.listTrackedChanges({ projectId: project(), filePath })
    expect(listed.documents).toHaveLength(1)
    expect(JSON.stringify(listed)).not.toContain('"email"')
    const document = listed.documents[0]!
    protocols.add(document.protocol)
    for (const change of document.changes) expect(change.changeId).toMatch(CHANGE_ID[document.protocol])
    return document
  }

  test(
    'lists a tracked insert by this account and rejects it back to the original text',
    async () => {
      const filePath = 'reject-insert.tex'
      const original = 'Alpha beta.\n'
      await writeTracked(filePath, original, 'Alpha, new, beta.\n')

      const document = await listDocument(filePath)
      expect(document.totalChanges).toBe(1)
      expect(document.changes).toEqual([
        expect.objectContaining({
          type: 'insert',
          start: { line: 1, column: 6 },
          end: { line: 1, column: 12 },
          length: 6,
          excerpt: ', new,',
          excerptTruncated: false,
          authorId: userId,
        }),
      ])
      const changeIds = document.changes.map(change => change.changeId)

      // Without confirmCount nothing is sent.
      await expect(
        client.manageTrackedChanges({
          projectId: project(),
          filePath,
          revision: document.revision,
          action: 'reject',
          changeIds,
        })
      ).rejects.toMatchObject({ code: 'CONFIRMATION_MISMATCH' })

      const rejected = await client.manageTrackedChanges({
        projectId: project(),
        filePath,
        revision: document.revision,
        action: 'reject',
        changeIds,
        confirmCount: changeIds.length,
      })
      expect(rejected).toMatchObject({ action: 'reject', remainingChangeCount: 0 })
      expect(rejected.revision).not.toBe(document.revision)
      await expect(client.readFile({ projectId: project(), filePath })).resolves.toMatchObject({ content: original })

      // The same decision again changes nothing: its revision is stale now.
      await expect(
        client.manageTrackedChanges({
          projectId: project(),
          filePath,
          revision: document.revision,
          action: 'reject',
          changeIds,
          confirmCount: changeIds.length,
        })
      ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    },
    TEST_TIMEOUT_MS
  )

  test(
    'accepts a tracked replacement in a second file, keeping the new text and emptying the listing',
    async () => {
      const filePath = 'accept.tex'
      const revised = 'New wording here.\n'
      await writeTracked(filePath, 'Old wording here.\n', revised)

      const document = await listDocument(filePath)
      expect(document.changes.map(change => [change.type, change.excerpt, change.authorId])).toEqual(
        expect.arrayContaining([
          ['insert', 'New', userId],
          ['delete', 'Old', userId],
        ])
      )
      const changeIds = document.changes.map(change => change.changeId)
      const accepted = await client.manageTrackedChanges({
        projectId: project(),
        filePath,
        revision: document.revision,
        action: 'accept',
        changeIds,
        confirmCount: changeIds.length,
      })
      expect(accepted).toMatchObject({ action: 'accept', remainingChangeCount: 0 })
      if (document.protocol === 'sharejs') {
        // Overleaf's accept route leaves the version and the text as they were.
        expect(accepted.revision).toBe(document.revision)
      } else {
        // A history-OT accept is an OT update that clears the tracking, so the version moves.
        expect(accepted.revision).not.toBe(document.revision)
      }
      await expect(client.readFile({ projectId: project(), filePath })).resolves.toMatchObject({ content: revised })
      const after = await listDocument(filePath)
      expect(after.totalChanges).toBe(0)
      expect(after.changes).toEqual([])
    },
    TEST_TIMEOUT_MS
  )

  test(
    'lists both halves of a tracked replacement on non-ASCII text as a pair and rejects them in one call',
    async () => {
      const filePath = 'replace-unicode.tex'
      const original = 'Un résumé naïf.\n'
      await writeTracked(filePath, original, 'Un aperçu naïf.\n')

      const document = await listDocument(filePath)
      const insert = document.changes.find(change => change.type === 'insert')
      const deletion = document.changes.find(change => change.type === 'delete')
      expect(insert).toMatchObject({
        start: { line: 1, column: 4 },
        end: { line: 1, column: 10 },
        excerpt: 'aperçu',
        authorId: userId,
      })
      expect(deletion).toMatchObject({ excerpt: 'résumé', length: 6, authorId: userId })
      expect(insert?.pairedChangeId).toBe(deletion?.changeId)
      expect(deletion?.pairedChangeId).toBe(insert?.changeId)

      const changeIds = [insert!.changeId, deletion!.changeId]
      const rejected = await client.manageTrackedChanges({
        projectId: project(),
        filePath,
        revision: document.revision,
        action: 'reject',
        changeIds,
        confirmCount: 2,
      })
      expect(rejected.remainingChangeCount).toBe(0)
      await expect(client.readFile({ projectId: project(), filePath })).resolves.toMatchObject({ content: original })
    },
    TEST_TIMEOUT_MS
  )

  test(
    'lists a tracked write of two separated words as two paired replacements and rejects all four',
    async () => {
      const filePath = 'granular.tex'
      const original = 'The quick brown fox jumps over the dog.\n'
      await writeTracked(filePath, original, 'The slow brown fox leaps over the dog.\n')

      const document = await listDocument(filePath)
      expect(document.totalChanges).toBe(4)
      expect(document.changes.map(change => [change.type, change.excerpt, change.authorId])).toEqual(
        expect.arrayContaining([
          ['insert', 'slow', userId],
          ['delete', 'quick', userId],
          ['insert', 'leaps', userId],
          ['delete', 'jumps', userId],
        ])
      )
      for (const insert of document.changes.filter(change => change.type === 'insert')) {
        const deletion = document.changes.find(change => change.changeId === insert.pairedChangeId)
        expect(deletion).toMatchObject({ type: 'delete', pairedChangeId: insert.changeId })
      }

      const changeIds = document.changes.map(change => change.changeId)
      const rejected = await client.manageTrackedChanges({
        projectId: project(),
        filePath,
        revision: document.revision,
        action: 'reject',
        changeIds,
        confirmCount: 4,
      })
      expect(rejected.remainingChangeCount).toBe(0)
      await expect(client.readFile({ projectId: project(), filePath })).resolves.toMatchObject({ content: original })
    },
    TEST_TIMEOUT_MS
  )

  test(
    'adds a comment on non-ASCII text, verifies it, and lists its exact range and quote',
    async () => {
      const filePath = 'comment-unicode.tex'
      const anchor = 'naïve du café'
      await client.createFile({ projectId: project(), filePath, content: `Une approche ${anchor}, résumée.\n` })
      const read = await client.readFile({ projectId: project(), filePath })
      const range = locate(read.content, anchor)

      let added: OperationOutput<'add_comment'>
      try {
        added = await client.addComment({
          projectId: project(),
          filePath,
          revision: read.revision,
          ...range,
          expectedText: anchor,
          content: 'Disposable live-test comment.',
        })
      } catch (error) {
        // 0.7.1 reported OUTCOME_UNKNOWN here: the range text came back undecoded.
        throw new Error(`add_comment failed with ${asMcpError(error).code}`)
      }
      expect(added.recoveredAfterTimeout).toBeUndefined()

      const listed = await client.listComments({ projectId: project(), filePath, status: 'all' })
      const thread = listed.threads.find(candidate => candidate.id === added.threadId)
      expect(thread).toMatchObject({ filePath, start: range.start, end: range.end, quotedText: anchor })
    },
    TEST_TIMEOUT_MS
  )

  test(
    'keeps a comment on its words through a tracked and an untracked typo fix inside them',
    async () => {
      const filePath = 'comment-typo.tex'
      // The comment runs past both typos: Overleaf never grows a comment at its end, so a fix of the
      // last letters of a comment leaves them outside it, as a single span always did.
      const anchor = 'recieve teh data'
      await client.createFile({ projectId: project(), filePath, content: `We ${anchor}.\n` })
      const read = await client.readFile({ projectId: project(), filePath })
      const added = await client.addComment({
        projectId: project(),
        filePath,
        revision: read.revision,
        ...locate(read.content, anchor),
        expectedText: anchor,
        content: 'Disposable live-test comment.',
      })
      const quoted = async (): Promise<string | undefined> => {
        const listed = await client.listComments({ projectId: project(), filePath, status: 'all' })
        return listed.threads.find(thread => thread.id === added.threadId)?.quotedText
      }

      const tracked = await client.writeFile({
        projectId: project(),
        filePath,
        revision: added.revision,
        content: 'We receive teh data.\n',
        writeMode: 'tracked',
      })
      // The fix touches the comment, so the write is the single span: only the swapped letters, and
      // the comment keeps the whole word.
      const document = await listDocument(filePath)
      expect(document.changes.map(change => [change.type, change.excerpt, change.authorId])).toEqual(
        expect.arrayContaining([
          ['insert', 'ei', userId],
          ['delete', 'ie', userId],
        ])
      )
      expect(document.totalChanges).toBe(2)
      await expect(quoted()).resolves.toBe('receive teh data')

      await client.writeFile({
        projectId: project(),
        filePath,
        revision: tracked.revision,
        content: 'We receive the data.\n',
      })
      await expect(quoted()).resolves.toBe('receive the data')
      await expect(listDocument(filePath)).resolves.toMatchObject({ totalChanges: 2 })
    },
    TEST_TIMEOUT_MS
  )

  test(
    'merges a tracked word change inside its own tracked sentence into that insertion',
    async () => {
      const filePath = 'own-insert.tex'
      const original = 'Alpha.\n'
      await writeTracked(filePath, original, 'Alpha. A new sentence here.\n')
      const first = await listDocument(filePath)
      expect(first.changes).toEqual([expect.objectContaining({ type: 'insert', excerpt: ' A new sentence here.' })])

      await client.writeFile({
        projectId: project(),
        filePath,
        revision: first.revision,
        content: 'Alpha. A fresh sentence here.\n',
        writeMode: 'tracked',
      })
      const second = await listDocument(filePath)
      expect(second.changes).toEqual([
        expect.objectContaining({ type: 'insert', excerpt: ' A fresh sentence here.', authorId: userId }),
      ])

      const changeIds = second.changes.map(change => change.changeId)
      await client.manageTrackedChanges({
        projectId: project(),
        filePath,
        revision: second.revision,
        action: 'reject',
        changeIds,
        confirmCount: changeIds.length,
      })
      await expect(client.readFile({ projectId: project(), filePath })).resolves.toMatchObject({ content: original })
    },
    TEST_TIMEOUT_MS
  )

  test(
    'accepts a tracked deletion in a history-OT document, removing the text',
    async ctx => {
      if (!protocols.has('history-ot')) {
        ctx.skip('Overleaf created every document as ShareJS; there is no history-OT document to decide on.')
      }
      const filePath = 'history-accept-delete.tex'
      const revised = 'Keep this.\n'
      await writeTracked(filePath, 'Keep this; drop that.\n', revised)
      const document = await listDocument(filePath)
      expect(document.protocol).toBe('history-ot')
      expect(document.changes).toEqual([
        expect.objectContaining({ type: 'delete', excerpt: '; drop that', authorId: userId }),
      ])
      const changeIds = document.changes.map(change => change.changeId)
      const accepted = await client.manageTrackedChanges({
        projectId: project(),
        filePath,
        revision: document.revision,
        action: 'accept',
        changeIds,
        confirmCount: changeIds.length,
      })
      expect(accepted.remainingChangeCount).toBe(0)
      expect(accepted.revision).not.toBe(document.revision)
      await expect(client.readFile({ projectId: project(), filePath })).resolves.toMatchObject({ content: revised })
    },
    TEST_TIMEOUT_MS
  )
})
