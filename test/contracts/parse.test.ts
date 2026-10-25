import { describe, expect, test } from 'vitest'
import { z } from 'zod'

import { OPERATION_NAMES } from '../../src/contracts/operations.js'
import { parseOperationInput, unknownKeys } from '../../src/contracts/parse.js'

describe('strict operation input', () => {
  test('refuses a misspelled key instead of falling back to its default', () => {
    const input = { projectId: 'p', filePath: 'main.tex', revision: 'r', content: 'x', writemode: 'tracked' }
    expect(() => parseOperationInput('write_file', input)).toThrow(
      expect.objectContaining({ code: 'INVALID_ARGUMENT', details: { unknownKeys: ['writemode'] } })
    )
  })

  test('names unknown keys at any depth, and only those', () => {
    const input = {
      projectId: 'p',
      files: [{ localPath: '/a.png', destinationPath: 'a.png' }, { localPath: '/b.png', destinationpath: 'b.png' }],
    }
    expect(() => parseOperationInput('batch_upload', input)).toThrow(
      expect.objectContaining({ details: { unknownKeys: ['files.1.destinationpath'] } })
    )
    const comment = { projectId: 'p', filePath: 'f', revision: 'r', start: { line: 1, column: 1, col: 2 }, end: { line: 1, column: 2 }, expectedText: 'a', content: 'b' }
    expect(() => parseOperationInput('add_comment', comment)).toThrow(
      expect.objectContaining({ details: { unknownKeys: ['start.col'] } })
    )
  })

  test('applies the contract defaults, as the MCP server does', () => {
    expect(parseOperationInput('list_projects', {})).toEqual({
      includeArchived: false,
      includeTrashed: false,
      limit: 50,
      sort: 'lastUpdated',
    })
    expect(parseOperationInput('write_file', { projectId: 'p', filePath: 'f', revision: 'r', content: '' })).toMatchObject({
      writeMode: 'untracked',
    })
  })

  test('refuses any key for an operation without parameters, and anything but an object', () => {
    expect(parseOperationInput('auth_status', {})).toEqual({})
    expect(() => parseOperationInput('auth_status', { verbose: true })).toThrow(
      expect.objectContaining({ code: 'INVALID_ARGUMENT', details: { unknownKeys: ['verbose'] } })
    )
    for (const input of [null, [], 'x', 3]) {
      expect(() => parseOperationInput('read_file', input)).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }))
    }
  })

  test('reports schema violations by path without quoting the value', () => {
    const secret = 'manuscript text that must not be echoed'
    let caught: unknown
    try {
      parseOperationInput('write_file', { projectId: 'p', filePath: 'f', revision: 'r', content: 'x', writeMode: secret })
    } catch (error) {
      caught = error
    }
    expect(caught).toMatchObject({ code: 'INVALID_ARGUMENT', details: { issues: [{ path: 'writeMode' }] } })
    expect(JSON.stringify(caught)).not.toContain(secret)
    expect((caught as Error).message).not.toContain(secret)
  })

  test('accepts every key of a loose object and of a record', () => {
    const schema = z.object({ known: z.object({}).loose(), map: z.record(z.string(), z.object({ a: z.number() })) })
    expect(unknownKeys(schema, { known: { anything: 1 }, map: { x: { a: 1, b: 2 } } })).toEqual(['map.x.b'])
  })

  test('looks inside unions, judging the value by the members it fits', () => {
    const schema = z.object({
      operations: z.array(
        z.discriminatedUnion('type', [
          z.object({ type: z.literal('add'), path: z.string() }),
          z.object({ type: z.literal('rename'), path: z.string(), newPath: z.string() }),
        ])
      ),
    })
    expect(unknownKeys(schema, { operations: [{ type: 'rename', path: 'a', newPath: 'b' }] })).toEqual([])
    expect(unknownKeys(schema, { operations: [{ type: 'add', path: 'a', newPath: 'b' }] })).toEqual(['operations.0.newPath'])
  })

  test('parses every operation from its own minimal valid input without unknown keys', () => {
    // Every operation's schema can be walked; an empty object has no unknown keys.
    for (const name of OPERATION_NAMES) {
      try {
        parseOperationInput(name, {})
      } catch (error) {
        expect((error as { details?: { unknownKeys?: unknown } }).details?.unknownKeys, name).toBeUndefined()
      }
    }
  })
})
