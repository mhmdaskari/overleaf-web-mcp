/**
 * Sets a new release version in every place step 2 of "Releasing" in AGENTS.md names, and moves
 * the `npx --yes overleaf-web-mcp@X.Y` pin when the major or minor version changes.
 *
 *   npx tsx scripts/bump-version.ts X.Y.Z
 *
 * It refuses a version that is not greater than the current one, and changes nothing unless every
 * place it expects is found. It does not touch CHANGELOG.md, commit, or tag.
 */
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** One file's new text; `path` is relative to the repository root, with `/` separators. */
export interface FileChange {
  path: string
  before: string
  after: string
}

export class BumpError extends Error {}

type Version = [major: number, minor: number, patch: number]

export function parseVersion(text: string): Version | undefined {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(text)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined
}

export function compareVersions(a: Version, b: Version): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
}

interface Versioned {
  version?: unknown
}

interface PackageJson extends Versioned {
  name?: unknown
}

interface PackageLock extends Versioned {
  packages?: Record<string, Versioned>
}

interface ServerJson extends Versioned {
  packages?: Array<Versioned & { identifier?: unknown }>
}

function json<T>(text: string, path: string): T {
  try {
    return JSON.parse(text) as T
  } catch {
    throw new BumpError(`${path} is not valid JSON.`)
  }
}

/** The repository's own formatting for these files: two-space indent and a final newline. */
function stringify(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/** Every file change the bump to `next` needs, computed without writing anything. */
export async function planVersionBump(root: string, next: string): Promise<FileChange[]> {
  const nextVersion = parseVersion(next)
  if (!nextVersion) throw new BumpError(`"${next}" is not a version of the form X.Y.Z.`)

  const read = async (path: string) => ({ path, before: await readFile(join(root, ...path.split('/')), 'utf8') })

  const packageFile = await read('package.json')
  const packageJson = json<PackageJson>(packageFile.before, packageFile.path)
  const current = String(packageJson.version)
  const currentVersion = parseVersion(current)
  if (!currentVersion) throw new BumpError(`package.json has version "${current}", which is not of the form X.Y.Z.`)
  if (compareVersions(nextVersion, currentVersion) <= 0) {
    throw new BumpError(`${next} is not greater than the current version ${current}; nothing was changed.`)
  }

  const changes: FileChange[] = []
  packageJson.version = next
  changes.push({ ...packageFile, after: stringify(packageJson) })

  const lockFile = await read('package-lock.json')
  const lock = json<PackageLock>(lockFile.before, lockFile.path)
  const lockRoot = lock.packages?.['']
  if (lockRoot === undefined) throw new BumpError('package-lock.json has no root package entry.')
  lock.version = next
  lockRoot.version = next
  changes.push({ ...lockFile, after: stringify(lock) })

  const versionFile = await read('src/version.ts')
  const serverVersion = /^export const SERVER_VERSION = '[^']*'$/mu
  if (!serverVersion.test(versionFile.before)) throw new BumpError('src/version.ts has no SERVER_VERSION line.')
  changes.push({
    ...versionFile,
    after: versionFile.before.replace(serverVersion, `export const SERVER_VERSION = '${next}'`),
  })

  const serverFile = await read('server.json')
  const server = json<ServerJson>(serverFile.before, serverFile.path)
  const entries = (Array.isArray(server.packages) ? server.packages : []).filter(
    entry => entry.identifier === packageJson.name
  )
  if (entries.length === 0) throw new BumpError(`server.json lists no package entry for ${String(packageJson.name)}.`)
  server.version = next
  for (const entry of entries) entry.version = next
  changes.push({ ...serverFile, after: stringify(server) })

  if (nextVersion[0] !== currentVersion[0] || nextVersion[1] !== currentVersion[1]) {
    const from = `${currentVersion[0]}.${currentVersion[1]}`
    const to = `${nextVersion[0]}.${nextVersion[1]}`
    // `@1.1` but not `@1.10` or `@1.1.0`; a pin may end a sentence.
    const pin = new RegExp(`(overleaf-web-mcp@)${escape(from)}(?!\\.?\\d)`, 'gu')
    const skills = (await readdir(join(root, 'skills'), { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .map(entry => `skills/${entry.name}/SKILL.md`)
      .sort()
    for (const path of [...skills, 'docs/cli.md', 'test/skills.test.ts']) {
      const file = await read(path)
      if (file.before.search(pin) === -1) throw new BumpError(`${path} has no overleaf-web-mcp@${from} pin to move.`)
      let after = file.before.replace(pin, `$1${to}`)
      // The skills also say in words which releases they are pinned to.
      if (path.startsWith('skills/'))
        after = after.replace(new RegExp(`\\b${escape(from)} releases\\b`, 'gu'), `${to} releases`)
      changes.push({ ...file, after })
    }
  }

  return changes.filter(change => change.after !== change.before)
}

/** Writes the bump to `next` and returns the paths it changed. */
export async function bumpVersion(root: string, next: string): Promise<string[]> {
  const changes = await planVersionBump(root, next)
  for (const change of changes) await writeFile(join(root, ...change.path.split('/')), change.after)
  return changes.map(change => change.path)
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.length !== 1) {
    process.stderr.write('Usage: npx tsx scripts/bump-version.ts X.Y.Z\n')
    process.exitCode = 1
    return
  }
  const root = fileURLToPath(new URL('..', import.meta.url))
  try {
    for (const path of await bumpVersion(root, args[0]!)) process.stdout.write(`changed ${path}\n`)
  } catch (error) {
    if (!(error instanceof BumpError)) throw error
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
