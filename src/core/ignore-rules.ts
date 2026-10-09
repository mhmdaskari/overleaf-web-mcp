import { readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'

import ignore from 'ignore'

import { McpError } from './errors.js'

/**
 * Paths a folder sync leaves alone unless a later `!pattern` re-includes them.
 *
 * `.*` already covers `.git/` and `.DS_Store`; they come first so the pattern reported for them
 * is the specific one, since the matcher names the first rule that excludes a path. Build output
 * is what a local LaTeX run leaves next to the sources and Overleaf regenerates on every compile.
 */
export const DEFAULT_SYNC_IGNORE: readonly string[] = [
  '.git/',
  '.DS_Store',
  '.*',
  '__MACOSX/',
  '*.aux',
  '*.log',
  '*.bbl',
  '*.blg',
  '*.out',
  '*.toc',
  '*.synctex.gz',
  '*.fdb_latexmk',
  '*.fls',
]

/** The ignore file `overleaf-sync` users already keep in their project folders. */
export const OLIGNORE_FILE = '.olignore'

export interface SyncIgnoreRules {
  /** The pattern that excludes `relativePath`, or `undefined` when the path is included. */
  match(relativePath: string, isDirectory: boolean): string | undefined
  /** Raw `.olignore` content, absent when the folder has none. */
  olignore?: string
}

/**
 * Builds the gitignore-style matcher for one sync root: the defaults, then `.olignore`, then
 * the caller's patterns, so a later `!pattern` can re-include what an earlier rule excluded.
 * Patterns match case-insensitively, and a folder pattern such as `build/` covers everything
 * inside that folder.
 */
export async function loadSyncIgnoreRules(
  root: string,
  extra: readonly string[] = []
): Promise<SyncIgnoreRules> {
  let olignore: string | undefined
  try {
    const path = await realpath(join(root, OLIGNORE_FILE))
    // Its patterns are echoed back in plans, so a link to a file elsewhere would disclose that file.
    const inside = relative(await realpath(root), path)
    if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
      throw new McpError(
        'PATH_OUTSIDE_ROOT',
        `${OLIGNORE_FILE} in the local folder is a link to a file outside it. Replace it with a regular file.`,
        { details: { kind: 'outside_folder' } }
      )
    }
    olignore = await readFile(path, 'utf8')
  } catch (error) {
    if (error instanceof McpError) throw error
    // A missing folder, or a file in its place, is reported by the scan that follows.
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      throw new McpError('INVALID_ARGUMENT', `${OLIGNORE_FILE} in the local folder could not be read.`, {
        cause: error,
      })
    }
  }
  const matcher = ignore().add([...DEFAULT_SYNC_IGNORE])
  if (olignore !== undefined) matcher.add(olignore)
  matcher.add([...extra])
  return {
    match(relativePath, isDirectory) {
      let result: ReturnType<typeof matcher.test>
      try {
        result = matcher.test(isDirectory ? `${relativePath}/` : relativePath)
      } catch {
        // A name the matcher cannot parse is not excluded by any pattern either.
        return undefined
      }
      return result.ignored ? (result.rule?.pattern ?? 'ignored') : undefined
    },
    ...(olignore === undefined ? {} : { olignore }),
  }
}
