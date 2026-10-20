import { randomBytes } from 'node:crypto'

import { createMinimalTextEdit, createOutsideBmpPreservingEdits } from '../core/diff.js'
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

export type ShareJsComponent = { p: number; i?: string; d?: string; c?: string; t?: string }
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

/**
 * ShareJS applies components in order, each at a position in the text the previous ones left, so
 * the operation steps around a character outside the BMP that the legacy editor could not store
 * again. A target that adds one is refused before this is called.
 */
export function buildShareJsOperation(before: string, after: string): ShareJsComponent[] {
  const plan = createOutsideBmpPreservingEdits(before, after)
  const edits = 'edits' in plan ? plan.edits : [createMinimalTextEdit(before, after)!]
  const op: ShareJsComponent[] = []
  for (const edit of edits) {
    if (edit.deleteText) op.push({ p: edit.position, d: edit.deleteText })
    if (edit.insertText) op.push({ p: edit.position, i: edit.insertText })
  }
  return op
}

export function buildHistoryTextOperation(
  snapshot: HistorySnapshot,
  targetVisibleContent: string,
  tracking?: HistoryTrackingContext
): HistoryOperation[] {
  const visible = historyVisibleContent(snapshot)
  const edit = createMinimalTextEdit(visible, targetVisibleContent)
  if (!edit) return []
  const start = visibleToSnapshotOffset(snapshot, edit.position)
  const end = visibleToSnapshotOffset(snapshot, edit.position + edit.deleteText.length)
  const raw: Array<number | string | Record<string, unknown>> = []
  if (start > 0) raw.push(start)
  if (edit.insertText) {
    raw.push(
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
    raw.push(
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
  if (snapshot.content.length > end) raw.push(snapshot.content.length - end)
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
  const timestamp = Math.floor(Date.now() / 1000).toString(16).padStart(8, '0')
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
