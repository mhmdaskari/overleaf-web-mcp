import { rm } from 'node:fs/promises'

import { describe, expect, test } from 'vitest'

import { fakeOverleaf, history, openFakeRuntime, PROJECT, sharejs } from '../helpers/fake-overleaf.js'
import { expectGolden } from '../helpers/golden.js'

const MAIN = [
  '\\documentclass{article}',
  '\\begin{document}',
  'See \\cite{knuth} and \\Cite{lamport}.',
  '\\end{document}',
  '',
].join('\n')
const INTRO = ['\\section{Intro}', 'Prior work \\cite{knuth84}.', 'No citations here.', ''].join('\n')
const METHODS = ['\\section{Methods}', `${'x'.repeat(300)} \\cite{long} ${'y'.repeat(300)}`, ''].join('\n')

/** main.tex, and chapters/ holding intro.tex (history-OT), methods.tex, and a binary figure. */
function project() {
  const server = fakeOverleaf({ d1: sharejs(MAIN, 1), d2: history(INTRO, 1), d3: sharejs(METHODS, 1) })
  server.root = {
    _id: 'root-folder',
    name: 'rootFolder',
    docs: [{ _id: 'd1', name: 'main.tex' }],
    fileRefs: [],
    folders: [
      {
        _id: 'chapters',
        name: 'chapters',
        docs: [
          { _id: 'd3', name: 'methods.tex' },
          { _id: 'd2', name: 'intro.tex' },
        ],
        fileRefs: [{ _id: 'figure', name: 'plot.png', hash: 'a'.repeat(40) }],
        folders: [],
      },
    ],
  }
  return server
}

async function search(input: Record<string, unknown>) {
  const server = project()
  const opened = await openFakeRuntime(server)
  try {
    const result = await opened.service.search_project({
      projectId: PROJECT,
      caseSensitive: false,
      limit: 50,
      ...input,
    } as Parameters<typeof opened.service.search_project>[0])
    return { result, server }
  } finally {
    await opened.runtime.close()
    await rm(opened.directory, { recursive: true, force: true })
  }
}

describe('search_project golden results', () => {
  test('finds every match across three documents with 1-based lines and columns, binaries skipped', async () => {
    const { result, server } = await search({ query: '\\cite{' })
    expect(result.matches.map(({ filePath, line, column }) => ({ filePath, line, column }))).toEqual([
      { filePath: 'chapters/intro.tex', line: 2, column: 12 },
      { filePath: 'chapters/methods.tex', line: 2, column: 302 },
      { filePath: 'main.tex', line: 3, column: 5 },
      { filePath: 'main.tex', line: 3, column: 22 },
    ])
    expect(result).toMatchObject({ totalMatches: 4, truncated: false, filesSearched: 3, binaryFilesSkipped: 1 })
    // The long line is cut around the match, and nothing is written.
    expect(result.matches[1]!.preview).toMatch(/^…x+ \\cite\{long\} y+…$/u)
    expect(result.matches[1]!.preview).toHaveLength(162)
    expect(server.sentOps).toEqual([])
    expectGolden('search_project', result)
  })

  test('honours limit while still counting every match', async () => {
    const { result } = await search({ query: '\\cite{', limit: 2 })
    expect(result.matches).toHaveLength(2)
    expect(result).toMatchObject({ totalMatches: 4, truncated: true })
    expectGolden('search_project', result)
  })

  test('a query that matches nothing returns an empty list, not an error', async () => {
    const { result } = await search({ query: 'nowhere in the text' })
    expect(result).toEqual({ matches: [], totalMatches: 0, truncated: false, filesSearched: 3, binaryFilesSkipped: 1 })
  })

  test('matches case exactly with caseSensitive, and treats the query literally', async () => {
    const exact = await search({ query: '\\Cite{', caseSensitive: true })
    expect(exact.result.matches.map(match => [match.filePath, match.line, match.column])).toEqual([['main.tex', 3, 22]])
    // A regular-expression character is only itself: "." matches a full stop, never any character.
    const literal = await search({ query: 'here.' })
    expect(literal.result.totalMatches).toBe(1)
    expect((await search({ query: 'w.rk' })).result.totalMatches).toBe(0)
  })

  test('narrows to a folder or a document, and refuses a path that names nothing', async () => {
    const folder = await search({ query: 'section', path: 'chapters' })
    expect(folder.result).toMatchObject({ totalMatches: 2, filesSearched: 2, binaryFilesSkipped: 1 })
    const document = await search({ query: 'section', path: 'chapters/intro.tex' })
    expect(document.result).toMatchObject({ totalMatches: 1, filesSearched: 1, binaryFilesSkipped: 0 })
    expectGolden('search_project', document.result)
    await expect(search({ query: 'section', path: 'appendix' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
