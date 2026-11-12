/**
 * Runs the checks under "Before starting a release" in AGENTS.md that need no Overleaf session,
 * and prints one line per check. Exits 1 when any check fails.
 *
 *   npx tsx scripts/preflight.ts
 *
 * The rest of that list (Overleaf's source, the README comparison, `doctor` against a disposable
 * project) still needs a person.
 */
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** The bound `test/server.test.ts` holds `SERVER_INSTRUCTIONS` under. */
export const INSTRUCTION_WORD_LIMIT = 450

/** Words as `test/server.test.ts` counts them. */
export function instructionWords(text: string): number {
  return text.split(/\s+/u).length
}

/** A package as `npm query` reports it: one entry per installed copy. */
export interface InstalledPackage {
  name: string
  version: string
  location: string
}

export interface PreflightInputs {
  /** `npm view overleaf-web-mcp version`, or undefined when it could not be run. */
  npmVersion: string | undefined
  /** The highest `vX.Y.Z` tag, without the `v`, or undefined when there is none. */
  latestTag: string | undefined
  packageJson: { version?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
  /** The value of `SERVER_VERSION` in `src/version.ts`, or undefined when the line is missing. */
  serverVersion: string | undefined
  /** `version` and each package entry's `version` in `server.json`. */
  serverJsonVersions: string[]
  installed: InstalledPackage[]
  instructions: string
}

export interface Check {
  name: string
  ok: boolean
  detail: string
}

/** The packages the dependency checks look at, as one `npm query` selector. */
export const QUERIED_PACKAGES = [
  '@modelcontextprotocol/server',
  '@modelcontextprotocol/client',
  '@modelcontextprotocol/core',
  '@modelcontextprotocol/sdk',
  'zod',
] as const

function copies(installed: readonly InstalledPackage[], name: string): InstalledPackage[] {
  const seen = new Map<string, InstalledPackage>()
  for (const entry of installed) if (entry.name === name) seen.set(entry.location, entry)
  return [...seen.values()]
}

function majorTwo(range: string | undefined): boolean {
  return range !== undefined && /^[\^~]?2(\.|$)/u.test(range)
}

export function evaluatePreflight(inputs: PreflightInputs): Check[] {
  const checks: Check[] = []

  const version = inputs.packageJson.version
  const sources: Array<[string, string | undefined]> = [
    ['npm', inputs.npmVersion],
    ['latest tag', inputs.latestTag],
    ['package.json', version],
    ['SERVER_VERSION', inputs.serverVersion],
    ...inputs.serverJsonVersions.map((value, index): [string, string] => [
      index === 0 ? 'server.json' : `server.json package ${index}`,
      value,
    ]),
  ]
  const differing = sources.filter(([, value]) => value === undefined || value !== version)
  checks.push({
    name: 'versions agree',
    ok: version !== undefined && inputs.serverJsonVersions.length >= 2 && differing.length === 0,
    detail:
      differing.length === 0
        ? `${version} everywhere`
        : sources.map(([source, value]) => `${source} ${value ?? 'unknown'}`).join(', '),
  })

  for (const [name, field] of [
    ['@modelcontextprotocol/server', 'dependencies'],
    ['@modelcontextprotocol/client', 'devDependencies'],
  ] as const) {
    const range = inputs.packageJson[field]?.[name]
    const found = copies(inputs.installed, name)
    const ok = majorTwo(range) && found.length > 0 && found.every(entry => entry.version.startsWith('2.'))
    checks.push({
      name: `${name} is 2.x`,
      ok,
      detail: `${field} ${range ?? 'missing'}, installed ${found.map(entry => entry.version).join(', ') || 'none'}`,
    })
  }

  const sdk = copies(inputs.installed, '@modelcontextprotocol/sdk')
  checks.push({
    name: 'no @modelcontextprotocol/sdk',
    ok: sdk.length === 0,
    detail: sdk.length === 0 ? 'not installed' : sdk.map(entry => entry.location).join(', '),
  })

  for (const name of ['zod', '@modelcontextprotocol/core']) {
    const found = copies(inputs.installed, name)
    checks.push({
      name: `one copy of ${name}`,
      ok: found.length === 1,
      detail:
        found.length === 0 ? 'not installed' : found.map(entry => `${entry.version} at ${entry.location}`).join(', '),
    })
  }

  const words = instructionWords(inputs.instructions)
  checks.push({
    name: 'SERVER_INSTRUCTIONS under the word bound',
    ok: words < INSTRUCTION_WORD_LIMIT,
    detail: `${words} words, ${INSTRUCTION_WORD_LIMIT - words} under ${INSTRUCTION_WORD_LIMIT}`,
  })

  return checks
}

export interface PreflightEnvironment {
  /** Runs a command in the repository and returns its stdout; throws when it fails. */
  run: (command: string, args: string[]) => string
  instructions: () => Promise<string>
}

function attempt(run: () => string): string | undefined {
  try {
    return run().trim() || undefined
  } catch {
    return undefined
  }
}

export async function gatherPreflight(root: string, environment: PreflightEnvironment): Promise<PreflightInputs> {
  const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as PreflightInputs['packageJson']
  const versionSource = await readFile(join(root, 'src', 'version.ts'), 'utf8')
  const server = JSON.parse(await readFile(join(root, 'server.json'), 'utf8')) as {
    version?: unknown
    packages?: Array<{ version?: unknown }>
  }

  const tags = attempt(() => environment.run('git', ['tag', '--list', 'v*', '--sort=-v:refname']))
  const latestTag = tags
    ?.split('\n')
    .map(tag => tag.trim())
    .find(tag => /^v\d+\.\d+\.\d+$/u.test(tag))
    ?.slice(1)

  const query = QUERIED_PACKAGES.map(name => `[name="${name}"]`).join(', ')
  const installed = JSON.parse(environment.run('npm', ['query', query])) as InstalledPackage[]

  return {
    npmVersion: attempt(() => environment.run('npm', ['view', 'overleaf-web-mcp', 'version'])),
    latestTag,
    packageJson,
    serverVersion: /^export const SERVER_VERSION = '([^']*)'$/mu.exec(versionSource)?.[1],
    serverJsonVersions: [server.version, ...(server.packages ?? []).map(entry => entry.version)].map(String),
    installed: installed.map(({ name, version, location }) => ({ name, version, location })),
    instructions: await environment.instructions(),
  }
}

export function renderChecks(checks: readonly Check[]): string {
  return checks.map(check => `${check.ok ? 'ok  ' : 'FAIL'} ${check.name}: ${check.detail}\n`).join('')
}

async function main(): Promise<void> {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const checks = evaluatePreflight(
    await gatherPreflight(root, {
      run: (command, args) =>
        execFileSync(command, args, {
          cwd: root,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }),
      instructions: async () => (await import('../src/mcp/instructions.js')).SERVER_INSTRUCTIONS,
    })
  )
  process.stdout.write(renderChecks(checks))
  if (checks.some(check => !check.ok)) process.exitCode = 1
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
