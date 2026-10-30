/**
 * A pure reader for the LaTeX and BibTeX logs a compile leaves behind, written for this package
 * from the log formats themselves (Overleaf's own parsers are AGPL-3.0; this package is MIT).
 *
 * It reports where a build went wrong, never what the document says: a message is the error or
 * warning line alone, cut to MAX_MESSAGE_LENGTH, and the source excerpt TeX prints after `l.<n>`
 * is never part of one.
 */

/** Longest message kept, in UTF-16 code units. */
export const MAX_MESSAGE_LENGTH = 240

/** How many entries each list holds; the counts cover everything. */
export const MAX_LOG_ENTRIES = 20

/** TeX breaks log lines at this width (`max_print_line`), so a longer message spans lines. */
const TEX_LINE_WIDTH = 79

export interface LogEntry {
  /** Project-relative path, when the log names one. */
  file?: string
  line?: number
  message: string
}

export interface LogSummary {
  errorCount: number
  warningCount: number
  errors: LogEntry[]
  warnings: LogEntry[]
  undefinedReferences: string[]
  undefinedCitations: string[]
  missingFiles: string[]
  pageCount?: number
  pdfSizeBytes?: number
}

export function emptyLogSummary(): LogSummary {
  return {
    errorCount: 0,
    warningCount: 0,
    errors: [],
    warnings: [],
    undefinedReferences: [],
    undefinedCitations: [],
    missingFiles: [],
  }
}

/** `./main.tex:12: message`, written under -file-line-error. The path needs an extension. */
const FILE_LINE_ERROR = /^((?:\.{1,2}\/|\/)?[^\s:][^:]*\.[A-Za-z0-9]{1,10}):(\d+): (.*)$/u
const SOURCE_LINE = /^l\.(\d+)(?: |$)/u
const WARNING = /^(LaTeX|LaTeX Font|pdfTeX|Package (\S+)|Class (\S+)) Warning: (.*)$/u
const INPUT_LINE = /on input line (\d+)/u
const UNDEFINED = /\b(Reference|Citation) [`'‘"]([^'’"]+)['’"] on page \S+ undefined/u
const MISSING_FILE = /(?:File|I can't find file) [`'‘"]([^'’"]+)['’"](?: not found)?/u
const OUTPUT_WRITTEN = /^Output written on .*\((\d+) pages?, (\d+) bytes\)\.?$/u

function clip(text: string): string {
  // A message never begins like the source excerpt, which quotes the document.
  const message = text.trim().replace(/^l\.\d+ /u, '')
  return message.length <= MAX_MESSAGE_LENGTH ? message : message.slice(0, MAX_MESSAGE_LENGTH)
}

/** Strips the compile directory from a path the log reports. */
function projectPath(path: string): string {
  return path.replace(/^(?:\/compile\/|\.\/)+/u, '')
}

/** Joins lines TeX broke at its print width back into the message they belong to. */
function unwrap(text: string): Array<{ text: string; at: number }> {
  const raw = text.split(/\r?\n/u)
  const lines: Array<{ text: string; at: number }> = []
  for (let index = 0; index < raw.length; index += 1) {
    const at = index + 1
    let line = raw[index] ?? ''
    while (line.length > 0 && line.length % TEX_LINE_WIDTH === 0 && index + 1 < raw.length) {
      index += 1
      line += raw[index] ?? ''
    }
    lines.push({ text: line, at })
  }
  return lines
}

class Collector {
  readonly summary = emptyLogSummary()

  error(entry: LogEntry): void {
    this.summary.errorCount += 1
    if (this.summary.errors.length < MAX_LOG_ENTRIES) this.summary.errors.push(entry)
    this.#missing(entry.message)
  }

  warning(entry: LogEntry): void {
    this.summary.warningCount += 1
    if (this.summary.warnings.length < MAX_LOG_ENTRIES) this.summary.warnings.push(entry)
    const undefinedName = UNDEFINED.exec(entry.message)
    if (undefinedName !== null) {
      const list = undefinedName[1] === 'Reference' ? this.summary.undefinedReferences : this.summary.undefinedCitations
      add(list, undefinedName[2]!)
    }
    this.#missing(entry.message)
  }

  citation(key: string): void {
    add(this.summary.undefinedCitations, key)
  }

  missingFile(path: string): void {
    add(this.summary.missingFiles, projectPath(path))
  }

  #missing(message: string): void {
    const missing = MISSING_FILE.exec(message)
    if (missing !== null && /not found|can't find/u.test(message)) this.missingFile(missing[1]!)
  }
}

function add(list: string[], value: string): void {
  if (list.length < MAX_LOG_ENTRIES && !list.includes(value)) list.push(value)
}

function entry(message: string, file?: string, line?: number): LogEntry {
  return {
    ...(file === undefined ? {} : { file: projectPath(file) }),
    ...(line === undefined ? {} : { line }),
    message: clip(message),
  }
}

/** The 1-based line of the `l.<n>` marker that follows an error, looked for before the next error. */
function sourceLine(lines: Array<{ text: string }>, from: number): number | undefined {
  for (let index = from; index < Math.min(lines.length, from + 12); index += 1) {
    const text = lines[index]!.text
    const match = SOURCE_LINE.exec(text)
    if (match !== null) return Number(match[1])
    if (text.startsWith('! ') || FILE_LINE_ERROR.test(text)) return undefined
  }
  return undefined
}

/** Whether a raw LaTeX log line starts an error. */
export function isLatexErrorLine(line: string): boolean {
  return line.startsWith('! ') || FILE_LINE_ERROR.test(line)
}

/** Reads a TeX log (`output.log`), in either the classic `! ` form or the -file-line-error form. */
export function parseLatexLog(text: string): LogSummary {
  const lines = unwrap(text)
  const collector = new Collector()
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.text
    const located = FILE_LINE_ERROR.exec(line)
    if (located !== null) {
      collector.error(entry(located[3]!, located[1], Number(located[2])))
      continue
    }
    if (line.startsWith('! ')) {
      collector.error(entry(line.slice(2), undefined, sourceLine(lines, index + 1)))
      continue
    }
    const warning = WARNING.exec(line)
    if (warning !== null) {
      // Package and class warnings continue on lines that start with the name in parentheses.
      const continuation = warning[2] ?? warning[3] ?? (warning[1] === 'LaTeX Font' ? 'Font' : undefined)
      let message = warning[4]!
      while (continuation !== undefined && lines[index + 1]?.text.startsWith(`(${continuation})`) === true) {
        index += 1
        message += ` ${lines[index]!.text.slice(continuation.length + 2).trim()}`
      }
      const at = INPUT_LINE.exec(message)
      const prefix = warning[1] === 'LaTeX' ? '' : `${warning[1]} Warning: `
      collector.warning(entry(`${prefix}${message}`, undefined, at === null ? undefined : Number(at[1])))
      continue
    }
    const written = OUTPUT_WRITTEN.exec(line)
    if (written !== null) {
      collector.summary.pageCount = Number(written[1])
      collector.summary.pdfSizeBytes = Number(written[2])
      continue
    }
    if (line.startsWith('No pages of output.')) collector.summary.pageCount = 0
  }
  return collector.summary
}

const BIBTEX_WARNING = /^Warning--(.*)$/u
const BIBTEX_MISSING_ENTRY = /I didn't find a database entry for [`'"]([^'"]+)['"]/u
const BIBTEX_LOCATED_ERROR = /^(.+?)---line (\d+) of file (.+)$/u
const BIBTEX_ERROR = /^(I couldn't open (?:database|style) file .+|I found no .+|Illegal, .+|Repeated entry.*)$/u
const BIBTEX_OPEN_FAILED = /^I couldn't open database file (.+)$/u
const BIBER_LINE = /\b(WARN|ERROR) - (.*)$/u
const BIBER_MISSING_FILE = /Cannot find ['"]([^'"]+)['"]/u

/** Whether a raw BibTeX or Biber log line starts an error. */
export function isBibtexErrorLine(line: string): boolean {
  if (BIBER_LINE.exec(line)?.[1] === 'ERROR') return true
  const located = BIBTEX_LOCATED_ERROR.exec(line)
  if (located !== null) return !located[3]!.endsWith('.aux') && located[1]!.trim() !== ''
  return BIBTEX_ERROR.test(line)
}

/** Reads a BibTeX or Biber log (`*.blg`). */
export function parseBibtexLog(text: string): LogSummary {
  const collector = new Collector()
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trimEnd()
    const biber = BIBER_LINE.exec(line)
    if (biber !== null) {
      const message = biber[2]!
      const missingEntry = BIBTEX_MISSING_ENTRY.exec(message)
      if (missingEntry !== null) collector.citation(missingEntry[1]!)
      const missingFile = BIBER_MISSING_FILE.exec(message)
      if (missingFile !== null) collector.missingFile(missingFile[1]!)
      if (biber[1] === 'ERROR') collector.error(entry(`Biber: ${message}`))
      else collector.warning(entry(`Biber: ${message}`))
      continue
    }
    const warning = BIBTEX_WARNING.exec(line)
    if (warning !== null) {
      const missingEntry = BIBTEX_MISSING_ENTRY.exec(warning[1]!)
      if (missingEntry !== null) collector.citation(missingEntry[1]!)
      collector.warning(entry(`BibTeX: ${warning[1]!}`))
      continue
    }
    const located = BIBTEX_LOCATED_ERROR.exec(line)
    if (located !== null) {
      // "---line 3 of file output.aux" points into generated files, not the author's sources.
      if (!located[3]!.endsWith('.aux') && located[1]!.trim() !== '') {
        collector.error(entry(`BibTeX: ${located[1]!}`, located[3], Number(located[2])))
      }
      continue
    }
    if (BIBTEX_ERROR.test(line)) {
      const openFailed = BIBTEX_OPEN_FAILED.exec(line)
      if (openFailed !== null) collector.missingFile(openFailed[1]!.trim())
      collector.error(entry(`BibTeX: ${line}`))
    }
  }
  return collector.summary
}

/** Combines two summaries, keeping each list's bound; page and size come from the first that has them. */
export function mergeLogSummaries(first: LogSummary, second: LogSummary): LogSummary {
  const merged: LogSummary = {
    errorCount: first.errorCount + second.errorCount,
    warningCount: first.warningCount + second.warningCount,
    errors: [...first.errors, ...second.errors].slice(0, MAX_LOG_ENTRIES),
    warnings: [...first.warnings, ...second.warnings].slice(0, MAX_LOG_ENTRIES),
    undefinedReferences: union(first.undefinedReferences, second.undefinedReferences),
    undefinedCitations: union(first.undefinedCitations, second.undefinedCitations),
    missingFiles: union(first.missingFiles, second.missingFiles),
  }
  const pageCount = first.pageCount ?? second.pageCount
  const pdfSizeBytes = first.pdfSizeBytes ?? second.pdfSizeBytes
  if (pageCount !== undefined) merged.pageCount = pageCount
  if (pdfSizeBytes !== undefined) merged.pdfSizeBytes = pdfSizeBytes
  return merged
}

function union(first: string[], second: string[]): string[] {
  return [...new Set([...first, ...second])].slice(0, MAX_LOG_ENTRIES)
}
