import { describe, expect, test } from 'vitest'

import { flattenProjectTree, resolveProjectPath } from '../../src/overleaf/tree.js'

const rootFolder = [
  {
    _id: 'root',
    name: 'rootFolder',
    docs: [{ _id: 'main', name: 'main.tex' }],
    fileRefs: [{ _id: 'image', name: 'plot.png', hash: 'hash' }],
    folders: [
      {
        _id: 'chapters',
        name: 'chapters',
        docs: [{ _id: 'intro', name: 'intro.tex' }],
        fileRefs: [],
        folders: [],
      },
    ],
  },
]

describe('project trees', () => {
  test('flattens document, file, and folder IDs to normalized paths', () => {
    expect(flattenProjectTree(rootFolder)).toEqual([
      expect.objectContaining({ id: 'main', path: 'main.tex', type: 'doc' }),
      expect.objectContaining({ id: 'image', path: 'plot.png', type: 'file' }),
      expect.objectContaining({ id: 'chapters', path: 'chapters', type: 'folder' }),
      expect.objectContaining({ id: 'intro', path: 'chapters/intro.tex', type: 'doc' }),
    ])
  })

  test('resolves exact paths and detects type mismatches', () => {
    const tree = flattenProjectTree(rootFolder)
    expect(resolveProjectPath(tree, 'chapters/intro.tex', 'doc').id).toBe('intro')
    expect(() => resolveProjectPath(tree, 'plot.png', 'doc')).toThrow(/not a doc/u)
    expect(() => resolveProjectPath(tree, '../main.tex')).toThrow(/invalid project path/u)
  })

  test('leaves out a hash Overleaf sent as null, so get_project_tree still matches its schema', () => {
    const tree = flattenProjectTree({
      _id: 'root',
      name: 'rootFolder',
      fileRefs: [
        { _id: 'old', name: 'old.png', hash: null as unknown as string },
        { _id: 'new', name: 'new.png', hash: 'a'.repeat(40) },
      ],
    })

    expect(tree.find(entity => entity.id === 'old')).not.toHaveProperty('hash')
    expect(tree.find(entity => entity.id === 'new')).toHaveProperty('hash', 'a'.repeat(40))
  })

  test('gives each nested folder the id of the folder that holds it', () => {
    const tree = flattenProjectTree({
      _id: 'root',
      name: 'rootFolder',
      folders: [
        {
          _id: 'outer',
          name: 'outer',
          folders: [{ _id: 'inner', name: 'inner', docs: [{ _id: 'deep', name: 'deep.tex' }] }],
        },
      ],
    })

    expect(resolveProjectPath(tree, 'outer').parentFolderId).toBe('root')
    expect(resolveProjectPath(tree, 'outer/inner').parentFolderId).toBe('outer')
    expect(resolveProjectPath(tree, 'outer/inner/deep.tex').parentFolderId).toBe('inner')
  })
})
