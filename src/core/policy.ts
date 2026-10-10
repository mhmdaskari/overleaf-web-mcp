import { readlink, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import type { Effect } from '../contracts/effects.js'
import { McpError } from './errors.js'

/**
 * Characters an id may not hold, because ids are interpolated into request paths: a `/` or `.`
 * could step into another route, and `?`, `#`, or `%` could change what the request means.
 */
const UNSAFE_ID_CHARACTERS = /[/\\.?#%]/u

/** Whether an id can be interpolated into a request path without changing what the path names. */
export function isPathSafeId(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  return value !== '' && !UNSAFE_ID_CHARACTERS.test(value) && !/[\u0000-\u001f\u007f]/u.test(value)
}

/** Refuses an id that could change the request path it is interpolated into; checked before any request. */
export function assertPathSafeId(value: string, parameter: string): void {
  if (!isPathSafeId(value)) {
    throw new McpError(
      'INVALID_ARGUMENT',
      `${parameter} is not a valid Overleaf id; ids never contain /, \\, ., ?, #, or %.`,
      { details: { parameter } }
    )
  }
}

/** What the policy allows. An absent list allows everything of its kind. */
export interface AccessPolicyConfig {
  allowedProjects?: readonly string[] | undefined
  localReadRoots?: readonly string[] | undefined
  localWriteRoots?: readonly string[] | undefined
  allowedEffects?: readonly Effect[] | undefined
  /** The saved session's cookie jar; no local read or write may touch it, its lock, or its temporary files. */
  cookieJarFile?: string | undefined
  /** The browser profile `login` signs in with; no local read or write may reach inside it. */
  browserProfileDir?: string | undefined
}

/** Why a local path was refused, in `details.kind` of `PATH_OUTSIDE_ROOT`. */
export type LocalRefusal = 'outside_read_roots' | 'outside_write_roots' | 'session_files' | 'outside_folder'

function isInside(folder: string, target: string): boolean {
  const path = relative(folder, target)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

const WINDOWS = process.platform === 'win32'

/** Most links a path may pass through, as the operating system's own limit is about this. */
const MAX_LINKS = 40

/**
 * Splits off the last name of an absolute path as text, without normalizing it, or returns
 * `undefined` for a root.
 */
function splitLast(path: string): { parent: string; name: string } | undefined {
  const trimmed = path.replace(WINDOWS ? /[\\/]+$/u : /\/+$/u, '')
  const at = WINDOWS ? Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\')) : trimmed.lastIndexOf('/')
  if (at < 0 || trimmed === '') return undefined
  let parent = trimmed.slice(0, at)
  // The parent of "/name" is "/", and of "C:\\name" is "C:\\".
  if (parent === '' || (WINDOWS && /^[A-Za-z]:$/u.test(parent))) parent = trimmed.slice(0, at + 1)
  return { parent, name: trimmed.slice(at + 1) }
}

/**
 * Where the file system takes `path`, whether or not it exists yet: its real path, or the real
 * path of its nearest existing ancestor with the rest appended. The path is never normalized as
 * text first, since `link/..` is the link's parent folder, not the folder holding the link, and a
 * dangling link is followed to where it would create a file.
 */
async function realOrNearest(path: string, links = 0): Promise<string> {
  // Joined as text, not with join() or resolve(), which would collapse `..` before links are followed.
  const absolute = isAbsolute(path) ? path : `${process.cwd()}${sep}${path}`
  try {
    return await realpath(absolute)
  } catch {
    // Not there yet, or a link to something that is not.
  }
  const split = splitLast(absolute)
  if (split === undefined) return resolve(absolute)
  const target = await readlink(absolute).catch(() => undefined)
  if (target !== undefined) {
    if (links >= MAX_LINKS) {
      throw new McpError('INVALID_ARGUMENT', `${path} leads through too many symbolic links.`)
    }
    return await realOrNearest(isAbsolute(target) ? target : `${split.parent}${sep}${target}`, links + 1)
  }
  const real = await realOrNearest(split.parent, links)
  // What lies past the nearest existing folder does not exist, so it holds no links to follow.
  if (split.name === '' || split.name === '.') return real
  return split.name === '..' ? dirname(real) : join(real, split.name)
}

async function realRoots(roots: readonly string[] | undefined, variable: string): Promise<string[] | undefined> {
  if (roots === undefined) return undefined
  return await Promise.all(
    roots.map(async root => {
      try {
        return await realpath(root)
      } catch (error) {
        throw new McpError('INVALID_ARGUMENT', `${variable} names a folder that does not exist.`, { cause: error })
      }
    })
  )
}

/**
 * Decides which projects, local paths, and effects this process may touch, for every interface
 * and every public mutation, exported runtime methods included.
 *
 * It is not a sandbox. It stops an agent, possibly steered by text it read in a project, from
 * reaching outside what it was given; it cannot close the gap between a path check and the open
 * that follows, and it cannot contain another process on the same machine.
 */
export class AccessPolicy {
  /** Allows every project, path, and effect, and still refuses ids that are not path-safe. */
  static readonly permissive = new AccessPolicy({}, {})

  readonly #allowedProjects: Set<string> | undefined
  readonly #allowedEffects: Set<Effect> | undefined
  readonly #readRoots: string[] | undefined
  readonly #writeRoots: string[] | undefined
  readonly #cookieJarFile: string | undefined
  readonly #browserProfileDir: string | undefined

  private constructor(
    config: AccessPolicyConfig,
    resolved: {
      readRoots?: string[] | undefined
      writeRoots?: string[] | undefined
      cookieJarFile?: string | undefined
      browserProfileDir?: string | undefined
    }
  ) {
    this.#allowedProjects = config.allowedProjects === undefined ? undefined : new Set(config.allowedProjects)
    this.#allowedEffects = config.allowedEffects === undefined ? undefined : new Set(config.allowedEffects)
    this.#readRoots = resolved.readRoots
    this.#writeRoots = resolved.writeRoots
    this.#cookieJarFile = resolved.cookieJarFile
    this.#browserProfileDir = resolved.browserProfileDir
  }

  /** Resolves every root and session path by `realpath`, so a symbolic link cannot widen them later. */
  static async create(config: AccessPolicyConfig): Promise<AccessPolicy> {
    for (const projectId of config.allowedProjects ?? []) assertPathSafeId(projectId, 'OVERLEAF_ALLOWED_PROJECTS')
    return new AccessPolicy(config, {
      readRoots: await realRoots(config.localReadRoots, 'OVERLEAF_LOCAL_READ_ROOTS'),
      writeRoots: await realRoots(config.localWriteRoots, 'OVERLEAF_LOCAL_WRITE_ROOTS'),
      cookieJarFile: config.cookieJarFile === undefined ? undefined : await realOrNearest(config.cookieJarFile),
      browserProfileDir:
        config.browserProfileDir === undefined ? undefined : await realOrNearest(config.browserProfileDir),
    })
  }

  /** Whether an allowlist limits which projects are visible at all. */
  get restrictsProjects(): boolean {
    return this.#allowedProjects !== undefined
  }

  /** Whether `list_projects` may show the project. */
  allowsProject(projectId: string): boolean {
    return this.#allowedProjects === undefined || this.#allowedProjects.has(projectId)
  }

  /**
   * Refuses an id that is not path-safe (`INVALID_ARGUMENT`) or a project outside
   * `OVERLEAF_ALLOWED_PROJECTS` (`POLICY_DENIED`), before anything is sent.
   */
  assertProject(projectId: string, parameter = 'projectId'): void {
    assertPathSafeId(projectId, parameter)
    if (!this.allowsProject(projectId)) {
      throw new McpError(
        'POLICY_DENIED',
        `${parameter} names a project outside OVERLEAF_ALLOWED_PROJECTS; nothing was sent.`,
        { details: { parameter } }
      )
    }
  }

  /**
   * A project this process created joins the allowlist for the rest of the process, so its
   * creator can keep working on it. Another process does not see it.
   */
  allowProject(projectId: string): void {
    this.#allowedProjects?.add(projectId)
  }

  /** Refuses an effect outside `OVERLEAF_ALLOWED_EFFECTS` (`POLICY_DENIED`), before any work. */
  assertEffect(...effects: Effect[]): void {
    if (this.#allowedEffects === undefined) return
    const refused = effects.find(effect => !this.#allowedEffects!.has(effect))
    if (refused !== undefined) {
      throw new McpError(
        'POLICY_DENIED',
        `This call needs the ${refused} effect, which OVERLEAF_ALLOWED_EFFECTS does not allow; nothing was done.`,
        { details: { effect: refused } }
      )
    }
  }

  /**
   * The path a local read should open, refused with `PATH_OUTSIDE_ROOT` when it is the saved
   * session's cookie jar or browser profile, or, for a folder, holds either, or lies outside
   * every read root. A path that is a symbolic link is judged by where it leads. A missing file
   * is not refused here; it fails where it is read.
   */
  async resolveLocalRead(localPath: string, options: { folder?: boolean } = {}): Promise<string> {
    this.assertEffect('local-read')
    const target = await realOrNearest(localPath)
    if (this.#touchesSessionFiles(target) || (options.folder === true && this.#holdsSessionFiles(target))) {
      throw new McpError(
        'PATH_OUTSIDE_ROOT',
        `${localPath} is or holds the saved Overleaf session, which is never read; nothing was done.`,
        { details: { kind: 'session_files' satisfies LocalRefusal } }
      )
    }
    if (this.#readRoots !== undefined && !this.#readRoots.some(root => isInside(root, target))) {
      throw outside(localPath, 'outside_read_roots', 'OVERLEAF_LOCAL_READ_ROOTS')
    }
    return await friendlyPath(localPath, target)
  }

  /**
   * The path a local write should create or replace, refused with `PATH_OUTSIDE_ROOT` when it
   * is the saved session's cookie jar or browser profile, or lies outside every write root.
   * A path that is a symbolic link is judged by where it leads.
   */
  async resolveLocalWrite(localPath: string): Promise<string> {
    this.assertEffect('local-write')
    const target = await realOrNearest(localPath)
    if (this.#touchesSessionFiles(target)) {
      throw new McpError(
        'PATH_OUTSIDE_ROOT',
        `${localPath} is part of the saved Overleaf session, which a download never replaces; nothing was written.`,
        { details: { kind: 'session_files' satisfies LocalRefusal } }
      )
    }
    if (this.#writeRoots !== undefined && !this.#writeRoots.some(root => isInside(root, target))) {
      throw outside(localPath, 'outside_write_roots', 'OVERLEAF_LOCAL_WRITE_ROOTS')
    }
    return await friendlyPath(localPath, target)
  }

  #holdsSessionFiles(folder: string): boolean {
    return [this.#cookieJarFile, this.#browserProfileDir].some(path => path !== undefined && isInside(folder, path))
  }

  #touchesSessionFiles(target: string): boolean {
    const jar = this.#cookieJarFile
    // The jar, the lock folder proper-lockfile keeps beside it, and the temporary files it is saved through.
    if (
      jar !== undefined &&
      (target === jar ||
        isInside(`${jar}.lock`, target) ||
        (dirname(target) === dirname(jar) && basename(target).startsWith(`.${basename(jar)}.`)))
    ) {
      return true
    }
    return this.#browserProfileDir !== undefined && isInside(this.#browserProfileDir, target)
  }
}

/**
 * The path to open: the caller's, made absolute, when it leads to the file that was checked, and
 * otherwise the checked real path, so whatever opens it reaches exactly what the policy judged.
 */
async function friendlyPath(localPath: string, checked: string): Promise<string> {
  const absolute = resolve(localPath)
  return absolute === checked || (await realOrNearest(absolute)) === checked ? absolute : checked
}

function outside(localPath: string, kind: LocalRefusal, variable: string): McpError {
  return new McpError(
    'PATH_OUTSIDE_ROOT',
    `${localPath} is outside the folders ${variable} allows; nothing was done.`,
    { details: { kind } }
  )
}
