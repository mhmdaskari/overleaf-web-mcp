import { describe, expect, test } from 'vitest'

import { compareReferences, scanBibEntries, scanLatexReferences } from '../../src/core/references.js'

const keys = (sites: Array<{ key: string }>): string[] => sites.map(site => site.key)

describe('scanLatexReferences', () => {
  test('splits key lists and skips optional arguments', () => {
    const scan = scanLatexReferences(
      'main.tex',
      String.raw`\cref{a, b ,c} \Cref[x]{d} \citep[see][p.~2]{k1,k2} \cite*{k3}`
    )
    expect(keys(scan.references)).toEqual(['a', 'b', 'c', 'd'])
    expect(keys(scan.citations)).toEqual(['k1', 'k2', 'k3'])
  })

  test('reads both keys of a range and every group of a multicite', () => {
    const scan = scanLatexReferences(
      'main.tex',
      String.raw`\crefrange{first}{last} \parencites(pre)(post)[p.~1]{k1}[2]{k2,k3}`
    )
    expect(keys(scan.references)).toEqual(['first', 'last'])
    expect(keys(scan.citations)).toEqual(['k1', 'k2', 'k3'])
  })

  test('ignores comments, verbatim text, escaped backslashes, and keys a macro builds', () => {
    const scan = scanLatexReferences(
      'main.tex',
      [
        String.raw`% \label{commented}`,
        String.raw`\verb|\ref{inline}|`,
        String.raw`\\label{text} and \newcommand{\fig}[1]{\label{fig:#1}\ref{\x}}`,
        String.raw`\label{real}`,
      ].join('\n')
    )
    expect(scan.labels).toEqual([{ key: 'real', filePath: 'main.tex', line: 4 }])
    expect(scan.references).toEqual([])
  })

  test('does not take other commands that start like a citation for one', () => {
    const scan = scanLatexReferences('main.tex', String.raw`\citestyle{plain} \citeindextrue \cites{k}`)
    expect(keys(scan.citations)).toEqual(['k'])
  })

  test('collects bibliography targets and \\nocite{*}', () => {
    const scan = scanLatexReferences(
      'main.tex',
      String.raw`\bibliography{a, sub/b}` + '\n' + String.raw`\addbibresource[location=local]{c.bib}\nocite{*}`
    )
    expect(scan.bibliographies).toEqual([
      { target: 'a', addsExtension: true, filePath: 'main.tex', line: 1 },
      { target: 'sub/b', addsExtension: true, filePath: 'main.tex', line: 1 },
      { target: 'c.bib', addsExtension: false, filePath: 'main.tex', line: 2 },
    ])
    expect(scan.citesAll).toBe(true)
    expect(scan.citations).toEqual([])
  })
})

describe('scanBibEntries', () => {
  test('lists entries with their lines and skips @string, @preamble, and @comment', () => {
    const entries = scanBibEntries(
      'refs.bib',
      '@string{x = "y"}\n@Article{ one ,\n}\n@comment{note}\n@preamble{"p"}\n@misc(two,\n)\n'
    )
    expect(entries).toEqual([
      { key: 'one', filePath: 'refs.bib', line: 2 },
      { key: 'two', filePath: 'refs.bib', line: 6 },
    ])
  })
})

describe('compareReferences', () => {
  test('caps every list and says so', () => {
    const scan = scanLatexReferences('main.tex', String.raw`\ref{a}\ref{b}\ref{c}`)
    const report = compareReferences([scan], [], 2)
    expect(keys(report.undefinedReferences)).toEqual(['a', 'b'])
    expect(report.truncated).toBe(true)
  })
})
