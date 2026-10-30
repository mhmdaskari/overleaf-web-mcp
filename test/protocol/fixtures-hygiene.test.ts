import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, test } from 'vitest'

const fixtures = fileURLToPath(new URL('../fixtures/protocol/', import.meta.url))

async function fixtureFiles(folder: string): Promise<string[]> {
  const entries = await readdir(folder, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map(async entry => {
      const path = join(folder, entry.name)
      return entry.isDirectory() ? await fixtureFiles(path) : [path]
    })
  )
  return nested.flat().sort()
}

// Mongo ObjectIds are 24 hex characters; the cookie names are the session cookies Overleaf and its
// load balancer set. None of them belongs in a captured frame.
const OBJECT_ID = /[0-9a-f]{24}/i
const COOKIE_NAMES = ['overleaf_session2', 'sharelatex.sid', 'GCLB', 'connect.sid']

describe('protocol fixture hygiene', () => {
  test('finds the protocol fixtures', async () => {
    const files = await fixtureFiles(fixtures)
    expect(files.map(file => relative(fixtures, file))).toEqual(
      expect.arrayContaining([
        'history-ot-frames.json',
        'history-ot-tracked-changes.json',
        'sharejs-frames.json',
        'sharejs-tracked-changes.json',
      ])
    )
  })

  test('holds no ids, email addresses, or session cookie names', async () => {
    for (const file of await fixtureFiles(fixtures)) {
      const name = relative(fixtures, file)
      const text = await readFile(file, 'utf8')
      expect(OBJECT_ID.test(text), `${name} holds a 24-hex id`).toBe(false)
      expect(text.includes('@'), `${name} holds an @`).toBe(false)
      for (const cookie of COOKIE_NAMES) {
        expect(text.includes(cookie), `${name} names the ${cookie} cookie`).toBe(false)
      }
    }
  })
})
