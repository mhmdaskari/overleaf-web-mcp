/**
 * Writes a shields.io endpoint badge with the all-time npm download count of a package.
 *
 *   node scripts/npm-downloads.ts <output.json> [package]
 *
 * npm's downloads API answers a range longer than 18 months by silently cutting it to the last
 * 18 months, so the total is summed over one-year ranges from the day the package was created (or
 * from 2015-01-10, when npm's counts begin), and each answer must cover exactly the range asked for. The weekly `Download count` workflow
 * runs this and publishes the file to the `badges` branch, which the README and docs badges read.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

export interface DateRange {
  start: string
  end: string
}

export interface EndpointBadge {
  schemaVersion: 1
  label: string
  message: string
  color: string
}

type Fetcher = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

const DAY_MS = 24 * 60 * 60 * 1000
/** Well inside npm's 18-month limit for one range. */
const MAX_RANGE_DAYS = 365
/** npm keeps no download counts before this day; a range starting earlier is moved to it. */
export const NPM_STATS_FIRST_DAY = '2015-01-10'

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/** Splits [first, last] (inclusive UTC days, YYYY-MM-DD) into consecutive ranges of at most maxDays. */
export function dayRanges(first: string, last: string, maxDays = MAX_RANGE_DAYS): DateRange[] {
  const end = Date.parse(`${last}T00:00:00Z`)
  let start = Date.parse(`${first}T00:00:00Z`)
  if (Number.isNaN(start) || Number.isNaN(end) || start > end) {
    throw new Error(`Invalid day range ${first}..${last}`)
  }
  const ranges: DateRange[] = []
  while (start <= end) {
    const chunkEnd = Math.min(start + (maxDays - 1) * DAY_MS, end)
    ranges.push({ start: isoDay(new Date(start)), end: isoDay(new Date(chunkEnd)) })
    start = chunkEnd + DAY_MS
  }
  return ranges
}

/** Formats a count the way shields.io formats npm download badges: 950, 1.8k, 12k, 3.4M. */
export function compactCount(count: number): string {
  if (count < 1e3) return String(count)
  const units: Array<[number, string]> = [
    [1e3, 'k'],
    [1e6, 'M'],
    [1e9, 'B'],
  ]
  let formatted = ''
  for (const [size, suffix] of units) {
    const value = count / size
    const rounded = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10
    formatted = `${rounded}${suffix}`
    // Rounding can reach 1000 of a unit (999,999 is 1000k); the next unit then reads 1M.
    if (rounded < 1000) break
  }
  return formatted
}

async function getJson(fetcher: Fetcher, url: string): Promise<unknown> {
  const response = await fetcher(url)
  if (!response.ok) throw new Error(`GET ${url} failed with HTTP ${response.status}`)
  return await response.json()
}

/** The UTC day npm records as the package's creation. */
export async function packageCreatedDay(name: string, fetcher: Fetcher): Promise<string> {
  const doc = (await getJson(fetcher, `https://registry.npmjs.org/${encodeURIComponent(name)}`)) as {
    time?: { created?: unknown }
  }
  const created = doc.time?.created
  if (typeof created !== 'string' || Number.isNaN(Date.parse(created))) {
    throw new Error(`The registry gave no creation time for ${name}`)
  }
  return isoDay(new Date(created))
}

/** Sums downloads over every range, refusing any answer that covers a different range. */
export async function totalDownloads(name: string, ranges: DateRange[], fetcher: Fetcher): Promise<number> {
  let total = 0
  for (const range of ranges) {
    const url = `https://api.npmjs.org/downloads/point/${range.start}:${range.end}/${encodeURIComponent(name)}`
    const body = (await getJson(fetcher, url)) as { downloads?: unknown; start?: unknown; end?: unknown }
    if (typeof body.downloads !== 'number' || !Number.isInteger(body.downloads) || body.downloads < 0) {
      throw new Error(`npm returned no download count for ${range.start}:${range.end}`)
    }
    if (body.start !== range.start || body.end !== range.end) {
      throw new Error(
        `npm answered ${String(body.start)}:${String(body.end)} for ${range.start}:${range.end}; refusing a partial total`
      )
    }
    total += body.downloads
  }
  return total
}

export function downloadsBadge(total: number): EndpointBadge {
  return { schemaVersion: 1, label: 'downloads', message: compactCount(total), color: '1F6FEB' }
}

async function main(): Promise<void> {
  const [output, nameArgument] = process.argv.slice(2)
  if (output === undefined) throw new Error('Usage: node scripts/npm-downloads.ts <output.json> [package]')
  const name =
    nameArgument ?? (JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { name: string }).name
  const fetcher: Fetcher = url => fetch(url, { headers: { accept: 'application/json' } })
  const created = await packageCreatedDay(name, fetcher)
  const first = created < NPM_STATS_FIRST_DAY ? NPM_STATS_FIRST_DAY : created
  const total = await totalDownloads(name, dayRanges(first, isoDay(new Date())), fetcher)
  await writeFile(output, `${JSON.stringify(downloadsBadge(total), null, 2)}\n`)
  process.stdout.write(`${name}: ${total} downloads since ${created}\n`)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
