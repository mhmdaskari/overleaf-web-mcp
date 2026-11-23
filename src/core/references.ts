import { backslashesBefore, maskIgnored, readBalanced, skipWhitespace } from './sections.js'

/** The most entries each list of a reference check returns; `truncated` says when one was cut. */
export const MAX_REFERENCE_FINDINGS = 500

/** One place a key is defined or used: the file and its 1-based line. */
export interface ReferenceSite {
  key: string
  filePath: string
  line: number
}

/** A bibliography file a document names, with where it is named. */
export interface BibliographyTarget {
  target: string
  /** `\bibliography` names files without `.bib`; `\addbibresource` names them in full. */
  addsExtension: boolean
  filePath: string
  line: number
}

/** What one LaTeX file defines, uses, and names. */
export interface LatexReferenceScan {
  labels: ReferenceSite[]
  references: ReferenceSite[]
  citations: ReferenceSite[]
  bibliographies: BibliographyTarget[]
  /** `\nocite{*}` cites every entry of the bibliography. */
  citesAll: boolean
}

export interface ReferenceReport {
  undefinedReferences: ReferenceSite[]
  undefinedCitations: ReferenceSite[]
  unusedLabels: ReferenceSite[]
  unusedBibEntries: ReferenceSite[]
  duplicateLabels: ReferenceSite[]
  truncated: boolean
}

const REFERENCE_COMMANDS = new Set([
  'ref',
  'eqref',
  'pageref',
  'autoref',
  'Autoref',
  'nameref',
  'Nameref',
  'cref',
  'Cref',
  'cpageref',
  'Cpageref',
  'labelcref',
  'namecref',
  'nameCref',
  'vref',
  'Vref',
  'vpageref',
  'subref',
])

/** Commands that take two keys, a first and a last, as two arguments. */
const REFERENCE_RANGE_COMMANDS = new Set(['crefrange', 'Crefrange', 'cpagerefrange', 'Cpagerefrange', 'vrefrange'])

/** natbib's and biblatex's citation commands that take one list of keys; a starred form counts too. */
const CITATION_COMMANDS = new Set([
  'cite',
  'Cite',
  'citep',
  'Citep',
  'citet',
  'Citet',
  'citealp',
  'Citealp',
  'citealt',
  'Citealt',
  'citeauthor',
  'Citeauthor',
  'citeyear',
  'citeyearpar',
  'citenum',
  'citetitle',
  'Citetitle',
  'citeurl',
  'citedate',
  'parencite',
  'Parencite',
  'textcite',
  'Textcite',
  'autocite',
  'Autocite',
  'footcite',
  'Footcite',
  'footcitetext',
  'smartcite',
  'Smartcite',
  'supercite',
  'fullcite',
  'footfullcite',
  'nocite',
])

/** biblatex's multicite commands, which repeat `[pre][post]{keys}` groups. */
const MULTICITE_COMMAND =
  /^(?:[Cc]ites|[Pp]arencites|[Tt]extcites|[Aa]utocites|[Ff]ootcites|[Ss]martcites|supercites)$/u

const COMMAND_PATTERN = /\\([A-Za-z]+)(\*?)/gu

/** A key a macro builds, or a parameter such as `#1`, is not a key this check can resolve. */
function isLiteralKey(key: string): boolean {
  return key !== '' && !/[\\#{}]/u.test(key)
}

/** 1-based line numbers by offset, for one file. */
function lineIndex(source: string): (offset: number) => number {
  const starts = [0]
  for (let index = source.indexOf('\n'); index !== -1; index = source.indexOf('\n', index + 1)) starts.push(index + 1)
  return offset => {
    let low = 0
    let high = starts.length - 1
    while (low < high) {
      const middle = (low + high + 1) >> 1
      if (starts[middle]! <= offset) low = middle
      else high = middle - 1
    }
    return low + 1
  }
}

/** Skips any `[...]` optional arguments, such as a citation's pre- and post-notes. */
function skipOptionalArguments(masked: string, index: number): number {
  let cursor = skipWhitespace(masked, index)
  for (;;) {
    const optional = readBalanced(masked, cursor, '[', ']')
    if (optional === null) return cursor
    cursor = skipWhitespace(masked, optional.end)
  }
}

function splitKeys(value: string): string[] {
  return value
    .split(',')
    .map(key => key.trim())
    .filter(key => key !== '')
}

/**
 * Finds `\label`, the reference commands, the citation commands, `\bibliography`, and
 * `\addbibresource` in one file, outside `%` comments and verbatim text. Keys come from the source
 * as written: one a macro builds is skipped, never guessed at.
 */
export function scanLatexReferences(filePath: string, source: string): LatexReferenceScan {
  const masked = maskIgnored(source)
  const lineOf = lineIndex(source)
  const scan: LatexReferenceScan = { labels: [], references: [], citations: [], bibliographies: [], citesAll: false }
  const add = (list: ReferenceSite[], keys: string[], offset: number): void => {
    for (const key of keys) if (isLiteralKey(key)) list.push({ key, filePath, line: lineOf(offset) })
  }

  for (const match of masked.matchAll(COMMAND_PATTERN)) {
    const start = match.index
    // After an odd run of backslashes this one ends a `\\` line break, so the name is text.
    if (backslashesBefore(masked, start) % 2 === 1) continue
    const name = match[1]!
    const starred = match[2] === '*'
    const after = start + match[0].length
    if (name === 'label' && !starred) {
      const argument = readBalanced(masked, skipWhitespace(masked, after), '{', '}')
      if (argument !== null) add(scan.labels, [argument.value.trim()], start)
    } else if (REFERENCE_COMMANDS.has(name)) {
      const argument = readBalanced(masked, skipOptionalArguments(masked, after), '{', '}')
      if (argument !== null) add(scan.references, splitKeys(argument.value), start)
    } else if (REFERENCE_RANGE_COMMANDS.has(name)) {
      const first = readBalanced(masked, skipOptionalArguments(masked, after), '{', '}')
      if (first === null) continue
      const last = readBalanced(masked, skipWhitespace(masked, first.end), '{', '}')
      add(scan.references, [first.value.trim(), ...(last === null ? [] : [last.value.trim()])], start)
    } else if (MULTICITE_COMMAND.test(name)) {
      let cursor = after
      // Pre- and post-notes of the whole list come in parentheses.
      for (let notes = 0; notes < 2; notes += 1) {
        const skipped = skipWhitespace(masked, cursor)
        if (masked[skipped] !== '(') break
        const close = masked.indexOf(')', skipped)
        if (close === -1) break
        cursor = close + 1
      }
      for (;;) {
        const argument = readBalanced(masked, skipOptionalArguments(masked, cursor), '{', '}')
        if (argument === null) break
        add(scan.citations, splitKeys(argument.value), start)
        cursor = argument.end
      }
    } else if (CITATION_COMMANDS.has(name)) {
      const argument = readBalanced(masked, skipOptionalArguments(masked, after), '{', '}')
      if (argument === null) continue
      const keys = splitKeys(argument.value)
      if (name === 'nocite' && keys.includes('*')) scan.citesAll = true
      add(
        scan.citations,
        keys.filter(key => key !== '*'),
        start
      )
    } else if (name === 'bibliography' && !starred) {
      const argument = readBalanced(masked, skipWhitespace(masked, after), '{', '}')
      if (argument === null) continue
      for (const target of splitKeys(argument.value)) {
        scan.bibliographies.push({ target, addsExtension: true, filePath, line: lineOf(start) })
      }
    } else if (name === 'addbibresource' || name === 'addglobalbib' || name === 'addsectionbib') {
      const argument = readBalanced(masked, skipOptionalArguments(masked, after), '{', '}')
      if (argument === null || argument.value.trim() === '') continue
      scan.bibliographies.push({ target: argument.value.trim(), addsExtension: false, filePath, line: lineOf(start) })
    }
  }
  return scan
}

const BIB_ENTRY_PATTERN = /@([A-Za-z]+)\s*[{(]\s*([^,\s{}()]+)\s*,/gu
const BIB_NON_ENTRIES = new Set(['comment', 'string', 'preamble'])

/** The entry keys of a `.bib` file, each with its line. `@string`, `@preamble`, and `@comment` are not entries. */
export function scanBibEntries(filePath: string, source: string): ReferenceSite[] {
  const lineOf = lineIndex(source)
  const entries: ReferenceSite[] = []
  for (const match of source.matchAll(BIB_ENTRY_PATTERN)) {
    if (BIB_NON_ENTRIES.has(match[1]!.toLowerCase())) continue
    entries.push({ key: match[2]!, filePath, line: lineOf(match.index) })
  }
  return entries
}

/**
 * Compares what the files define with what they use. Each list keeps the order the sites were
 * found in, which is the order the files were visited, then by line.
 */
export function compareReferences(
  scans: readonly LatexReferenceScan[],
  bibEntries: readonly ReferenceSite[],
  limit = MAX_REFERENCE_FINDINGS
): ReferenceReport {
  const labels = scans.flatMap(scan => scan.labels)
  const references = scans.flatMap(scan => scan.references)
  const citations = scans.flatMap(scan => scan.citations)
  const citesAll = scans.some(scan => scan.citesAll)

  const labelCounts = new Map<string, number>()
  for (const label of labels) labelCounts.set(label.key, (labelCounts.get(label.key) ?? 0) + 1)
  const referenced = new Set(references.map(site => site.key))
  const cited = new Set(citations.map(site => site.key))
  const entryKeys = new Set(bibEntries.map(site => site.key))

  let truncated = false
  const cap = (sites: ReferenceSite[]): ReferenceSite[] => {
    if (sites.length <= limit) return sites
    truncated = true
    return sites.slice(0, limit)
  }
  return {
    undefinedReferences: cap(references.filter(site => !labelCounts.has(site.key))),
    undefinedCitations: cap(citations.filter(site => !entryKeys.has(site.key))),
    unusedLabels: cap(labels.filter(site => !referenced.has(site.key))),
    unusedBibEntries: cap(citesAll ? [] : bibEntries.filter(site => !cited.has(site.key))),
    duplicateLabels: cap(labels.filter(site => (labelCounts.get(site.key) ?? 0) > 1)),
    truncated,
  }
}
