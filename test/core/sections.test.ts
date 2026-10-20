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

describe('ignored environments', () => {
  test('reads a percent inside verbatim as text, even on the line of its end', () => {
    const input = '\\section{A}\n\\begin{verbatim}50% \\end{verbatim}\n\\section{B}\n\\section{C}'
    const sections = findSections(input)

    expect(sections.map(section => section.title)).toEqual(['A', 'B', 'C'])
    expect(input.slice(sections[0]!.start, sections[0]!.end)).not.toContain('\\section{B}')
  })

  test.each(['verbatim', 'verbatim*', 'lstlisting', 'minted', 'comment'])(
    'masks headings in %s and resumes after its end despite a literal percent',
    environment => {
      const input = String.raw`\section{A}
\begin{${environment}}
100% \section{Inside}
x % \end{${environment}}
\section{B}
`
      expect(titles(input)).toEqual(['A', 'B'])
    }
  )

  test('does not open an environment from a commented or escaped begin', () => {
    expect(titles('% \\begin{verbatim}\n\\section{A}')).toEqual(['A'])
    expect(titles('\\\\begin{verbatim}\n\\section{A}')).toEqual(['A'])
  })

  test('masks an unterminated ignored environment through the end of the file', () => {
    expect(titles('\\section{A}\n\\begin{verbatim}\n\\section{B}\n')).toEqual(['A'])
  })
})

describe('inline verbatim', () => {
  test('masks a heading inside \\verb with any delimiter', () => {
    expect(titles('\\verb|\\section{V}|')).toEqual([])
    expect(titles('\\section{A}\nUse \\verb+\\section{V}+ here.\n\\section{B}')).toEqual([
      'A',
      'B',
    ])
    expect(titles('\\verb*!\\section{V}!\n\\section{B}')).toEqual(['B'])
  })

  test('reads a percent inside \\verb as text', () => {
    expect(titles('\\verb|50%| \\section{B}')).toEqual(['B'])
  })

  test('ends an unclosed \\verb at the end of its line', () => {
    expect(titles('\\verb|\\section{V}\n\\section{B}')).toEqual(['B'])
  })

  test('leaves other commands that start with verb alone', () => {
    expect(titles('\\verbatiminput{x} \\section{B}')).toEqual(['B'])
  })

  test('masks a heading inside \\lstinline with braces or a delimiter', () => {
    expect(titles('\\lstinline|\\section{V}| \\section{B}')).toEqual(['B'])
    expect(titles('\\lstinline[language=TeX]{\\section{V}} \\section{B}')).toEqual(['B'])
    expect(titles('\\lstinline{50%} \\section{B}')).toEqual(['B'])
  })
})
