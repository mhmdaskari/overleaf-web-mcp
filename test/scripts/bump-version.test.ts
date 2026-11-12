import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, test } from 'vitest'

import { bumpVersion, compareVersions, parseVersion, planVersionBump } from '../../scripts/bump-version.js'

const repository = fileURLToPath(new URL('../../', import.meta.url))
const current = (JSON.parse(await readFile(join(repository, 'package.json'), 'utf8')) as { version: string }).version
const [major, minor, patch] = parseVersion(current)!
const pin = `overleaf-web-mcp@${major}.${minor}`

/** The files step 2 of "Releasing" names, as the release step lists them. */
const STEP_TWO_FILES = [
  'package.json',
  'package-lock.json',
  'src/version.ts',
  'server.json',
  'skills/overleaf-reviewer-comments/SKILL.md',
  'skills/overleaf-revise-manuscript/SKILL.md',
  'skills/overleaf-sync-sources/SKILL.md',
  'docs/cli.md',
  'test/skills.test.ts',
]

const folders: string[] = []

/** A temporary copy of the files the bump reads, plus one it must leave alone. */
async function copyOfRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'overleaf-bump-version-'))
  folders.push(root)
  for (const path of [...STEP_TWO_FILES, 'CHANGELOG.md']) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await cp(join(repository, path), join(root, path))
  }
  return root
}

async function snapshot(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {}
  for (const path of [...STEP_TWO_FILES, 'CHANGELOG.md']) files[path] = await readFile(join(root, path), 'utf8')
  return files
}

afterEach(async () => {
  await Promise.all(folders.splice(0).map(async folder => await rm(folder, { recursive: true, force: true })))
})

describe('version parsing', () => {
  test('accepts only X.Y.Z and orders numerically', () => {
    expect(parseVersion('1.10.0')).toEqual([1, 10, 0])
    for (const text of ['1.1', 'v1.1.0', '1.1.0-rc.1', '01.1.0', '1.1.0 '])
      expect(parseVersion(text), text).toBeUndefined()
    expect(compareVersions([1, 10, 0], [1, 9, 9])).toBeGreaterThan(0)
    expect(compareVersions([1, 1, 0], [1, 1, 0])).toBe(0)
  })
})

describe('bump-version', () => {
  test('a patch sets the version in four files and leaves the pins alone', async () => {
    const root = await copyOfRepository()
    const next = `${major}.${minor}.${patch + 1}`
    expect(await bumpVersion(root, next)).toEqual([
      'package.json',
      'package-lock.json',
      'src/version.ts',
      'server.json',
    ])

    const read = async <T>(path: string) => JSON.parse(await readFile(join(root, path), 'utf8')) as T
    const packageJson = await read<{ version: string }>('package.json')
    const lock = await read<{ version: string; packages: Record<string, { version: string }> }>('package-lock.json')
    const server = await read<{ version: string; packages: Array<{ version: string }> }>('server.json')
    expect(packageJson.version).toBe(next)
    expect([lock.version, lock.packages['']!.version]).toEqual([next, next])
    expect([server.version, ...server.packages.map(entry => entry.version)]).toEqual([next, next])
    expect(await readFile(join(root, 'src/version.ts'), 'utf8')).toContain(`export const SERVER_VERSION = '${next}'`)
    expect(await readFile(join(root, 'docs/cli.md'), 'utf8')).toContain(pin)
  })

  test('a minor also moves every pin and the skills’ wording, and nothing else', async () => {
    const root = await copyOfRepository()
    const before = await snapshot(root)
    const next = `${major}.${minor + 1}.0`
    const nextPin = `overleaf-web-mcp@${major}.${minor + 1}`
    expect(await bumpVersion(root, next)).toEqual(STEP_TWO_FILES)

    const after = await snapshot(root)
    expect(after['CHANGELOG.md']).toBe(before['CHANGELOG.md'])
    for (const path of STEP_TWO_FILES.slice(4)) {
      expect(after[path], path).not.toContain(`${pin} `)
      expect(after[path], path).toContain(nextPin)
      // Only the pins and the wording moved: every other line is untouched.
      const changed = after[path]!.split('\n').filter((line, index) => line !== before[path]!.split('\n')[index])
      for (const line of changed) expect(line, `${path}: ${line}`).toMatch(new RegExp(`${major}\\.${minor + 1}`, 'u'))
    }
    for (const path of STEP_TWO_FILES.slice(4, 7)) {
      expect(after[path], path).not.toMatch(new RegExp(`\\b${major}\\.${minor} releases`, 'u'))
    }
  })

  test('does not move a longer pin that only starts with the current one', async () => {
    const root = await copyOfRepository()
    const path = join(root, 'docs/cli.md')
    await writeFile(path, `${await readFile(path, 'utf8')}\n${pin}0 and ${pin}.3 stay.\n`)
    await bumpVersion(root, `${major + 1}.0.0`)
    expect(await readFile(path, 'utf8')).toContain(`${pin}0 and ${pin}.3 stay.`)
  })

  test.each([
    ['the current version', current],
    [
      'an older version',
      patch > 0 ? `${major}.${minor}.${patch - 1}` : minor > 0 ? `${major}.${minor - 1}.9` : `${major - 1}.9.9`,
    ],
    ['a malformed version', `${major}.${minor}`],
  ])('refuses %s and changes nothing', async (_label, next) => {
    const root = await copyOfRepository()
    const before = await snapshot(root)
    await expect(bumpVersion(root, next)).rejects.toThrow()
    expect(await snapshot(root)).toEqual(before)
  })

  test('changes nothing when a pin it must move is missing', async () => {
    const root = await copyOfRepository()
    const path = join(root, 'test/skills.test.ts')
    await writeFile(path, (await readFile(path, 'utf8')).replaceAll(pin, 'overleaf-web-mcp@latest'))
    const before = await snapshot(root)
    await expect(planVersionBump(root, `${major}.${minor + 1}.0`)).rejects.toThrow(/test\/skills\.test\.ts has no/u)
    await expect(bumpVersion(root, `${major}.${minor + 1}.0`)).rejects.toThrow()
    expect(await snapshot(root)).toEqual(before)
  })
})
