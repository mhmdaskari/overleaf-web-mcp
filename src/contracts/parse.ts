import type { z } from 'zod'

import { McpError } from '../core/errors.js'
import { OPERATIONS, type OperationInput, type OperationName } from './operations.js'

interface SchemaDefinition {
  type: string
  innerType?: z.ZodType
  shape?: Record<string, z.ZodType>
  catchall?: z.ZodType
  element?: z.ZodType
  valueType?: z.ZodType
  options?: z.ZodType[]
}

function definition(schema: z.ZodType): SchemaDefinition {
  return (schema as unknown as { def: SchemaDefinition }).def
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The keys in `value` that `schema` does not list, as dotted paths (`files.0.localpth`), at any
 * depth. zod drops such keys without a word, so a misspelled `writeMode` would quietly fall back
 * to its default; a strict caller refuses them instead. A `.loose()` object accepts any key.
 */
export function unknownKeys(schema: z.ZodType, value: unknown, path = ''): string[] {
  const def = definition(schema)
  switch (def.type) {
    case 'optional':
    case 'nullable':
    case 'default':
      return def.innerType === undefined ? [] : unknownKeys(def.innerType, value, path)
    case 'array':
      if (!Array.isArray(value) || def.element === undefined) return []
      return value.flatMap((item, index) => unknownKeys(def.element!, item, `${path}${index}.`))
    case 'record':
      if (!isRecord(value) || def.valueType === undefined) return []
      return Object.entries(value).flatMap(([key, item]) => unknownKeys(def.valueType!, item, `${path}${key}.`))
    case 'union': {
      // Judged by the members the value fits; it has an unknown key only if every such member says so.
      const options = def.options ?? []
      const fitting = options.filter(option => option.safeParse(value).success)
      const found = (fitting.length > 0 ? fitting : options).map(option => unknownKeys(option, value, path))
      return found.find(keys => keys.length === 0) ?? found[0] ?? []
    }
    case 'object': {
      if (!isRecord(value)) return []
      const shape = def.shape ?? {}
      const open = def.catchall !== undefined && definition(def.catchall).type !== 'never'
      return Object.entries(value).flatMap(([key, item]) => {
        const field = shape[key]
        if (field === undefined) return open ? [] : [`${path}${key}`]
        return unknownKeys(field, item, `${path}${key}.`)
      })
    }
    default:
      return []
  }
}

/**
 * Parses an operation's input as a strict caller does: an unknown key, at any depth, is
 * `INVALID_ARGUMENT` naming it, and the contract's defaults are applied, so the operation receives
 * exactly what the MCP server passes for the same call. The CLI and the SDK client use it; the MCP
 * SDK parses input itself and drops unknown keys.
 */
export function parseOperationInput<N extends OperationName>(name: N, input: unknown): OperationInput<N> {
  if (!isRecord(input)) {
    throw new McpError('INVALID_ARGUMENT', `The input for ${name} must be a JSON object.`)
  }
  const contract = OPERATIONS[name] as { inputSchema?: z.ZodObject }
  const schema = contract.inputSchema
  const unknown = schema === undefined ? Object.keys(input) : unknownKeys(schema, input)
  if (unknown.length > 0) {
    throw new McpError(
      'INVALID_ARGUMENT',
      `${name} does not accept ${unknown.length === 1 ? 'the parameter' : 'the parameters'} ${unknown.join(', ')}. Run \`overleaf-web-mcp schema ${name} --input\` for the parameters it takes.`,
      { details: { unknownKeys: unknown } }
    )
  }
  if (schema === undefined) return {} as OperationInput<N>
  const parsed = schema.safeParse(input)
  if (!parsed.success) {
    const issues = parsed.error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message }))
    throw new McpError(
      'INVALID_ARGUMENT',
      `Invalid input for ${name}: ${issues.map(issue => (issue.path === '' ? issue.message : `${issue.path}: ${issue.message}`)).join('; ')}.`,
      { details: { issues } }
    )
  }
  // Parsed output, defaults applied, is a valid input.
  return parsed.data as OperationInput<N>
}
