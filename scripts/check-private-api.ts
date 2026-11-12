/**
 * Checks that every Overleaf route and socket message `docs/private-api.md` lists is still
 * declared in Overleaf's source, so a change upstream is found before a user's call fails.
 *
 *   npx tsx scripts/check-private-api.ts
 *
 * It reads the routes from every table headed "Method and route" and the messages from the table
 * headed "Message", fetches `services/web/app/src/router.mjs` from `overleaf/overleaf`, the feature
 * routers it imports, and each file the messages table names, and checks presence only. Routes
 * marked † are not in Overleaf's public source and are counted, named, and skipped. It exits 1
 * with one line per missing entry or unreadable file. It needs no Overleaf account and no secret.
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const SOURCE_REPOSITORY = 'overleaf/overleaf'
export const WEB_ROUTER = 'services/web/app/src/router.mjs'
const UNCHECKED_MARK = '†'
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'WS'] as const

export interface CatalogueRoute {
  method: string
  /** The path without its query string. */
  path: string
  line: number
  /** False for a route marked † as absent from Overleaf's public source. */
  checked: boolean
}

export interface CatalogueMessage {
  name: string
  /** The file of `overleaf/overleaf` that declares it. */
  file: string
  line: number
}

export interface Catalogue {
  routes: CatalogueRoute[]
  messages: CatalogueMessage[]
  /** Entries written in a form the parser cannot read; a non-empty list fails the check. */
  problems: string[]
}

function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/gu, '')
    .split('|')
    .map(cell => cell.trim())
}

function codeSpans(cell: string): string[] {
  return [...cell.matchAll(/`([^`]+)`/gu)].map(match => match[1]!)
}

/** Reads the routes and messages of `docs/private-api.md`. */
export function parseCatalogue(markdown: string): Catalogue {
  const catalogue: Catalogue = { routes: [], messages: [], problems: [] }
  let table: 'routes' | 'messages' | 'other' | undefined
  const route = new RegExp(`^(${METHODS.join('|')}) (/[\\w:.\\-/]*)(\\?\\S*)?$`, 'u')

  markdown.split('\n').forEach((text, index) => {
    const line = index + 1
    if (!text.trimStart().startsWith('|')) {
      table = undefined
      return
    }
    const row = cells(text)
    if (table === undefined) {
      table = row[0] === 'Method and route' ? 'routes' : row[0] === 'Message' ? 'messages' : 'other'
      return
    }
    if (table === 'other' || /^:?-+:?$/u.test(row[0] ?? '')) return

    if (table === 'routes') {
      const first = row[0] ?? ''
      const spans = codeSpans(first)
      const between = first
        .replace(/`[^`]+`/gu, '')
        .replace(/\band\b/gu, '')
        .replace(new RegExp(`[\\s,${UNCHECKED_MARK}]`, 'gu'), '')
      if (spans.length === 0 || between !== '') {
        catalogue.problems.push(`line ${line}: write each route as its own \`METHOD /path\` code span`)
        return
      }
      for (const span of spans) {
        const match = route.exec(span)
        if (!match) {
          catalogue.problems.push(`line ${line}: cannot read the route \`${span}\``)
          continue
        }
        catalogue.routes.push({
          method: match[1]!,
          path: match[2]!,
          line,
          checked: !first.includes(UNCHECKED_MARK),
        })
      }
      return
    }

    const [name] = codeSpans(row[0] ?? '')
    const [file] = codeSpans(row[2] ?? '')
    if (
      codeSpans(row[0] ?? '').length !== 1 ||
      name === undefined ||
      !/^[A-Za-z][\w.-]*$/u.test(name) ||
      file === undefined ||
      !/^services\/[\w./-]+\.m?js$/u.test(file)
    ) {
      catalogue.problems.push(`line ${line}: write a message as \`name\` with the \`services/...\` file declaring it`)
      return
    }
    catalogue.messages.push({ name, file, line })
  })

  return catalogue
}

/** The feature routers `router.mjs` imports, as repository paths. */
export function featureRouters(routerSource: string): string[] {
  return [...routerSource.matchAll(/from\s+'\.\/(Features\/[\w/]+Router\.mjs)'/gu)]
    .map(match => `services/web/app/src/${match[1]!}`)
    .sort()
}

/** A path a router file declares; `method` is absent when the path is not passed to it directly. */
export interface DeclaredPath {
  path: string
  method?: string
}

/**
 * The paths a router file declares. A path passed straight to `webRouter.get(...)` and the like
 * carries its method. One held in a variable or looped over, as Overleaf does for the upload
 * route and the dashboard, is still a path literal and carries none. A path passed straight to
 * another router, such as the private API's, is left out.
 */
export function declaredPaths(source: string): DeclaredPath[] {
  const direct = new Map<number, { router: string; method: string }>()
  for (const match of source.matchAll(/\b(\w+)\.(get|post|put|patch|delete)\(\s*(?=['"`]\/)/gu)) {
    direct.set(match.index + match[0].length, { router: match[1]!, method: match[2]!.toUpperCase() })
  }
  const paths: DeclaredPath[] = []
  for (const match of source.matchAll(/(['"`])(\/[^'"`\s]*)\1/gu)) {
    const call = direct.get(match.index)
    if (call === undefined) paths.push({ path: match[2]! })
    else if (call.router === 'webRouter') paths.push({ path: match[2]!, method: call.method })
  }
  return paths
}

/**
 * A catalogue path matches a declared one segment by segment: a `:name` matches a parameter
 * under any name (`:id` and `:Project_id`, `:file` and `:file(.+)`), and a fixed segment the
 * same fixed segment, ignoring case as Express does. A parameter never matches a fixed segment,
 * so `/project/:id/upload` is not satisfied by `/project/new/upload`.
 */
export function pathMatches(cataloguePath: string, declaredPath: string): boolean {
  const wanted = cataloguePath.split('/')
  const declared = declaredPath.split('/')
  if (wanted.length !== declared.length) return false
  return wanted.every((segment, index) => {
    const other = declared[index]!
    return segment.startsWith(':')
      ? other.startsWith(':')
      : !other.startsWith(':') && segment.toLowerCase() === other.toLowerCase()
  })
}

/**
 * A route is declared when a direct declaration has its method and path, or, when no direct
 * declaration has its path under any method, when its path is declared indirectly. So a route
 * whose path survives only under another method is reported missing.
 */
export function routeDeclared(route: CatalogueRoute, declared: readonly DeclaredPath[]): boolean {
  const matching = declared.filter(entry => pathMatches(route.path, entry.path))
  const direct = matching.filter(entry => entry.method !== undefined)
  if (direct.length > 0) return direct.some(entry => entry.method === route.method)
  return matching.length > 0
}

export type FetchSource = (path: string) => Promise<string | undefined>

export interface CheckResult {
  /** One line per missing route or message and per source file that could not be read. */
  failures: string[]
  checkedRoutes: number
  checkedMessages: number
  skippedRoutes: CatalogueRoute[]
}

export async function checkCatalogue(catalogue: Catalogue, fetchSource: FetchSource): Promise<CheckResult> {
  const failures = [...catalogue.problems]
  const sources = new Map<string, string | undefined>()
  const load = async (path: string): Promise<string | undefined> => {
    if (!sources.has(path)) sources.set(path, await fetchSource(path))
    return sources.get(path)
  }

  const routes = catalogue.routes.filter(entry => entry.checked)
  const skippedRoutes = catalogue.routes.filter(entry => !entry.checked)
  const router = await load(WEB_ROUTER)
  if (router === undefined) {
    failures.push(`could not read ${WEB_ROUTER} from ${SOURCE_REPOSITORY}`)
  } else {
    const files = [WEB_ROUTER, ...featureRouters(router)]
    const declared: DeclaredPath[] = []
    for (const file of files) {
      const source = await load(file)
      if (source === undefined) failures.push(`could not read ${file} from ${SOURCE_REPOSITORY}`)
      else declared.push(...declaredPaths(source))
    }
    for (const entry of routes) {
      if (!routeDeclared(entry, declared)) {
        failures.push(
          `missing route ${entry.method} ${entry.path} (docs/private-api.md line ${entry.line}); searched ${WEB_ROUTER} and the ${files.length - 1} feature routers it imports`
        )
      }
    }
  }

  for (const message of catalogue.messages) {
    const source = await load(message.file)
    if (source === undefined) {
      if (!failures.includes(`could not read ${message.file} from ${SOURCE_REPOSITORY}`)) {
        failures.push(`could not read ${message.file} from ${SOURCE_REPOSITORY}`)
      }
    } else if (!source.includes(`'${message.name}'`) && !source.includes(`"${message.name}"`)) {
      failures.push(
        `missing socket message ${message.name} (docs/private-api.md line ${message.line}); searched ${message.file}`
      )
    }
  }

  return { failures, checkedRoutes: routes.length, checkedMessages: catalogue.messages.length, skippedRoutes }
}

export function renderResult(result: CheckResult): string {
  const skipped = result.skippedRoutes.map(entry => `${entry.method} ${entry.path}`).join(', ')
  const summary =
    `Checked ${result.checkedRoutes} routes and ${result.checkedMessages} socket messages against ${SOURCE_REPOSITORY}; ` +
    `${result.skippedRoutes.length} routes marked † are not in its public source and were skipped` +
    (skipped === '' ? '.' : `: ${skipped}.`)
  return [...result.failures, summary].join('\n') + '\n'
}

/** Fetches a file of `overleaf/overleaf` at its default branch; undefined when it cannot. */
export async function fetchFromGitHub(path: string): Promise<string | undefined> {
  try {
    const response = await fetch(`https://raw.githubusercontent.com/${SOURCE_REPOSITORY}/HEAD/${path}`)
    return response.ok ? await response.text() : undefined
  } catch {
    return undefined
  }
}

/** The check as the command runs it: 1 with the report on stderr when anything failed, else 0. */
export async function runCheck(
  markdown: string,
  fetchSource: FetchSource
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const result = await checkCatalogue(parseCatalogue(markdown), fetchSource)
  const output = renderResult(result)
  return result.failures.length > 0
    ? { exitCode: 1, stdout: '', stderr: output }
    : { exitCode: 0, stdout: output, stderr: '' }
}

async function main(): Promise<void> {
  const markdown = await readFile(fileURLToPath(new URL('../docs/private-api.md', import.meta.url)), 'utf8')
  const { exitCode, stdout, stderr } = await runCheck(markdown, fetchFromGitHub)
  process.stdout.write(stdout)
  process.stderr.write(stderr)
  process.exitCode = exitCode
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
