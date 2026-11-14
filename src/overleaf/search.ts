import { McpError } from '../core/errors.js'
import { AccessPolicy } from '../core/policy.js'
import { normalizeProjectPath, type ProjectTree } from './tree.js'

export const MAX_SEARCH_QUERY_LENGTH = 200
export const DEFAULT_SEARCH_LIMIT = 50
export const MAX_SEARCH_LIMIT = 500
/** The most documents one search reads; a larger scope returns what it found with `truncated`. */
export const MAX_SEARCH_DOCUMENTS = 300
/** The most characters of the matching line a preview holds, the match included. */
export const SEARCH_PREVIEW_CHARS = 160

export interface SearchMatch {
  filePath: string
  /** 1-based line of the match's first character. */
  line: number
  /** 1-based column, in UTF-16 code units as the editor counts them. */
  column: number
  /** The matching line, cut to at most `SEARCH_PREVIEW_CHARS` around the match, with `…` where cut. */
  preview: string
}

export interface SearchResult {
  matches: SearchMatch[]
  /** Every match in the documents searched, including those past `limit`. */
  totalMatches: number
  /** True when matches were left out for `limit`, or documents for `MAX_SEARCH_DOCUMENTS`. */
  truncated: boolean
  filesSearched: number
  /** Binary files in scope, which are never read. */
  binaryFilesSkipped: number
}

export interface SearchOptions {
  caseSensitive?: boolean | undefined
  /** A document, or a folder whose documents are searched; the whole project when absent. */
  path?: string | undefined
  limit?: number | undefined
}

export interface SearchApiOptions {
  /** A fresh tree, so a search never reads paths from a stale one. */
  getProjectTree(projectId: string): Promise<ProjectTree>
  readFile(projectId: string, filePath: string): Promise<{ content: string }>
  policy?: AccessPolicy | undefined
}

function escapeRegExp(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|]/gu, '\\$&')
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

/** The line around a match, cut to the preview width without splitting a surrogate pair. */
function previewOf(line: string, start: number, length: number): string {
  if (line.length <= SEARCH_PREVIEW_CHARS) return line
  const shown = Math.min(length, SEARCH_PREVIEW_CHARS)
  let from = Math.max(0, start - Math.floor((SEARCH_PREVIEW_CHARS - shown) / 2))
  let to = Math.min(line.length, from + SEARCH_PREVIEW_CHARS)
  from = Math.max(0, to - SEARCH_PREVIEW_CHARS)
  if (from > 0 && isHighSurrogate(line.charCodeAt(from - 1))) from += 1
  if (to < line.length && isHighSurrogate(line.charCodeAt(to - 1))) to -= 1
  return `${from > 0 ? '…' : ''}${line.slice(from, to)}${to < line.length ? '…' : ''}`
}

/**
 * Searches a project's text documents for a literal string. It is a composition of existing reads
 * on the per-project queue, one document at a time: it saves calls and context, not wall-clock
 * time. Literal matching only, so a query can never run without bound.
 */
export class SearchApi {
  readonly #options: SearchApiOptions
  readonly #policy: AccessPolicy

  constructor(options: SearchApiOptions) {
    this.#options = options
    this.#policy = options.policy ?? AccessPolicy.permissive
  }

  async searchProject(projectId: string, query: string, options: SearchOptions = {}): Promise<SearchResult> {
    this.#policy.assertProject(projectId)
    this.#policy.assertEffect('overleaf-read')
    if (query.length < 1 || query.length > MAX_SEARCH_QUERY_LENGTH) {
      throw new McpError('INVALID_ARGUMENT', `query must hold 1 to ${MAX_SEARCH_QUERY_LENGTH} characters.`)
    }
    const limit = options.limit ?? DEFAULT_SEARCH_LIMIT
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SEARCH_LIMIT) {
      throw new McpError('INVALID_ARGUMENT', `limit must be an integer between 1 and ${MAX_SEARCH_LIMIT}.`)
    }
    // A folder may be named with a trailing slash.
    const scope =
      options.path === undefined || options.path === ''
        ? undefined
        : normalizeProjectPath(options.path).replace(/\/+$/u, '')

    const tree = await this.#options.getProjectTree(projectId)
    const inScope = tree.entities.filter(
      entity =>
        entity.type !== 'folder' &&
        (scope === undefined || entity.path === scope || entity.path.startsWith(`${scope}/`))
    )
    if (scope !== undefined && inScope.length === 0 && !tree.entities.some(entity => entity.path === scope)) {
      throw new McpError('NOT_FOUND', 'No document or folder exists at path.')
    }
    const documents = inScope
      .filter(entity => entity.type === 'doc')
      .map(entity => entity.path)
      .sort()
    const binaryFilesSkipped = inScope.length - documents.length
    const searched = documents.slice(0, MAX_SEARCH_DOCUMENTS)

    const pattern = new RegExp(escapeRegExp(query), options.caseSensitive === true ? 'gu' : 'giu')
    const matches: SearchMatch[] = []
    let totalMatches = 0
    for (const filePath of searched) {
      const { content } = await this.#options.readFile(projectId, filePath)
      let line = 1
      let lineStart = 0
      for (const found of content.matchAll(pattern)) {
        // Lines are counted forward from the last match, so each document is walked once.
        let newline = content.indexOf('\n', lineStart)
        while (newline !== -1 && newline < found.index) {
          line += 1
          lineStart = newline + 1
          newline = content.indexOf('\n', lineStart)
        }
        totalMatches += 1
        if (matches.length >= limit) continue
        const lineEnd = content.indexOf('\n', found.index)
        const text = content.slice(lineStart, lineEnd === -1 ? content.length : lineEnd)
        matches.push({
          filePath,
          line,
          column: found.index - lineStart + 1,
          preview: previewOf(text, found.index - lineStart, found[0].length),
        })
      }
    }
    return {
      matches,
      totalMatches,
      truncated: totalMatches > matches.length || searched.length < documents.length,
      filesSearched: searched.length,
      binaryFilesSkipped,
    }
  }
}
