import { posix } from 'node:path'

import { McpError } from '../core/errors.js'

export type EntityType = 'doc' | 'file' | 'folder'

export interface RawEntity {
  _id: string
  name: string
  hash?: string
}

export interface RawFolder extends RawEntity {
  docs?: RawEntity[]
  fileRefs?: RawEntity[]
  folders?: RawFolder[]
}

export interface ProjectEntity {
  id: string
  name: string
  path: string
  type: EntityType
  parentFolderId: string
  /**
   * Git blob hash, present only on binary `file` entities.
   *
   * Overleaf stores no content hash for `doc` entities, so text documents are absent from
   * any hash comparison and must be compared by reading their content. See `gitBlobHash`.
   */
  hash?: string
}

/** A project tree plus the project-level settings that decide what Overleaf compiles. */
export interface ProjectTree {
  entities: ProjectEntity[]
  /** Path of the project's configured root document, absent when Overleaf has none. */
  rootDocPath?: string
  /** TeX engine Overleaf compiles with, for example `pdflatex` or `xelatex`. */
  compiler?: string
  /** TeX Live image the project compiles against. */
  imageName?: string
  /** Spell-check language code, absent when spell checking is off. */
  spellCheckLanguage?: string
  trackChangesActive: boolean
  hashNote: string
}

export const TREE_HASH_NOTE =
  'hash is a git blob hash, sha1("blob " + byteLength + "\\0" + content), identical to ' +
  '`git hash-object <file>`. It is present only on binary file entities; doc entities have no hash.'


export function normalizeProjectPath(path: string): string {
  const slashPath = path.replace(/\\/gu, '/')
  const normalized = posix.normalize(slashPath).replace(/^\.\//u, '').replace(/^\//u, '')
  if (
    !path ||
    path.startsWith('/') ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.includes('/../')
  ) {
    throw new McpError('INVALID_ARGUMENT', `invalid project path: ${path}`)
  }
  return normalized
}

export function flattenProjectTree(input: RawFolder[] | RawFolder): ProjectEntity[] {
  const roots = Array.isArray(input) ? input : [input]
  const output: ProjectEntity[] = []

  const visit = (folder: RawFolder, prefix: string, parentFolderId?: string): void => {
    const includeFolder = parentFolderId !== undefined
    const folderPath = includeFolder ? normalizeProjectPath(posix.join(prefix, folder.name)) : prefix
    if (includeFolder) {
      output.push({
        id: folder._id,
        name: folder.name,
        path: folderPath,
        type: 'folder',
        parentFolderId,
      })
    }
    for (const doc of folder.docs ?? []) {
      output.push({
        id: doc._id,
        name: doc.name,
        path: normalizeProjectPath(posix.join(folderPath, doc.name)),
        type: 'doc',
        parentFolderId: folder._id,
      })
    }
    for (const file of folder.fileRefs ?? []) {
      output.push({
        id: file._id,
        name: file.name,
        path: normalizeProjectPath(posix.join(folderPath, file.name)),
        type: 'file',
        parentFolderId: folder._id,
        ...(file.hash === undefined ? {} : { hash: file.hash }),
      })
    }
    for (const child of folder.folders ?? []) visit(child, folderPath, folder._id)
  }

  for (const root of roots) visit(root, '')
  return output
}

export function resolveProjectPath(
  tree: ProjectEntity[],
  path: string,
  expectedType?: EntityType
): ProjectEntity {
  const normalized = normalizeProjectPath(path)
  const entity = tree.find(candidate => candidate.path === normalized)
  if (!entity) throw new McpError('NOT_FOUND', `Project path was not found: ${normalized}`)
  if (expectedType && entity.type !== expectedType) {
    throw new McpError(
      'INVALID_ARGUMENT',
      `${normalized} is a ${entity.type}, not a ${expectedType}.`
    )
  }
  return entity
}

export function parentPath(path: string): string {
  const normalized = normalizeProjectPath(path)
  const parent = posix.dirname(normalized)
  return parent === '.' ? '' : parent
}
