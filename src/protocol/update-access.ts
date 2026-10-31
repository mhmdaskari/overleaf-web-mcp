import { McpError } from '../core/errors.js'

/**
 * The access an OT update needs, judged from its shape alone as Overleaf's real-time service
 * judges it: an update that only adds comments needs view access, one that only makes tracked
 * changes needs review access, and anything else, an untracked edit, a comment status, or a
 * history-ot operation that removes text or clears tracking, needs edit access.
 */
export type UpdateAccess = 'view' | 'review' | 'edit'

/** The project access levels that may send an update of each kind, as joinProject names them. */
const PERMITTED: Record<UpdateAccess, ReadonlySet<string>> = {
  view: new Set(['owner', 'readAndWrite', 'review', 'readOnly']),
  review: new Set(['owner', 'readAndWrite', 'review']),
  edit: new Set(['owner', 'readAndWrite']),
}
const KNOWN_LEVELS = PERMITTED.view

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** A history-ot operation names a text operation or a comment; a ShareJS component never does. */
function isHistoryOperation(operation: unknown): boolean {
  return isRecord(operation) && ('textOperation' in operation || 'commentId' in operation)
}

/** Positive retains, tracked inserts, and retains that set tracking other than `none`. */
function isTrackedTextOperation(operation: unknown): boolean {
  if (!isRecord(operation) || !Array.isArray(operation.textOperation)) return false
  return operation.textOperation.every(component => {
    if (typeof component === 'number') return component > 0
    if (!isRecord(component)) return false
    if ('i' in component) return 'tracking' in component
    if ('r' in component) return !isRecord(component.tracking) || component.tracking.type !== 'none'
    return false
  })
}

export function requiredUpdateAccess(update: Record<string, unknown>): UpdateAccess {
  const operations = Array.isArray(update.op) ? update.op : []
  if (operations.length > 0 && operations.every(isHistoryOperation)) {
    if (operations.every(operation => isRecord(operation) && 'commentId' in operation && 'ranges' in operation)) {
      return 'view'
    }
    return operations.every(isTrackedTextOperation) ? 'review' : 'edit'
  }
  if (operations.every(component => isRecord(component) && Boolean(component.c))) {
    return 'view'
  }
  return isRecord(update.meta) && Boolean(update.meta.tc) ? 'review' : 'edit'
}

const REFUSALS: Record<Exclude<UpdateAccess, 'view'>, string> = {
  review:
    'This change is a tracked change, which needs owner, edit, or review access to the project, and this account has less. Nothing was sent.',
  edit: 'This change needs owner or edit access to the project. With review access, text can be written only as tracked changes (writeMode tracked) and comments can be added; with read-only access, only comments can be added. Nothing was sent.',
}

/**
 * Refuses, before anything is sent, an update this account's access level cannot make. Overleaf
 * would answer it with `not authorized` and drop the socket. A level this release does not know
 * may add comments only.
 */
export function assertUpdatePermitted(permissionsLevel: string, update: Record<string, unknown>): void {
  const required = requiredUpdateAccess(update)
  if (required === 'view' || PERMITTED[required].has(permissionsLevel)) return
  throw new McpError('PERMISSION_DENIED', REFUSALS[required], {
    details: { accessLevel: KNOWN_LEVELS.has(permissionsLevel) ? permissionsLevel : 'unrecognized', required },
  })
}
