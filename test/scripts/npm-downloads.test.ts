import { describe, expect, test } from 'vitest'

import {
  compactCount,
  dayRanges,
  downloadsBadge,
  packageCreatedDay,
  totalDownloads,
} from '../../scripts/npm-downloads.js'

function fakeFetch(answer: (url: string) => { status?: number; body: unknown }) {
  const urls: string[] = []
  const fetcher = async (url: string) => {
    urls.push(url)
    const { status = 200, body } = answer(url)
    return { ok: status >= 200 && status < 300, status, json: async () => body }
  }
  return { fetcher, urls }
}

/** Echoes the requested range, as npm does for a range it can answer in full. */
function echoRange(downloads: (start: string) => number) {
  return fakeFetch(url => {
    const [, start, end] = /point\/(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2})\//u.exec(url)!
    return { body: { downloads: downloads(start!), start, end, package: 'pkg' } }
  })
}

describe('npm download badge', () => {
  test('splits a period into consecutive ranges of at most a year', () => {
    expect(dayRanges('2026-07-14', '2026-10-06')).toEqual([{ start: '2026-07-14', end: '2026-10-06' }])
    expect(dayRanges('2024-01-01', '2026-03-01')).toEqual([
      { start: '2024-01-01', end: '2024-12-30' },
      { start: '2024-12-31', end: '2025-12-30' },
      { start: '2025-12-31', end: '2026-03-01' },
    ])
    expect(dayRanges('2026-10-06', '2026-10-06')).toEqual([{ start: '2026-10-06', end: '2026-10-06' }])
    expect(() => dayRanges('2026-10-07', '2026-10-06')).toThrow(/Invalid day range/u)
  })

  test('sums every range', async () => {
    const counts: Record<string, number> = { '2024-01-01': 1000, '2024-12-31': 700, '2025-12-31': 101 }
    const { fetcher, urls } = echoRange(start => counts[start] ?? 0)
    const ranges = dayRanges('2024-01-01', '2026-03-01')

    await expect(totalDownloads('pkg', ranges, fetcher)).resolves.toBe(1801)
    expect(urls).toEqual(ranges.map(r => `https://api.npmjs.org/downloads/point/${r.start}:${r.end}/pkg`))
  })

  test('refuses an answer that covers a shorter range than asked', async () => {
    // npm cuts a range longer than 18 months to its last 18 months without an error.
    const { fetcher } = fakeFetch(() => ({
      body: { downloads: 5, start: '2025-04-06', end: '2026-10-06', package: 'pkg' },
    }))

    await expect(
      totalDownloads('pkg', [{ start: '2020-01-01', end: '2026-10-06' }], fetcher)
    ).rejects.toThrow(/refusing a partial total/u)
  })

  test('fails on an HTTP error or a missing count instead of reporting zero', async () => {
    const range = [{ start: '2026-07-14', end: '2026-10-06' }]
    await expect(totalDownloads('pkg', range, fakeFetch(() => ({ status: 503, body: {} })).fetcher)).rejects.toThrow(
      /HTTP 503/u
    )
    await expect(
      totalDownloads('pkg', range, fakeFetch(() => ({ body: { error: 'package pkg not found' } })).fetcher)
    ).rejects.toThrow(/no download count/u)
  })

  test('reads the creation day from the registry', async () => {
    const { fetcher, urls } = fakeFetch(() => ({ body: { time: { created: '2026-07-14T23:48:43.663Z' } } }))

    await expect(packageCreatedDay('@scope/pkg', fetcher)).resolves.toBe('2026-07-14')
    expect(urls).toEqual(['https://registry.npmjs.org/%40scope%2Fpkg'])
    await expect(packageCreatedDay('pkg', fakeFetch(() => ({ body: {} })).fetcher)).rejects.toThrow(/no creation time/u)
  })

  test('formats counts like the shields.io npm badges', () => {
    expect(
      [0, 950, 1000, 1801, 12_345, 999_499, 999_999, 3_400_000, 1_137_117_703].map(compactCount)
    ).toEqual(['0', '950', '1k', '1.8k', '12k', '999k', '1M', '3.4M', '1.1B'])
  })

  test('writes a shields.io endpoint badge', () => {
    expect(downloadsBadge(1801)).toEqual({ schemaVersion: 1, label: 'downloads', message: '1.8k', color: '1F6FEB' })
  })
})
