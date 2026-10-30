import { describe, expect, test, vi } from 'vitest'

import { SectionsApi } from '../../src/overleaf/sections-api.js'

describe('section tools API', () => {
  test('returns single-file section metadata and writes through the document revision', async () => {
    const documents = {
      readFile: vi.fn(async () => ({
        content: '\\section{One}\nOld\n\\section{Two}\nNext\n',
        revision: 'revision',
        newline: 'LF' as const,
        protocol: 'sharejs' as const,
        trackChangesActive: false,
      })),
      writeFile: vi.fn(async () => ({
        revision: 'new-revision',
        protocol: 'sharejs' as const,
        trackChangesActive: false,
        writeMode: 'untracked' as const,
      })),
    }
    const api = new SectionsApi(documents)
    const sections = await api.getSections('project', 'main.tex')

    expect(sections.sections).toHaveLength(2)
    await api.writeSection('project', 'main.tex', 'revision', sections.sections[0]!.id, 'Replacement\n', 'tracked')
    expect(documents.writeFile).toHaveBeenCalledWith(
      'project',
      'main.tex',
      'revision',
      '\\section{One}\nReplacement\n\\section{Two}\nNext\n',
      'tracked'
    )
  })

  test('does not turn a heading commented out after a line break into a live one', async () => {
    const content = String.raw`\section{Edge}
Line break then comment \\% \section{Commented After Linebreak}
\section{Next}
`
    const documents = {
      readFile: vi.fn(async () => ({
        content,
        revision: 'revision',
        newline: 'LF' as const,
        protocol: 'sharejs' as const,
        trackChangesActive: false,
      })),
      writeFile: vi.fn(async () => ({
        revision: 'new-revision',
        protocol: 'sharejs' as const,
        trackChangesActive: false,
        writeMode: 'untracked' as const,
      })),
    }
    const api = new SectionsApi(documents)
    const { sections } = await api.getSections('project', 'main.tex')
    expect(sections.map(section => section.title)).toEqual(['Edge', 'Next'])

    await api.writeSection('project', 'main.tex', 'revision', sections[0]!.id, 'New body.\n')
    expect(documents.writeFile).toHaveBeenCalledWith(
      'project',
      'main.tex',
      'revision',
      '\\section{Edge}\nNew body.\n\\section{Next}\n',
      'untracked'
    )
  })
})
