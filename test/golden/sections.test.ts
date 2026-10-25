import { EventEmitter } from 'node:events'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, test } from 'vitest'

import { readConfig } from '../../src/config.js'
import type { OverleafService } from '../../src/contracts/service.js'
import { McpError } from '../../src/core/errors.js'
import type { RawFolder } from '../../src/overleaf/tree.js'
import type { HistorySnapshot } from '../../src/protocol/ot.js'
import { ProjectConnection } from '../../src/protocol/project-connection.js'
import { OverleafRuntime } from '../../src/runtime.js'
import { createOverleafService } from '../../src/service/operations.js'
import { expectGolden } from '../helpers/golden.js'
import { applyShareJs } from '../helpers/overleaf-socket.js'
import { BOOTSTRAP_PAGE, cookieJar } from '../helpers/runtime.js'

const PROJECT = 'project-id'

type ServerDocument =
  | { protocol: 'sharejs'; version: number; content: string }
  | { protocol: 'history-ot'; version: number; snapshot: HistorySnapshot }

type HistoryComponent = number | string | { i: string; tracking: unknown } | { r: number; tracking: unknown }

/** One project as Overleaf holds it: documents by id, shared by every socket the runtime opens. */
interface FakeProject {
  documents: Map<string, ServerDocument>
  root: RawFolder
  trackChanges: boolean
  /** Applies the next update, then fails its acknowledgement with TIMEOUT. */
  timeoutNextApply: boolean
  connections: number
  applied: number
}

function createProject(
  files: Record<string, { protocol: 'sharejs'; content: string } | { protocol: 'history-ot'; snapshot: HistorySnapshot }>,
  options: { trackChanges?: boolean } = {}
): FakeProject {
  const documents = new Map<string, ServerDocument>()
  const docs: RawFolder['docs'] = []
  Object.entries(files).forEach(([name, file], index) => {
    const id = `doc-${index + 1}`
    docs.push({ _id: id, name })
    documents.set(id, { ...structuredClone(file), version: 7 })
  })
  return {
    documents,
    root: { _id: 'root-folder', name: 'rootFolder', docs, fileRefs: [], folders: [] },
    trackChanges: options.trackChanges ?? false,
    timeoutNextApply: false,
    connections: 0,
    applied: 0,
  }
}

/**
 * Applies a history-OT text operation as Overleaf does to a snapshot without tracked changes: a
 * tracked insert adds text and an insert range, a tracked delete keeps the text under a delete
 * range, so only the visible content loses it.
 */
function applyHistory(snapshot: HistorySnapshot, operation: HistoryComponent[]): HistorySnapshot {
  if ((snapshot.trackedChanges ?? []).length > 0) throw new Error('fixture snapshots start without tracked changes')
  const trackedChanges: NonNullable<HistorySnapshot['trackedChanges']> = []
  let cursor = 0
  let content = ''
  for (const component of operation) {
    if (typeof component === 'number' && component >= 0) {
      content += snapshot.content.slice(cursor, cursor + component)
      cursor += component
    } else if (typeof component === 'number') {
      cursor -= component
    } else if (typeof component === 'string') {
      content += component
    } else if ('i' in component) {
      trackedChanges.push({ range: { pos: content.length, length: component.i.length }, tracking: component.tracking as never })
      content += component.i
    } else {
      trackedChanges.push({ range: { pos: content.length, length: component.r }, tracking: component.tracking as never })
      content += snapshot.content.slice(cursor, cursor + component.r)
      cursor += component.r
    }
  }
  if (cursor !== snapshot.content.length) throw new Error('operation does not span the snapshot')
  return { content, comments: snapshot.comments ?? [], trackedChanges }
}

/** A project socket that answers joinDoc, leaveDoc, and applyOtUpdate as Overleaf does. */
class FakePeer extends EventEmitter {
  closed = false

  constructor(readonly project: FakeProject) {
    super()
  }

  async call(name: string, args: unknown[]): Promise<unknown[]> {
    const docId = args[0] as string
    const document = this.project.documents.get(docId)
    if (document === undefined) return [{ message: 'not found' }]
    if (name === 'leaveDoc') return [null]
    if (name === 'joinDoc') {
      return document.protocol === 'sharejs'
        ? [null, document.content.split('\n'), document.version, null, {}, 'sharejs-text-ot']
        : [null, structuredClone(document.snapshot), document.version, null, {}, 'history-ot']
    }
    if (name === 'applyOtUpdate') {
      const update = args[1] as { v: number; op: unknown[] }
      if (update.v !== document.version) return [{ message: 'version mismatch' }]
      if (document.protocol === 'sharejs') {
        document.content = applyShareJs(document.content, update.op as Array<{ p: number; i?: string; d?: string }>)
      } else {
        const [{ textOperation }] = update.op as [{ textOperation: HistoryComponent[] }]
        document.snapshot = applyHistory(document.snapshot, textOperation)
      }
      document.version += 1
      this.project.applied += 1
      if (this.project.timeoutNextApply) {
        this.project.timeoutNextApply = false
        throw new McpError('TIMEOUT', 'Timed out waiting for the acknowledgement.')
      }
      setImmediate(() => this.emit('otUpdateApplied', { doc: docId, v: update.v }))
      return [null]
    }
    throw new Error(`unexpected socket call ${name}`)
  }

  close(): void {
    this.closed = true
  }
}

/** Runs `operation` against the service over a real runtime whose sockets reach `project`. */
async function withService<T>(project: FakeProject, operation: (service: OverleafService) => Promise<T>): Promise<T> {
  const { cookiePath, directory } = await cookieJar()
  const runtime = await OverleafRuntime.create(
    readConfig({
      OVERLEAF_COOKIE_JAR_FILE: cookiePath,
      OVERLEAF_BASE_URL: 'https://overleaf.test',
      OVERLEAF_BROWSER_PROFILE_DIR: join(directory, 'profile'),
      OVERLEAF_RECOVERY_TIMEOUT_MS: '500',
    }),
    {
      fetcher: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input))
        const method = init?.method ?? 'GET'
        if (method === 'GET' && url.pathname === '/project') return new Response(BOOTSTRAP_PAGE)
        throw new Error(`unexpected ${method} ${url.pathname}`)
      },
      connectionFactory: async projectId => {
        project.connections += 1
        return new ProjectConnection({
          projectId,
          peer: new FakePeer(project),
          join: {
            publicId: 'public-id',
            project: { _id: projectId, rootFolder: [structuredClone(project.root)], trackChangesState: project.trackChanges },
            permissionsLevel: 'owner',
            protocolVersion: 2,
          },
          supportedProtocolVersions: [2],
          currentUserId: 'user',
          callTimeoutMs: 1_000,
          applyTimeoutMs: 1_000,
        })
      },
    }
  )
  try {
    return await operation(createOverleafService(runtime))
  } finally {
    await runtime.close()
    await rm(directory, { recursive: true, force: true })
  }
}

const ARTICLE = String.raw`\documentclass{article}
\begin{document}
\part{Placeholder Part}
\chapter[Short chapter]{Placeholder Chapter}
\section{Introduction}
Introduction text.
\subsection*{Starred Background}
Background text.
\subsubsection{Detail}
\paragraph{Paragraph Heading}
Paragraph text.
\subparagraph{Subparagraph Heading}
% \section{Commented out}
\section{Empty}
\section[Short]{Long {Nested} Title}
Final text.
\end{document}
`

const SECTIONS = String.raw`\section{One}
Old body.
\section{Two}
Second body.
`

/**
 * Headings a parser can misread: an empty short title, two headings on one line, a command that
 * only starts with \section, a heading inside another heading's title, and a final heading with no
 * newline after it, which ends the document.
 */
const ADVERSARIAL = [
  String.raw`\section[]{Empty Short}`,
  'Short body.',
  String.raw`\section{A}\section{B}`,
  'B body.',
  String.raw`\sectionmark{X}`,
  String.raw`\section{Outer \section{Inner}}`,
  'Outer body.',
  String.raw`\section{Final}`,
].join('\n')

/** A history-OT snapshot whose tracked deletion hides a heading from the visible text. */
const TRACKED_DELETION: HistorySnapshot = {
  content: '\\section{Kept}\nKept body.\n\\section{Deleted}\nGone.\n\\section{After}\nAfter body.\n',
  comments: [],
  trackedChanges: [
    {
      range: { pos: 26, length: 24 },
      tracking: { type: 'delete', userId: 'user', ts: '2026-01-01T00:00:00.000Z' },
    },
  ],
}

const sectionId = async (service: OverleafService, filePath: string, title: string) => {
  const read = (await service.get_sections({ projectId: PROJECT, filePath })) as {
    sections: Array<{ id: string; title: string }>
    revision: string
  }
  const section = read.sections.find(candidate => candidate.title === title)
  if (section === undefined) throw new Error(`no section ${title}`)
  return { id: section.id, revision: read.revision }
}

describe('get_sections', () => {
  test('a ShareJS document with every heading level, starred, short-titled, and empty sections', async () => {
    const project = createProject({ 'main.tex': { protocol: 'sharejs', content: ARTICLE } })
    const result = await withService(project, async service =>
      await service.get_sections({ projectId: PROJECT, filePath: 'main.tex' })
    )
    expectGolden('get_sections', result)
  })

  test('an empty document', async () => {
    const project = createProject({ 'empty.tex': { protocol: 'sharejs', content: '' } })
    const result = await withService(project, async service =>
      await service.get_sections({ projectId: PROJECT, filePath: 'empty.tex' })
    )
    expect(result).toMatchObject({ sections: [] })
    expectGolden('get_sections', result)
  })

  test('adversarial headings', async () => {
    const project = createProject({ 'main.tex': { protocol: 'sharejs', content: ADVERSARIAL } })
    const result = (await withService(project, async service =>
      await service.get_sections({ projectId: PROJECT, filePath: 'main.tex' })
    )) as { sections: Array<{ title: string; shortTitle?: string; start: number; bodyStart: number; end: number }> }
    const { sections } = result
    // \sectionmark is not a heading, and the inner heading belongs to the outer title.
    expect(sections.map(section => section.title)).toEqual(['Empty Short', 'A', 'B', String.raw`Outer \section{Inner}`, 'Final'])
    expect(sections[0]).toHaveProperty('shortTitle', '')
    for (const section of sections) expect(section.end).toBeGreaterThanOrEqual(section.bodyStart)
    // A heading followed on its line by the next one has an empty body.
    expect(sections[1]).toMatchObject({ end: sections[2]!.start })
    expect(sections[1]!.bodyStart).toBe(sections[1]!.end)
    // The final heading ends the document, so its body is empty and ends there too.
    expect(sections[4]).toMatchObject({ bodyStart: ADVERSARIAL.length, end: ADVERSARIAL.length })
    expectGolden('get_sections', result)
  })

  test('a history-OT document whose tracked deletion hides a heading', async () => {
    const project = createProject({ 'paper.tex': { protocol: 'history-ot', snapshot: TRACKED_DELETION } })
    const result = await withService(project, async service =>
      await service.get_sections({ projectId: PROJECT, filePath: 'paper.tex' })
    )
    expect((result as { sections: Array<{ title: string }> }).sections.map(section => section.title)).toEqual([
      'Kept',
      'After',
    ])
    expectGolden('get_sections', result)
  })
})

describe('get_section_content', () => {
  test.each([
    ['a short-titled chapter holding nested sections', 'Placeholder Chapter'],
    ['a starred subsection', 'Starred Background'],
    ['a heading with an empty body', 'Empty'],
    ['the last section, through \\end{document}', 'Long {Nested} Title'],
  ])('%s', async (_label, title) => {
    const project = createProject({ 'main.tex': { protocol: 'sharejs', content: ARTICLE } })
    const result = await withService(project, async service => {
      const { id } = await sectionId(service, 'main.tex', title)
      return await service.get_section_content({ projectId: PROJECT, filePath: 'main.tex', sectionId: id })
    })
    expectGolden('get_section_content', result)
  })

  test.each([
    ['adversarial headings: an empty short title', 'Empty Short', 'Short body.\n'],
    ['adversarial headings: a final heading with no trailing newline', 'Final', ''],
  ])('%s', async (_label, title, content) => {
    const project = createProject({ 'main.tex': { protocol: 'sharejs', content: ADVERSARIAL } })
    const result = await withService(project, async service => {
      const { id } = await sectionId(service, 'main.tex', title)
      return await service.get_section_content({ projectId: PROJECT, filePath: 'main.tex', sectionId: id })
    })
    expect(result).toMatchObject({ content })
    expectGolden('get_section_content', result)
  })

  test('a history-OT document', async () => {
    const project = createProject({ 'paper.tex': { protocol: 'history-ot', snapshot: TRACKED_DELETION } })
    const result = await withService(project, async service => {
      const { id } = await sectionId(service, 'paper.tex', 'Kept')
      return await service.get_section_content({ projectId: PROJECT, filePath: 'paper.tex', sectionId: id })
    })
    expect(result).toMatchObject({ content: 'Kept body.\n' })
    expectGolden('get_section_content', result)
  })
})

describe('write_section', () => {
  const write = async (
    project: FakeProject,
    filePath: string,
    content: string,
    writeMode?: 'untracked' | 'tracked'
  ) =>
    await withService(project, async service => {
      const { id, revision } = await sectionId(service, filePath, 'One')
      const result = await service.write_section({
        projectId: PROJECT,
        filePath,
        revision,
        sectionId: id,
        content,
        ...(writeMode === undefined ? {} : { writeMode }),
      })
      return { result, revision }
    })

  const visible = (project: FakeProject, docId = 'doc-1'): string => {
    const document = project.documents.get(docId)!
    return document.protocol === 'sharejs' ? document.content : document.snapshot.content
  }

  test('an untracked ShareJS write with writeMode left out', async () => {
    const project = createProject({ 'main.tex': { protocol: 'sharejs', content: SECTIONS } })
    const { result } = await write(project, 'main.tex', 'New body.\n')
    expect(visible(project)).toBe('\\section{One}\nNew body.\n\\section{Two}\nSecond body.\n')
    expect(project.applied).toBe(1)
    expectGolden('write_section', result)
  })

  test('a tracked ShareJS write with track changes on', async () => {
    const project = createProject({ 'main.tex': { protocol: 'sharejs', content: SECTIONS } }, { trackChanges: true })
    const { result } = await write(project, 'main.tex', 'New body.\n', 'tracked')
    expect(result).toMatchObject({ protocol: 'sharejs', writeMode: 'tracked', trackChangesActive: true })
    expectGolden('write_section', result)
  })

  test('an untracked history-OT write', async () => {
    const project = createProject({
      'paper.tex': { protocol: 'history-ot', snapshot: { content: SECTIONS, comments: [], trackedChanges: [] } },
    })
    const { result } = await write(project, 'paper.tex', 'New body.\n', 'untracked')
    expect(visible(project)).toBe('\\section{One}\nNew body.\n\\section{Two}\nSecond body.\n')
    expectGolden('write_section', result)
  })

  test('a tracked history-OT write', async () => {
    const project = createProject({
      'paper.tex': { protocol: 'history-ot', snapshot: { content: SECTIONS, comments: [], trackedChanges: [] } },
    })
    const { result } = await write(project, 'paper.tex', 'New body.\n', 'tracked')
    const document = project.documents.get('doc-1')!
    expect(document.protocol === 'history-ot' && document.snapshot.trackedChanges?.map(change => change.tracking.type))
      .toEqual(['insert', 'delete'])
    expect(result).toMatchObject({ protocol: 'history-ot', writeMode: 'tracked', trackChangesActive: false })
    expectGolden('write_section', result)
  })

  test('a tracked write that changes nothing sends no update and keeps the revision', async () => {
    const project = createProject({ 'main.tex': { protocol: 'sharejs', content: SECTIONS } })
    const { result, revision } = await write(project, 'main.tex', 'Old body.\n', 'tracked')
    expect(project.applied).toBe(0)
    expect(result).toMatchObject({ revision, writeMode: 'tracked' })
    expectGolden('write_section', result)
  })

  test('a write whose acknowledgement timed out, confirmed by observation', async () => {
    const project = createProject({ 'main.tex': { protocol: 'sharejs', content: SECTIONS } })
    project.timeoutNextApply = true
    const { result } = await write(project, 'main.tex', 'New body.\n')
    // Observed on a fresh socket, never resent.
    expect(project.applied).toBe(1)
    expect(project.connections).toBe(2)
    expect(result).toMatchObject({ recoveredAfterTimeout: true })
    expectGolden('write_section', result)
  })
})
