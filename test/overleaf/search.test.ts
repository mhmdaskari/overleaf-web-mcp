import { describe, expect, test, vi } from 'vitest'

import { AccessPolicy } from '../../src/core/policy.js'
import { MAX_SEARCH_DOCUMENTS, SEARCH_PREVIEW_CHARS, SearchApi } from '../../src/overleaf/search.js'
import type { ProjectEntity, ProjectTree } from '../../src/overleaf/tree.js'

function doc(path: string): ProjectEntity {
  return { id: path, name: path.split('/').at(-1)!, path, type: 'doc', parentFolderId: 'root' }
}

function searchApi(files: Record<string, string>, extra: ProjectEntity[] = [], policy?: AccessPolicy) {
  const tree: ProjectTree = {
    entities: [...Object.keys(files).map(doc), ...extra],
    trackChangesActive: false,
    hashNote: 'note',
  }
  const getProjectTree = vi.fn(async () => tree)
  const readFile = vi.fn(async (_projectId: string, filePath: string) => ({ content: files[filePath]! }))
  return { api: new SearchApi({ getProjectTree, readFile, policy }), getProjectTree, readFile }
}

describe('SearchApi', () => {
  test(`reads at most ${MAX_SEARCH_DOCUMENTS} documents, in path order, and says the result is truncated`, async () => {
    const files = Object.fromEntries(
      Array.from({ length: MAX_SEARCH_DOCUMENTS + 1 }, (_, index) => [`d${String(index).padStart(3, '0')}.tex`, 'hit'])
    )
    const { api, readFile } = searchApi(files)
    const result = await api.searchProject('p', 'hit', { limit: 500 })
    expect(readFile).toHaveBeenCalledTimes(MAX_SEARCH_DOCUMENTS)
    expect(readFile).not.toHaveBeenCalledWith('p', `d${MAX_SEARCH_DOCUMENTS}.tex`)
    expect(result).toMatchObject({
      totalMatches: MAX_SEARCH_DOCUMENTS,
      filesSearched: MAX_SEARCH_DOCUMENTS,
      truncated: true,
    })
  })

  test('checks the policy before reading anything', async () => {
    const policy = await AccessPolicy.create({ allowedProjects: ['a'] })
    const { api, getProjectTree } = searchApi({ 'main.tex': 'x' }, [], policy)
    await expect(api.searchProject('b', 'x')).rejects.toMatchObject({ code: 'POLICY_DENIED' })
    const readOnly = await AccessPolicy.create({ allowedEffects: ['local-read'] })
    await expect(searchApi({ 'main.tex': 'x' }, [], readOnly).api.searchProject('p', 'x')).rejects.toMatchObject({
      code: 'POLICY_DENIED',
      details: { effect: 'overleaf-read' },
    })
    expect(getProjectTree).not.toHaveBeenCalled()
  })

  test('refuses a query or limit out of range before reading the tree', async () => {
    const { api, getProjectTree } = searchApi({ 'main.tex': 'x' })
    for (const [query, limit] of [
      ['', 10],
      ['x'.repeat(201), 10],
      ['x', 0],
      ['x', 501],
      ['x', 1.5],
    ] as const) {
      await expect(api.searchProject('p', query, { limit })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    }
    expect(getProjectTree).not.toHaveBeenCalled()
  })

  test('counts a binary file named by path as skipped, and a folder name as a prefix only', async () => {
    const figure: ProjectEntity = { id: 'f', name: 'plot.png', path: 'fig/plot.png', type: 'file', parentFolderId: 'r' }
    const folder: ProjectEntity = { id: 'fig', name: 'fig', path: 'fig', type: 'folder', parentFolderId: 'r' }
    const { api } = searchApi({ 'figures.tex': 'x', 'fig/caption.tex': 'x' }, [figure, folder])
    expect(await api.searchProject('p', 'x', { path: 'fig/plot.png' })).toMatchObject({
      filesSearched: 0,
      binaryFilesSkipped: 1,
      totalMatches: 0,
    })
    // "fig" does not take in figures.tex, which only shares the prefix.
    expect(await api.searchProject('p', 'x', { path: 'fig' })).toMatchObject({
      filesSearched: 1,
      binaryFilesSkipped: 1,
    })
    expect(await api.searchProject('p', 'x', { path: './fig/' })).toMatchObject({ filesSearched: 1 })
    for (const path of ['..', '../fig', '/fig']) {
      await expect(api.searchProject('p', 'x', { path }), path).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    }
  })

  test('cuts a long preview without splitting a surrogate pair, and counts columns in UTF-16 units', async () => {
    const line = `${'😀'.repeat(120)}needle${'😀'.repeat(120)}`
    const { api } = searchApi({ 'main.tex': `first\n${line}` })
    const [match] = (await api.searchProject('p', 'needle')).matches
    expect(match).toMatchObject({ line: 2, column: 241 })
    const inner = match!.preview.slice(1, -1)
    expect(match!.preview.startsWith('…') && match!.preview.endsWith('…')).toBe(true)
    expect(inner).toContain('needle')
    expect(inner.length).toBeLessThanOrEqual(SEARCH_PREVIEW_CHARS)
    // No lone surrogate at either cut.
    expect(inner).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u)
  })
})
