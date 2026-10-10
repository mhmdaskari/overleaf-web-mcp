import type { Dirent } from 'node:fs'
import { readdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'

import { McpError } from './errors.js'
import { gitBlobHashFile } from './hash.js'
import type { SyncIgnoreRules } from './ignore-rules.js'

/** Overleaf's own per-project entity limit; a larger folder can never be synced whole. */
export const MAX_SYNC_FILES = 2_000
/** Bounds the walk itself, so a mistaken localFolderPath such as a home folder fails fast. */
export const MAX_SCANNED_ENTRIES = 20_000

export interface LocalFile {
  /** Path relative to the scanned root, with forward slashes. */
  path: string
  absolutePath: string
  size: number
  /** `git hash-object` of the file's bytes, the format Overleaf stores for binaries. */
  hash: string
}

export interface IgnoredLocalEntry {
  /** Relative path; folders end with `/`. */
  localPath: string
  /** The ignore pattern that excluded it. */
  matchedPattern?: string
  /** Why it was skipped when no pattern applies, for example a broken symbolic link. */
  reason?: string
}

export interface LocalFolderScan {
  root: string
  files: LocalFile[]
  /** Every included folder, relative to the root, parents before children. */
  directories: string[]
  ignored: IgnoredLocalEntry[]
}

function isInside(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

function unreadable(path: string, cause: unknown): McpError {
  return new McpError('INVALID_ARGUMENT', `${path} in the local folder could not be read.`, { cause })
}

function byName(left: Dirent, right: Dirent): number {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0
}

/**
 * Walks a local folder for a sync, in a stable order, hashing every included file.
 *
 * Symbolic links are followed only when they resolve inside the root: one that leads outside
 * fails the whole scan with `PATH_OUTSIDE_ROOT`, before anything is compared or changed, and a
 * linked folder that leads back into one of its own ancestors is refused as a cycle. Ignored
 * folders are never descended into, so their contents are reported once, as the folder.
 */
export async function scanLocalFolder(
  localFolderPath: string,
  rules: SyncIgnoreRules
): Promise<LocalFolderScan> {
  let root: string
  try {
    root = await realpath(localFolderPath)
  } catch (error) {
    throw new McpError('NOT_FOUND', `Local folder was not found: ${localFolderPath}`, { cause: error })
  }
  if (!(await stat(root)).isDirectory()) {
    throw new McpError('INVALID_ARGUMENT', `${localFolderPath} is not a folder.`)
  }

  const files: LocalFile[] = []
  const directories: string[] = []
  const ignored: IgnoredLocalEntry[] = []
  let scanned = 0

  const visit = async (absoluteDir: string, relativeDir: string, ancestors: string[]): Promise<void> => {
    let entries: Dirent[]
    try {
      entries = (await readdir(absoluteDir, { withFileTypes: true })).sort(byName)
    } catch (error) {
      throw unreadable(relativeDir === '' ? '.' : relativeDir, error)
    }
    for (const entry of entries) {
      scanned += 1
      if (scanned > MAX_SCANNED_ENTRIES) {
        throw new McpError(
          'INVALID_ARGUMENT',
          `The local folder holds more than ${MAX_SCANNED_ENTRIES} entries. Point localFolderPath at the project folder itself, or ignore large subfolders.`
        )
      }
      const path = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`
      const absolutePath = join(absoluteDir, entry.name)

      let target = absolutePath
      let isDirectory = entry.isDirectory()
      let isFile = entry.isFile()
      if (entry.isSymbolicLink()) {
        try {
          target = await realpath(absolutePath)
          const targetStat = await stat(target)
          isDirectory = targetStat.isDirectory()
          isFile = targetStat.isFile()
        } catch {
          ignored.push({ localPath: path, reason: 'broken symbolic link' })
          continue
        }
      }

      const matchedPattern = rules.match(path, isDirectory)
      if (matchedPattern !== undefined) {
        ignored.push({ localPath: isDirectory ? `${path}/` : path, matchedPattern })
        continue
      }
      if (!isDirectory && !isFile) {
        ignored.push({ localPath: path, reason: 'not a regular file or folder' })
        continue
      }
      if (entry.isSymbolicLink() && !isInside(root, target)) {
        throw new McpError(
          'PATH_OUTSIDE_ROOT',
          `${path} is a symbolic link that resolves outside localFolderPath. Remove it, or ignore it with a pattern.`,
          { details: { localPath: path, kind: 'outside_folder' } }
        )
      }

      if (isDirectory) {
        // Real paths, so a link back into a folder reached through another link is still caught.
        if (!entry.isSymbolicLink()) target = await realpath(absolutePath)
        if (ancestors.includes(target)) {
          throw new McpError(
            'INVALID_ARGUMENT',
            `${path} is a symbolic link back into one of its own parent folders. Remove it, or ignore it with a pattern.`,
            { details: { localPath: path } }
          )
        }
        directories.push(path)
        await visit(absolutePath, path, [...ancestors, target])
        continue
      }

      let blob: Awaited<ReturnType<typeof gitBlobHashFile>>
      try {
        blob = await gitBlobHashFile(absolutePath)
      } catch (error) {
        if (error instanceof McpError) throw error
        throw unreadable(path, error)
      }
      files.push({ path, absolutePath, size: blob.size, hash: blob.hash })
      if (files.length > MAX_SYNC_FILES) {
        throw new McpError(
          'INVALID_ARGUMENT',
          `The local folder holds more than ${MAX_SYNC_FILES} files that are not ignored, Overleaf's limit for one project. Narrow localFolderPath or add ignore patterns.`
        )
      }
    }
  }

  await visit(root, '', [root])
  return { root, files, directories, ignored }
}
