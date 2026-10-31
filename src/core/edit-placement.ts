import { createMinimalTextEdit, granularEditPlans, outsideBmpSafeEdits, type TextEdit } from './diff.js'

/** `[start, end)` in a text. */
export interface TextSpan {
  start: number
  end: number
}

/**
 * Where a document's ranges sit in its visible text, for keeping a write's edits clear of them.
 * An edit that touches none of them only moves them along, so Overleaf leaves each range as it
 * was, which the single span a write used to send cannot do better than.
 */
export interface RangeLayout {
  /** Each tracked deletion's point, ascending. */
  readonly deletions: readonly number[]
  /**
   * Every comment range and tracked insertion, ascending by start, including one that covers only
   * tracked-deleted text and so has no visible length: an edit at its point still lands in it.
   */
  readonly spans: readonly TextSpan[]
  /** Each span's start. */
  readonly starts: readonly number[]
  /** The furthest end among `spans[0]` to `spans[i]`, so a scan back over them can stop early. */
  readonly reach: readonly number[]
}

export function createRangeLayout(deletions: readonly number[], spans: readonly TextSpan[]): RangeLayout {
  const sorted = spans
    .map(span => ({ start: span.start, end: span.end }))
    .sort((left, right) => left.start - right.start || left.end - right.end)
  const reach: number[] = []
  let furthest = -1
  for (const span of sorted) {
    furthest = Math.max(furthest, span.end)
    reach.push(furthest)
  }
  return {
    deletions: [...deletions].sort((left, right) => left - right),
    spans: sorted,
    starts: sorted.map(span => span.start),
    reach,
  }
}

/** The first index in ascending `values` whose value is at least `value`, or past it when `strict`. */
function firstIndex(values: readonly number[], value: number, strict: boolean): number {
  let low = 0
  let high = values.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (strict ? values[middle]! <= value : values[middle]! < value) low = middle + 1
    else high = middle
  }
  return low
}

/** Ranges looked at, shared by every step of planning one write, so that it stays cheap. */
export interface Work {
  remaining: number
}

/** How many ranges planning one write may look at before it settles for the single span. */
const PLANNING_WORK = 4_000_000

/**
 * Whether an edit deleting `[start, end)` of the original text, and inserting at `start`, touches
 * a range: a tracked deletion's point anywhere from `start` to `end`, or a span that it overlaps
 * or that ends or starts where the edit does, ends included. Overleaf can fold, grow, split, or
 * merge a range an edit only reaches the end of, on both protocols. Charges `work` for each range
 * looked at.
 */
function touches(layout: RangeLayout, start: number, end: number, work: Work): boolean {
  const { deletions, spans, starts, reach } = layout
  const index = firstIndex(deletions, start, false)
  work.remaining -= 1
  if (index < deletions.length && deletions[index]! <= end) return true
  for (let span = firstIndex(starts, end, true) - 1; span >= 0 && reach[span]! >= start; span -= 1) {
    work.remaining -= 1
    if (spans[span]!.end >= start) return true
  }
  return false
}

/** Whether any of `edits`, each counted in the text the previous ones left, touches a range. */
export function editsTouch(
  edits: readonly TextEdit[],
  layout: RangeLayout,
  work: Work = { remaining: Infinity }
): boolean {
  let shift = 0
  for (const edit of edits) {
    const start = edit.position - shift
    if (touches(layout, start, start + edit.deleteText.length, work)) return true
    shift += edit.insertText.length - edit.deleteText.length
  }
  return false
}

/** An edit counted in the original text. */
interface Placed {
  start: number
  deleteText: string
  insertText: string
}

function isSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdfff
}

/**
 * A pure insertion or deletion moved one character left over the equal text before it, which
 * leaves the result the same, or undefined if that character differs, is part of a surrogate
 * pair, or lies before `low`.
 */
function slideLeft(before: string, edit: Placed, low: number): Placed | undefined {
  const from = edit.start - 1
  if (from < low || isSurrogate(before.charCodeAt(from))) return undefined
  const moved = before[from]!
  if (edit.deleteText !== '') {
    if (before[edit.start + edit.deleteText.length - 1] !== moved) return undefined
    return { start: from, deleteText: before.slice(from, from + edit.deleteText.length), insertText: '' }
  }
  if (edit.insertText[edit.insertText.length - 1] !== moved) return undefined
  return { start: from, deleteText: '', insertText: moved + edit.insertText.slice(0, -1) }
}

/** As `slideLeft`, one character right over the equal text after it, up to `high`. */
function slideRight(before: string, edit: Placed, high: number): Placed | undefined {
  const end = edit.start + edit.deleteText.length
  if (end + 1 > high || isSurrogate(before.charCodeAt(end))) return undefined
  const moved = before[end]!
  if (edit.deleteText !== '') {
    if (before[edit.start] !== moved) return undefined
    return { start: edit.start + 1, deleteText: before.slice(edit.start + 1, end + 1), insertText: '' }
  }
  if (edit.insertText[0] !== moved) return undefined
  return { start: edit.start + 1, deleteText: '', insertText: edit.insertText.slice(1) + moved }
}

/** How far a pure insertion or deletion is moved along equal text, each way, looking for a place clear of every range. */
const MAX_SLIDE = 64

/** `edit` and each place it can move to between `low` and `high`, nearest first. */
function* slides(before: string, edit: Placed, low: number, high: number): Generator<Placed> {
  yield edit
  if ((edit.deleteText === '') === (edit.insertText === '')) return
  let left: Placed | undefined = edit
  let right: Placed | undefined = edit
  for (let step = 0; step < MAX_SLIDE && (left !== undefined || right !== undefined); step += 1) {
    left = left === undefined ? undefined : slideLeft(before, left, low)
    if (left !== undefined) yield left
    right = right === undefined ? undefined : slideRight(before, right, high)
    if (right !== undefined) yield right
  }
}

/**
 * Where to send one edit, between the end of the previous edit (`low`) and the start of the next
 * (`high`): as it is if it touches no range, or else the first that touches none of its
 * characters that differ (the common prefix and suffix removed, as one span is cut) and the
 * places that cut-down edit can move to along equal text, nearest first. Failing those, the edit
 * as it is, which then keeps its plan from being sent. Undefined when the edit changes nothing.
 */
function placeEdit(
  before: string,
  edit: Placed,
  low: number,
  high: number,
  layout: RangeLayout,
  work: Work
): Placed | undefined {
  const clear = (candidate: Placed): boolean =>
    !touches(layout, candidate.start, candidate.start + candidate.deleteText.length, work)
  if (clear(edit)) return edit
  const trimmed = createMinimalTextEdit(edit.deleteText, edit.insertText)
  if (trimmed === null) return undefined
  for (const candidate of slides(
    before,
    { start: edit.start + trimmed.position, deleteText: trimmed.deleteText, insertText: trimmed.insertText },
    low,
    high
  )) {
    if (clear(candidate)) return candidate
    if (work.remaining <= 0) break
  }
  return edit
}

/**
 * `edits`, in order and each counted in the text the previous ones left, placed around the ranges
 * in `layout` by `placeEdit`. The text they produce is unchanged.
 */
export function placeEdits(
  before: string,
  edits: readonly TextEdit[],
  layout: RangeLayout,
  work: Work = { remaining: PLANNING_WORK }
): TextEdit[] {
  if (layout.deletions.length === 0 && layout.spans.length === 0) return [...edits]
  const result: TextEdit[] = []
  let shift = 0
  let low = 0
  edits.forEach((edit, index) => {
    const start = edit.position - shift
    const added = edit.insertText.length - edit.deleteText.length
    const next = edits[index + 1]
    const high = next === undefined ? before.length : next.position - shift - added
    const placed = placeEdit(
      before,
      { start, deleteText: edit.deleteText, insertText: edit.insertText },
      low,
      high,
      layout,
      work
    )
    if (placed !== undefined) {
      result.push({ position: placed.start + shift, deleteText: placed.deleteText, insertText: placed.insertText })
      low = placed.start + placed.deleteText.length
    } else {
      low = start + edit.deleteText.length
    }
    shift += added
  })
  return result
}

/**
 * The edits a write sends from `before` to `after`, around the ranges in `layout`: the finer of
 * one edit per changed group of words and one per changed run of lines, each split around a
 * character outside the BMP it would only send again and placed by `placeEdits`, that `fits` and
 * touches no comment or tracked change. Failing both, or once planning runs out of work, the
 * single span, split the same way.
 */
export function chooseEdits(
  before: string,
  after: string,
  layout: RangeLayout,
  fits: (edits: readonly TextEdit[]) => boolean = () => true
): TextEdit[] {
  const plans = [...granularEditPlans(before, after)].map(edits => outsideBmpSafeEdits(before, after, edits))
  const span = plans.pop()!
  const work: Work = { remaining: PLANNING_WORK }
  for (const edits of plans) {
    const placed = placeEdits(before, edits, layout, work)
    if (fits(placed) && !editsTouch(placed, layout, work) && work.remaining > 0) return placed
    if (work.remaining <= 0) break
  }
  return span
}
