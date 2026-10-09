import { realpath } from 'node:fs/promises'
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
  /** The saved session's cookie jar; no local write may touch it, its lock, or its temporary files. */
  cookieJarFile?: string | undefined
  /** The browser profile `login` signs in with; no local write may land inside it. */
  browserProfileDir?: string | undefined
}

/** Why a local path was refused, in `details.kind` of `PATH_OUTSIDE_ROOT`. */
export type LocalRefusal = 'outside_read_roots' | 'outside_write_roots' | 'session_files' | 'outside_folder'

function isInside(folder: string, target: string): boolean {
  const path = relative(folder, target)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

/** The real path of `path`, or of its nearest existing ancestor with the rest appended. */
async function realOrNearest(path: string): Promise<string> {
  const absolute = resolve(path)
  try {
    return await realpath(absolute)
  } catch {
    const parent = dirname(absolute)
    if (parent === absolute) return absolute
    return join(await realOrNearest(parent), basename(absolute))
  }
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
   * The path a local read should open: its real path when read roots are set and it lies
   * inside one, else `PATH_OUTSIDE_ROOT`. Without read roots the path is returned as given, so
   * a missing file still fails where it is read.
   */
  async resolveLocalRead(localPath: string): Promise<string> {
    this.assertEffect('local-read')
    if (this.#readRoots === undefined) return localPath
    const target = await realOrNearest(localPath)
    if (!this.#readRoots.some(root => isInside(root, target))) {
      throw outside(localPath, 'outside_read_roots', 'OVERLEAF_LOCAL_READ_ROOTS')
    }
    return target
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
    // Without write roots the caller's path is kept, so messages and results name what it gave.
    return this.#writeRoots === undefined ? localPath : target
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

function outside(localPath: string, kind: LocalRefusal, variable: string): McpError {
  return new McpError(
    'PATH_OUTSIDE_ROOT',
    `${localPath} is outside the folders ${variable} allows; nothing was done.`,
    { details: { kind } }
  )
}
