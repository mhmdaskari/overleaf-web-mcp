import { expect } from 'vitest'
import type { z } from 'zod'

import { OPERATIONS, type OperationName } from '../../src/contracts/operations.js'
import { unknownKeys } from '../../src/contracts/parse.js'

/**
 * Snapshots one operation result taken through the real domain classes, and checks it against
 * the operation's output contract: it must parse, and hold no key the schema leaves out, since
 * MCP advertises every output object with `additionalProperties: false`.
 */
export function expectGolden(name: OperationName, result: unknown): void {
  expect(result).toMatchSnapshot()
  const schema = (OPERATIONS[name] as { outputSchema?: z.ZodObject }).outputSchema
  // Until v0.7.0 declares the schema, the snapshot alone is recorded.
  if (schema === undefined) return
  const parsed = schema.safeParse(result)
  expect(parsed.success ? [] : parsed.error.issues, name).toEqual([])
  expect(unknownKeys(schema, result), name).toEqual([])
}
