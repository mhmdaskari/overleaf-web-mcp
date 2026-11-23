import { McpError } from '../core/errors.js'

const PARAMETERS = {
  source_to_pdf: { required: ['filePath', 'line'], allowed: ['buildRef', 'filePath', 'line', 'column'] },
  pdf_to_source: { required: ['page', 'h', 'v'], allowed: ['buildRef', 'page', 'h', 'v'] },
  word_count: { required: [], allowed: ['buildRef', 'filePath'] },
} as const

const ALL = ['buildRef', 'filePath', 'line', 'column', 'page', 'h', 'v'] as const

/** Each `inspect_build` action takes its own parameters and none of the others'. */
export function assertInspectBuild(input: Record<string, unknown>): void {
  const action = input.action as keyof typeof PARAMETERS
  const rule = PARAMETERS[action]
  if (rule === undefined) return
  const missing = rule.required.filter(key => input[key] === undefined)
  if (missing.length > 0) {
    throw new McpError('INVALID_ARGUMENT', `${action} needs ${missing.join(' and ')}.`, {
      details: { parameters: missing },
    })
  }
  const allowed: readonly string[] = rule.allowed
  const extra = ALL.filter(key => input[key] !== undefined && !allowed.includes(key))
  if (extra.length > 0) {
    throw new McpError('INVALID_ARGUMENT', `${action} takes no ${extra.join(' or ')}.`, {
      details: { parameters: extra },
    })
  }
}
