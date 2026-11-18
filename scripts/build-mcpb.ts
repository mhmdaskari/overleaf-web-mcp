/**
 * Builds the Claude Desktop extension, `overleaf-web-mcp-X.Y.Z.mcpb`, from the same `dist/` the
 * npm package ships, then checks what went into it.
 *
 *   npm run build && npx tsx scripts/build-mcpb.ts
 *
 * It copies the built output, `package.json`, `package-lock.json`, `manifest.json`, and `LICENSE`
 * to a clean folder, installs the production dependencies there with
 * `npm ci --omit=dev --ignore-scripts`, validates the manifest and packs the folder with the
 * pinned `mcpb` command line, and lists the packed file: anything outside the built output and the
 * production dependencies fails the build and removes the file. The bundle is written to `build/`.
 * The publish workflow runs it and attaches the file to the GitHub Release.
 */
import { execFileSync } from 'node:child_process'
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** The `mcpb` command line, run through npx at this exact version. */
export const MCPB_PACKAGE = '@anthropic-ai/mcpb@2.1.2'

/** Paths every bundle must contain. */
export const REQUIRED_BUNDLE_FILES = ['manifest.json', 'package.json', 'LICENSE', 'dist/cli.js'] as const

/** What is copied into the folder that is packed, besides the production dependencies. */
const STAGED = ['dist', 'package.json', 'package-lock.json', 'manifest.json', 'LICENSE'] as const

/**
 * Left out of the packed folder: declarations, source maps, and the command links npm makes for
 * dependencies (`tldts` has one), none of which the server loads.
 */
const IGNORED = ['*.d.ts', '*.d.ts.map', '*.js.map', 'node_modules/.bin/']

/** Top-level files a bundle may hold besides `dist/` and `node_modules/`. */
const TOP_LEVEL = new Set(['manifest.json', 'package.json', 'package-lock.json', 'LICENSE'])

interface LockFile {
  packages?: Record<string, { dev?: boolean; [key: string]: unknown }>
}

export interface ExtensionManifest {
  version?: unknown
  server: { mcp_config: { env?: Record<string, string> } }
  user_config?: Record<string, { default?: string | number | boolean }>
}

/**
 * The environment an extension host gives the server: each `${user_config.key}` replaced by the
 * user's value or, failing that, the manifest's default. A key with neither stays the literal
 * placeholder, as in the `mcpb` reference implementation, so every setting needs a default.
 */
export function extensionEnvironment(
  manifest: ExtensionManifest,
  values: Readonly<Record<string, string>> = {}
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(manifest.server.mcp_config.env ?? {}).map(([name, value]) => [
      name,
      value.replace(/\$\{user_config\.([^}]+)\}/gu, (placeholder, key: string) => {
        const given = values[key] ?? manifest.user_config?.[key]?.default
        return given === undefined ? placeholder : String(given)
      }),
    ])
  )
}

export function bundleFileName(packageJson: { name: string; version: string }): string {
  return `${packageJson.name}-${packageJson.version}.mcpb`
}

/** The `node_modules/...` paths of every package `npm ci --omit=dev` installs. */
export function productionPackages(lock: LockFile): Set<string> {
  return new Set(
    Object.entries(lock.packages ?? {})
      .filter(([path, entry]) => path !== '' && entry.dev !== true)
      .map(([path]) => path)
  )
}

/** The package folder a path under `node_modules/` belongs to, nested packages included. */
function packageOf(path: string): string | undefined {
  return /^(?:node_modules\/(?:@[^/]+\/)?[^/@][^/]*\/?)+/u
    .exec(path)?.[0]
    .replace(/\/$/u, '')
    .replace(/\/node_modules$/u, '')
}

/** Every problem with a bundle's file list; empty when it is fit to publish. */
export function bundleProblems(paths: readonly string[], production: ReadonlySet<string>): string[] {
  const present = new Set(paths)
  const allowed = (path: string): boolean => {
    if (TOP_LEVEL.has(path) || path.startsWith('dist/')) return true
    if (path === 'node_modules/.package-lock.json') return true
    if (!path.startsWith('node_modules/')) return false
    const owner = packageOf(path)
    return owner !== undefined && production.has(owner)
  }
  return [
    ...REQUIRED_BUNDLE_FILES.filter(path => !present.has(path)).map(path => `missing ${path}`),
    ...paths.filter(path => !allowed(path)).map(path => `must not bundle ${path}`),
  ]
}

/** The names of the files in a zip archive, read from its central directory. */
export function zipEntryNames(zip: Buffer): string[] {
  const END = 0x06054b50
  const ENTRY = 0x02014b50
  let end = -1
  for (let at = zip.length - 22; at >= Math.max(0, zip.length - 22 - 0xffff); at -= 1) {
    if (zip.readUInt32LE(at) === END) {
      end = at
      break
    }
  }
  if (end < 0) throw new Error('The bundle is not a zip archive.')
  const count = zip.readUInt16LE(end + 10)
  let at = zip.readUInt32LE(end + 16)
  const names: string[] = []
  for (let index = 0; index < count; index += 1) {
    if (zip.readUInt32LE(at) !== ENTRY) throw new Error('The bundle is not a zip archive: its directory is damaged.')
    const nameLength = zip.readUInt16LE(at + 28)
    const extraLength = zip.readUInt16LE(at + 30)
    const commentLength = zip.readUInt16LE(at + 32)
    names.push(zip.toString('utf8', at + 46, at + 46 + nameLength))
    at += 46 + nameLength + extraLength + commentLength
  }
  return names.filter(name => !name.endsWith('/'))
}

/** Runs npm or npx with its output passed straight through; they are .cmd scripts on Windows. */
function run(command: 'npm' | 'npx', args: readonly string[], cwd: string): void {
  execFileSync(command, args, { cwd, stdio: ['ignore', 'inherit', 'inherit'], shell: process.platform === 'win32' })
}

/** Runs this Node.js on the staged server and returns what it printed on stdout. */
function node(args: readonly string[], cwd: string, env: Record<string, string>): string {
  return execFileSync(process.execPath, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, ...env },
  })
}

async function main(): Promise<void> {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
    name: string
    version: string
  }
  const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as ExtensionManifest
  if (manifest.version !== packageJson.version) {
    throw new Error(`manifest.json has version ${String(manifest.version)}, package.json ${packageJson.version}.`)
  }
  if (!(await stat(join(root, 'dist', 'cli.js')).catch(() => undefined))) {
    throw new Error('dist/cli.js is missing: run npm run build first.')
  }

  const output = join(root, 'build')
  const stage = join(output, 'mcpb')
  const bundle = join(output, bundleFileName(packageJson))
  await rm(stage, { recursive: true, force: true })
  await rm(bundle, { force: true })
  await mkdir(stage, { recursive: true })
  for (const path of STAGED) await cp(join(root, path), join(stage, path), { recursive: true })
  await writeFile(join(stage, '.mcpbignore'), `${IGNORED.join('\n')}\n`)

  run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], stage)

  // The server as the host starts it, with every setting at its default, from the production
  // dependencies alone: the command line reads its configuration, and the MCP server loads.
  const env = extensionEnvironment(manifest)
  const capabilities = JSON.parse(node(['dist/cli.js', 'capabilities'], stage, env)) as {
    version?: unknown
  }
  if (capabilities.version !== packageJson.version) throw new Error('The staged server reports another version.')
  node(['--input-type=module', '--eval', "await import('./dist/server.js')"], stage, env)

  run('npx', ['--yes', MCPB_PACKAGE, 'validate', 'manifest.json'], stage)
  run('npx', ['--yes', MCPB_PACKAGE, 'pack', '.', bundle], stage)

  const lock = JSON.parse(await readFile(join(stage, 'package-lock.json'), 'utf8')) as LockFile
  const names = zipEntryNames(await readFile(bundle))
  const problems = bundleProblems(names, productionPackages(lock))
  if (problems.length > 0) {
    await rm(bundle, { force: true })
    throw new Error(`The bundle was removed:\n${problems.join('\n')}`)
  }
  const { size } = await stat(bundle)
  process.stdout.write(`${bundle}: ${names.length} files, ${(size / 1024 / 1024).toFixed(1)} MB, all allowed.\n`)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main()
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
