import { randomBytes } from 'node:crypto'

import { createGranularEdits, outsideBmpSafeEdits, type TextEdit } from '../core/diff.js'
import { chooseEdits, createRangeLayout, type RangeLayout, type TextSpan } from '../core/edit-placement.js'
import type { OtProtocol } from '../core/revision.js'

export interface RawRange {
  pos: number
  length: number
}

export interface HistorySnapshot {
  content: string
  comments?: Array<{ id: string; ranges: RawRange[]; resolved?: boolean }>
  trackedChanges?: Array<{
    range: RawRange
    tracking: { type: 'insert' | 'delete'; userId: string; ts: string }
  }>
}

export type ShareJsComponent = { p: number; i?: string; d?: string; c?: string; t?: string; u?: boolean }
export type HistoryOperation = Record<string, unknown>
export interface HistoryTrackingContext {
  userId: string
  timestamp: string
}

function deletedRanges(snapshot: HistorySnapshot): RawRange[] {
  return (snapshot.trackedChanges ?? [])
    .filter(change => change.tracking.type === 'delete')
    .map(change => change.range)
    .sort((left, right) => left.pos - right.pos)
}

export function historyVisibleContent(snapshot: HistorySnapshot): string {
  let cursor = 0
  let output = ''
  for (const range of deletedRanges(snapshot)) {
    output += snapshot.content.slice(cursor, range.pos)
    cursor = range.pos + range.length
  }
  return output + snapshot.content.slice(cursor)
}

/** Maps editor-visible UTF-16 offsets into snapshots that still contain tracked deletions. */
export function visibleToSnapshotOffset(snapshot: HistorySnapshot, visibleOffset: number): number {
  let deletedBefore = 0
  for (const range of deletedRanges(snapshot)) {
    const visiblePosition = range.pos - deletedBefore
    if (visibleOffset > visiblePosition) deletedBefore += range.length
    else break
  }
  return visibleOffset + deletedBefore
}

/** Maps raw history-OT offsets back into the editor view, collapsing tracked deletions. */
export function snapshotToVisibleOffset(snapshot: HistorySnapshot, snapshotOffset: number): number {
  let deletedBefore = 0
  for (const range of deletedRanges(snapshot)) {
    if (snapshotOffset < range.pos) break
    if (snapshotOffset < range.pos + range.length) return range.pos - deletedBefore
    deletedBefore += range.length
  }
  return snapshotOffset - deletedBefore
}

/** Each tracked deletion's point in the visible text, ascending, beside the deleted range. */
function historyDeletionPoints(snapshot: HistorySnapshot): { deletions: RawRange[]; points: number[] } {
  const deletions = deletedRanges(snapshot)
  let hidden = 0
  const points = deletions.map(range => {
    const point = range.pos - hidden
    hidden += range.length
    return point
  })
  return { deletions, points }
}

/**
 * Where a history-OT snapshot's ranges sit in the visible text: each tracked deletion's point, and
 * the extent of every tracked insertion and every comment range, which shrinks to a point where
 * the range covers only tracked-deleted text.
 */
export function historyRangeLayout(snapshot: HistorySnapshot): RangeLayout {
  const extent = (range: RawRange): TextSpan => ({
    start: snapshotToVisibleOffset(snapshot, range.pos),
    end: snapshotToVisibleOffset(snapshot, range.pos + range.length),
  })
  const inserts = (snapshot.trackedChanges ?? []).filter(change => change.tracking.type === 'insert')
  const comments = Array.isArray(snapshot.comments) ? snapshot.comments : []
  return createRangeLayout(historyDeletionPoints(snapshot).points, [
    ...inserts.map(change => extent(change.range)),
    ...comments.flatMap(comment => (Array.isArray(comment.ranges) ? comment.ranges.map(extent) : [])),
  ])
}

/**
 * ShareJS applies components in order, each at a position in the text the previous ones left, as
 * `edits` are. Each edit is split around a character outside the BMP it would only send again,
 * which the legacy editor could not store; if the edits pair those characters so that one would
 * still be sent, the operation steps around them as one minimal edit split the same way does. A
 * target that adds one is refused before this is called. `edits` default to the granular diff.
 */
export function buildShareJsOperation(
  before: string,
  after: string,
  edits: readonly TextEdit[] = createGranularEdits(before, after)
): ShareJsComponent[] {
  const op: ShareJsComponent[] = []
  for (const edit of outsideBmpSafeEdits(before, after, edits)) {
    if (edit.deleteText) op.push({ p: edit.position, d: edit.deleteText })
    if (edit.insertText) op.push({ p: edit.position, i: edit.insertText })
  }
  return op
}

/**
 * One history-OT text operation over the raw snapshot for `edits`, which are in visible
 * coordinates (tracked deletions hidden), each counted in the text the previous ones left. As for
 * ShareJS, no insertion sends again a character outside the BMP the text already holds, which
 * Overleaf refuses. The text between edits, and a tracked deletion at the end of an edit, are
 * retained, and a deleted span takes in a tracked deletion inside it or at its start, as a single
 * span always did. `edits` default to those `chooseEdits` places around the snapshot's ranges.
 */
export function buildHistoryTextOperation(
  snapshot: HistorySnapshot,
  targetVisibleContent: string,
  tracking?: HistoryTrackingContext,
  edits?: readonly TextEdit[]
): HistoryOperation[] {
  const visibleBefore = historyVisibleContent(snapshot)
  const { deletions, points } = historyDeletionPoints(snapshot)
  const planned =
    edits === undefined
      ? chooseEdits(visibleBefore, targetVisibleContent, historyRangeLayout(snapshot))
      : outsideBmpSafeEdits(visibleBefore, targetVisibleContent, edits)
  if (planned.length === 0) return []

  // Maps visible offsets, which only grow, to the snapshot with a cursor over the deletions. A
  // deletion at the offset itself lies after it, as it always did, so an edit takes in a tracked
  // deletion at its start and retains one at its end. Planned edits touch none at either end.
  let next = 0
  let deletedBefore = 0
  const toSnapshot = (visibleOffset: number): number => {
    while (next < points.length && points[next]! < visibleOffset) {
      deletedBefore += deletions[next]!.length
      next += 1
    }
    return visibleOffset + deletedBefore
  }

  const raw: Array<number | string | Record<string, unknown>> = []
  const push = (component: number | string | Record<string, unknown>): void => {
    const last = raw[raw.length - 1]
    // Adjacent retains, or adjacent removals, are one component.
    if (typeof component === 'number' && typeof last === 'number' && Math.sign(component) === Math.sign(last)) {
      raw[raw.length - 1] = last + component
    } else {
      raw.push(component)
    }
  }
  let cursor = 0
  // The length every earlier edit added, to map a position back to the original visible text.
  let shift = 0
  for (const edit of planned) {
    const visibleStart = edit.position - shift
    const start = toSnapshot(visibleStart)
    const end = edit.deleteText === '' ? start : toSnapshot(visibleStart + edit.deleteText.length)
    if (start > cursor) push(start - cursor)
    if (edit.insertText) {
      push(
        tracking === undefined
          ? edit.insertText
          : {
              i: edit.insertText,
              tracking: {
                type: 'insert',
                userId: tracking.userId,
                ts: tracking.timestamp,
              },
            }
      )
    }
    if (end > start) {
      push(
        tracking === undefined
          ? -(end - start)
          : {
              r: end - start,
              tracking: {
                type: 'delete',
                userId: tracking.userId,
                ts: tracking.timestamp,
              },
            }
      )
    }
    cursor = end
    shift += edit.insertText.length - edit.deleteText.length
  }
  if (snapshot.content.length > cursor) push(snapshot.content.length - cursor)
  return [{ textOperation: raw }]
}

export function buildCommentOperation(
  protocol: OtProtocol,
  threadId: string,
  start: number,
  end: number,
  selectedText: string
): Array<ShareJsComponent | HistoryOperation> {
  if (protocol === 'sharejs') return [{ p: start, c: selectedText, t: threadId }]
  return [{ commentId: threadId, ranges: [{ pos: start, length: end - start }] }]
}

export function buildStatusOperation(
  protocol: OtProtocol,
  threadId: string,
  resolved: boolean
): Array<HistoryOperation> {
  if (protocol === 'sharejs') return []
  return [{ commentId: threadId, resolved }]
}

/**
 * The first 18 hex characters of a Mongo ObjectId: seconds, then random bytes. Overleaf appends a
 * six-character counter to the seed to make comment and tracked-change ids.
 */
export function generateIdSeed(): string {
  const timestamp = Math.floor(Date.now() / 1000)
    .toString(16)
    .padStart(8, '0')
  return `${timestamp}${randomBytes(5).toString('hex')}`.slice(0, 18)
}

export function makeUpdate(
  docId: string,
  version: number,
  operation: unknown[],
  protocol: OtProtocol,
  trackingMetadata?: Record<string, unknown>
): Record<string, unknown> {
  if (protocol !== 'sharejs' && protocol !== 'history-ot') {
    throw new TypeError('Unsupported OT protocol.')
  }
  return {
    doc: docId,
    v: version,
    op: operation,
    // ShareJS tracked writes attach a track-changes id seed; untracked and history-OT writes omit it.
    ...(trackingMetadata === undefined ? {} : { meta: trackingMetadata }),
  }
}
