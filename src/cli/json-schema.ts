import type { z } from 'zod'

import { OPERATIONS, type OperationName } from '../contracts/operations.js'
import { McpError } from '../core/errors.js'

interface StandardJsonSchema {
  '~standard': { jsonSchema: Record<'input' | 'output', (options: { target: string }) => Record<string, unknown>> }
}

/**
 * An operation's input or output as JSON Schema, converted exactly as the MCP SDK converts it for
 * `tools/list` (draft 2020-12, object root), so the CLI and MCP clients read one description.
 */
export function operationJsonSchema(name: OperationName, io: 'input' | 'output'): Record<string, unknown> {
  const contract = OPERATIONS[name] as { inputSchema?: z.ZodObject; outputSchema?: z.ZodObject }
  const schema = io === 'input' ? contract.inputSchema : contract.outputSchema
  if (schema === undefined) {
    // An operation without parameters, as tools/list lists it.
    if (io === 'input') return { type: 'object', properties: {} }
    throw new McpError('INVALID_ARGUMENT', `${name} declares no output schema.`)
  }
  const json = (schema as unknown as StandardJsonSchema)['~standard'].jsonSchema[io]({ target: 'draft-2020-12' })
  return { type: 'object', ...json }
}
