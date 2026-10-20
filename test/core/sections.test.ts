import { describe, expect, test } from 'vitest'

import { findSections, replaceSection } from '../../src/core/sections.js'

const source = String.raw`% \section{Ignored}
\section[Short]{Introduction}
Intro text.
\begin{verbatim}
\section{Also ignored}
\end{verbatim}
\subsection*{Background}
Background text.
\input{details}
\section{Methods}
Methods text.
`

describe('single-file LaTeX sections', () => {
  test('parses balanced braces in long titles', () => {
    const [section] = findSections(String.raw`\section[Short]{First {Nested} Title}
Body
`)

    expect(section?.title).toBe('First {Nested} Title')
  })

  test('recognizes starred and optional-title headings outside ignored regions', () => {
    const sections = findSections(source)

    expect(sections.map(section => [section.command, section.starred, section.title])).toEqual([
      ['section', false, 'Introduction'],
      ['subsection', true, 'Background'],
      ['section', false, 'Methods'],
    ])
  })

  test('scopes a section through the next heading at the same or higher level', () => {
    const sections = findSections(source)
    expect(source.slice(sections[0]!.start, sections[0]!.end)).toContain(
      '\\subsection*{Background}'
    )
    expect(source.slice(sections[0]!.start, sections[0]!.end)).not.toContain(
      '\\section{Methods}'
    )
  })

  test('replaces a section by stable index without traversing input files', () => {
    const sectionId = findSections(source)[1]!.id
    const result = replaceSection(source, sectionId, 'New text.\n\\input{details}\n')
    expect(result).toContain('New text.')
    expect(result).toContain('\\input{details}')
    expect(result).toContain('\\section{Methods}')
  })
})

const titles = (input: string): string[] => findSections(input).map(section => section.title)

describe('comment masking', () => {
  test('treats a percent after a line-break control symbol as a comment', () => {
    const input = String.raw`\section{A}
Line break then comment \\% \section{Commented After Linebreak}
\section{B}
`
    expect(titles(input)).toEqual(['A', 'B'])
    expect(titles('\\section{A}\nx \\\\% \\section{B}')).toEqual(['A'])
  })

  test('decides an escaped percent by the parity of the backslash run', () => {
    expect(titles('x \\% \\section{B}')).toEqual(['B'])
    expect(titles('x \\\\\\% \\section{B}')).toEqual(['B'])
    expect(titles('x \\\\\\\\% \\section{B}')).toEqual([])
  })

  test('keeps a section body from ending inside a commented heading line', () => {
    const input = String.raw`\section{A}
Line break then comment \\% \section{Hidden}
\section{B}
`
    const [a] = findSections(input)
    expect(input.slice(a!.bodyStart, a!.end)).toBe(
      'Line break then comment \\\\% \\section{Hidden}\n'
    )
  })
})
