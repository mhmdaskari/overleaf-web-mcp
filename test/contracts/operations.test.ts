import { describe, expect, test } from 'vitest'

import { EFFECTS, READ_EFFECTS } from '../../src/contracts/effects.js'
import { ERROR_CODES } from '../../src/contracts/error-codes.js'
import { OPERATION_NAMES, OPERATIONS, operationContract } from '../../src/contracts/operations.js'

/** Parameters that confirm a destructive call by value or by expected state. */
const CONFIRMATIONS = [
  'confirmPath',
  'confirmName',
  'confirmCount',
  'confirmDeleteCount',
  'overwrite',
  'onConflict',
  'revision',
  'planToken',
]

function shape(name: (typeof OPERATION_NAMES)[number]): Record<string, unknown> {
  return (operationContract(name).inputSchema?.shape ?? {})
}

describe('operation contracts', () => {
  test('declare only known effects, at least one each', () => {
    for (const name of OPERATION_NAMES) {
      const { effects } = operationContract(name)
      expect(effects.length, name).toBeGreaterThan(0)
      for (const effect of effects) expect(EFFECTS, name).toContain(effect)
    }
  })

  test('are read-only exactly when every effect is a read', () => {
    for (const name of OPERATION_NAMES) {
      const { annotations, effects } = operationContract(name)
      const readsOnly = effects.every(effect => READ_EFFECTS.includes(effect))
      expect(annotations.readOnlyHint === true, name).toBe(readsOnly)
      // Everything else says whether it is destructive, so clients need not guess.
      if (!readsOnly) expect(typeof annotations.destructiveHint, name).toBe('boolean')
    }
  })

  test('are destructive whenever they can delete, write locally, or replace a document unchecked', () => {
    for (const name of OPERATION_NAMES) {
      const { annotations, effects } = operationContract(name)
      if (effects.some(effect => ['overleaf-delete', 'local-write', 'unchecked-replace'].includes(effect))) {
        expect(annotations.destructiveHint, name).toBe(true)
      }
    }
  })

  test('confirm every destructive operation by value or expected state, except stop_compile', () => {
    const unconfirmed = OPERATION_NAMES.filter(
      name =>
        operationContract(name).annotations.destructiveHint === true &&
        !CONFIRMATIONS.some(parameter => parameter in shape(name))
    )
    expect(unconfirmed).toEqual(['stop_compile'])
  })

  test('mark download_file as a local write that can replace a file', () => {
    expect(OPERATIONS.download_file.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    })
    expect(OPERATIONS.download_file.effects).toContain('local-write')
  })

  test('list every error code once, POLICY_DENIED included', () => {
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length)
    expect(ERROR_CODES).toContain('POLICY_DENIED')
  })

  test('accept only lowercase 40-character hashes for expectedHash', () => {
    const expectedHash = shape('upload_file').expectedHash as { safeParse(value: unknown): { success: boolean } }
    expect(expectedHash.safeParse('a'.repeat(40)).success).toBe(true)
    expect(expectedHash.safeParse('A'.repeat(40)).success).toBe(false)
    expect(expectedHash.safeParse('a'.repeat(39)).success).toBe(false)
  })
})
