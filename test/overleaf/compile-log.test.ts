import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, test } from 'vitest'

import {
  MAX_LOG_ENTRIES,
  MAX_MESSAGE_LENGTH,
  isBibtexErrorLine,
  isLatexErrorLine,
  mergeLogSummaries,
  parseBibtexLog,
  parseLatexLog,
} from '../../src/overleaf/compile-log.js'

const fixture = async (name: string): Promise<string> =>
  await readFile(join(import.meta.dirname, '..', 'fixtures', 'compile', name), 'utf8')

describe('LaTeX log parser', () => {
  test('a clean build has no errors and reports its pages and size', async () => {
    const summary = parseLatexLog(await fixture('clean.log'))
    expect(summary).toMatchObject({
      errorCount: 0,
      warningCount: 0,
      errors: [],
      undefinedReferences: [],
      undefinedCitations: [],
      missingFiles: [],
      pageCount: 3,
      pdfSizeBytes: 45678,
    })
  })

  test('finds errors a nonstopmode build reports alongside a PDF, with file and line', async () => {
    const summary = parseLatexLog(await fixture('nonstop-errors.log'))
    expect(summary.errorCount).toBe(2)
    expect(summary.errors).toEqual([
      { file: 'main.tex', line: 5, message: 'Undefined control sequence.' },
      { file: 'sections/intro.tex', line: 12, message: "LaTeX Error: File `missing-figure.png' not found." },
    ])
    expect(summary.missingFiles).toEqual(['missing-figure.png'])
    expect(summary.undefinedReferences).toEqual(['fig:overview'])
    expect(summary.undefinedCitations).toEqual(['knuth84'])
    expect(summary.warnings).toContainEqual({
      line: 14,
      message:
        "Package hyperref Warning: Token not allowed in a PDF string (Unicode): removing `math shift' on input line 14.",
    })
    expect(summary.warnings).toContainEqual({ message: 'There were undefined references.' })
    // Box warnings are typesetting notes, not problems to report.
    expect(summary.warnings.some(warning => warning.message.includes('Overfull'))).toBe(false)
    expect(summary).toMatchObject({ pageCount: 1, pdfSizeBytes: 23456 })
  })

  test('reads the classic form, taking the line from l.<n> and never its excerpt', async () => {
    const text = await fixture('classic-errors.log')
    const summary = parseLatexLog(text)
    expect(summary.errors).toEqual([
      { line: 3, message: 'Undefined control sequence.' },
      { line: 8, message: 'LaTeX Error: Environment theorem undefined.' },
      { message: 'Emergency stop.' },
    ])
    expect(summary.pageCount).toBe(0)
    expect(JSON.stringify(summary)).not.toContain('\\undefined')
    expect(JSON.stringify(summary)).not.toContain('\\begin{theorem}')
  })

  test('bounds 500 wrapped errors to 20 entries of at most 240 characters, counting all', async () => {
    const summary = parseLatexLog(await fixture('many-errors.log'))
    expect(summary.errorCount).toBe(500)
    expect(summary.errors).toHaveLength(MAX_LOG_ENTRIES)
    expect(summary.errors[0]).toMatchObject({ file: 'main.tex', line: 1 })
    // TeX's 79-column wrapping is undone before the message is cut.
    expect(summary.errors[0]!.message).toMatch(
      /^Package example Error: generated error number 1, with a long explanation with/u
    )
    for (const error of summary.errors) {
      expect(error.message.length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH)
      expect(error.message).not.toMatch(/^l\.\d+ /u)
    }
    expect(summary.pageCount).toBe(2)
  })

  test('lists each undefined name once', () => {
    const line = "LaTeX Warning: Citation `a' on page 1 undefined on input line 3."
    const summary = parseLatexLog([line, '', line, ''].join('\n'))
    expect(summary.warningCount).toBe(2)
    expect(summary.undefinedCitations).toEqual(['a'])
  })

  test('recognizes error lines in both forms', () => {
    expect(isLatexErrorLine('! Undefined control sequence.')).toBe(true)
    expect(isLatexErrorLine('./main.tex:5: Undefined control sequence.')).toBe(true)
    expect(isLatexErrorLine('LaTeX Warning: There were undefined references.')).toBe(false)
    expect(isLatexErrorLine('Output written on output.pdf (1 page, 2 bytes).')).toBe(false)
  })
})

describe('BibTeX log parser', () => {
  test('reports a missing database and the entries it could not find', async () => {
    const latex = parseLatexLog(await fixture('missing-bib.log'))
    const bibtex = parseBibtexLog(await fixture('missing-bib.blg'))
    expect(bibtex.errorCount).toBe(1)
    expect(bibtex.errors).toEqual([{ message: "BibTeX: I couldn't open database file refs.bib" }])
    expect(bibtex.missingFiles).toEqual(['refs.bib'])
    expect(bibtex.undefinedCitations).toEqual(['knuth84', 'lamport94'])
    expect(bibtex.warningCount).toBe(2)

    const merged = mergeLogSummaries(latex, bibtex)
    expect(merged).toMatchObject({
      errorCount: 1,
      missingFiles: ['refs.bib'],
      undefinedCitations: ['knuth84', 'lamport94'],
      pageCount: 1,
      pdfSizeBytes: 12345,
    })
  })

  test('reads Biber logs', async () => {
    const summary = parseBibtexLog(await fixture('biber.blg'))
    expect(summary.errorCount).toBe(1)
    expect(summary.missingFiles).toEqual(['refs.bib'])
    expect(summary.undefinedCitations).toEqual(['knuth84'])
    expect(summary.warnings).toEqual([{ message: "Biber: I didn't find a database entry for 'knuth84' (section 0)" }])
  })

  test('locates errors in a .bib file and skips pointers into generated files', () => {
    const summary = parseBibtexLog(
      ["I was expecting a `,' or a `}'---line 5 of file refs.bib", '---line 3 of file output.aux'].join('\n')
    )
    expect(summary.errors).toEqual([{ file: 'refs.bib', line: 5, message: "BibTeX: I was expecting a `,' or a `}'" }])
    expect(isBibtexErrorLine("I couldn't open database file refs.bib")).toBe(true)
    expect(isBibtexErrorLine('---line 3 of file output.aux')).toBe(false)
    expect(isBibtexErrorLine('[1] Utils.pm:411> ERROR - Cannot find x')).toBe(true)
  })
})
