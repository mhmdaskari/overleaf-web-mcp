export interface TextEdit {
  position: number
  deleteText: string
  insertText: string
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff
}

export function createMinimalTextEdit(before: string, after: string): TextEdit | null {
  if (before === after) return null

  let prefix = 0
  const prefixLimit = Math.min(before.length, after.length)
  while (prefix < prefixLimit && before[prefix] === after[prefix]) prefix += 1
  // JavaScript offsets are UTF-16 code units; widen the edit rather than split an astral character.
  if (prefix > 0 && (isHighSurrogate(before.charCodeAt(prefix - 1)) || isHighSurrogate(after.charCodeAt(prefix - 1)))) {
    prefix -= 1
  }

  let beforeEnd = before.length
  let afterEnd = after.length
  while (beforeEnd > prefix && afterEnd > prefix && before[beforeEnd - 1] === after[afterEnd - 1]) {
    beforeEnd -= 1
    afterEnd -= 1
  }
  // The suffix boundary needs the corresponding low-surrogate guard.
  if (
    beforeEnd < before.length &&
    (isLowSurrogate(before.charCodeAt(beforeEnd)) || isLowSurrogate(after.charCodeAt(afterEnd)))
  ) {
    beforeEnd += 1
    afterEnd += 1
  }

  return {
    position: prefix,
    deleteText: before.slice(prefix, beforeEnd),
    insertText: after.slice(prefix, afterEnd),
  }
}

/** A changed region: items `[beforeStart, beforeEnd)` of one sequence became `[afterStart, afterEnd)` of the other. */
interface Region {
  beforeStart: number
  beforeEnd: number
  afterStart: number
  afterEnd: number
}

/** The work a diff may still do, shared by every search one document's diff runs. */
interface WorkBudget {
  remaining: number
}

// The work one write's diff may do, in units of about a nanosecond, measured on Node 20 with 2 MB
// documents. Splitting and numbering text costs about 100 per line and up to 50 per character
// tokenized (one token per character, for punctuation) or stepped over back to a word's start;
// each diagonal a Myers search visits about 10, mostly keeping the points that trace the path
// back; each item compared along a snake about 1. The line search and every word search share the
// budget, so a word search that cannot afford its run of lines leaves that run one span, and
// either edit distance stops at 2,000. A word search also gives up when the change sits more than
// MAX_TOKEN_WALK code units inside one word. The plans at every granularity come from one line
// search, so a write that falls back to runs of lines adds almost nothing. The worst shapes
// measured stay under 100 ms: about 75 ms for a 450,000-character line of punctuation and 100 ms
// for 262,144 repeated 8-character lines with 263 changes, both on a cold start, 60 ms for 999
// scattered changes in 104,857 repeated lines, 50 ms for 2 MB of distinct lines all changed, and
// 10 to 30 ms for a 2 MB line that is one word. Past a limit the text, or the run of lines, is
// one span, as every write was before.
const DIAGONAL_COST = 10
const LINE_COST = 100
const TOKEN_CHARACTER_COST = 50
export const MAX_LINE_DISTANCE = 2_000
export const MAX_TOKEN_DISTANCE = 2_000
/** How far, in UTF-16 code units, a word search steps back from a change to the start or end of its word. */
export const MAX_TOKEN_WALK = 1_000
export const DIFF_WORK_BUDGET = 100_000_000

/**
 * The changed regions between two sequences, by the greedy forward search of E. W. Myers, "An
 * O(ND) Difference Algorithm and Its Variations", Algorithmica 1 (1986), with the furthest point
 * reached on each diagonal kept for every edit distance `d` so the path can be traced back.
 * Undefined when the edit distance exceeds `maxDistance` or the search would exceed the budget.
 */
function myersRegions(
  before: Int32Array,
  after: Int32Array,
  maxDistance: number,
  budget: WorkBudget
): Region[] | undefined {
  const n = before.length
  const m = after.length
  // Common leading and trailing items need no search, and most edits leave most of a document alone.
  let head = 0
  while (head < n && head < m && before[head] === after[head]) head += 1
  let tailBefore = n
  let tailAfter = m
  while (tailBefore > head && tailAfter > head && before[tailBefore - 1] === after[tailAfter - 1]) {
    tailBefore -= 1
    tailAfter -= 1
  }
  budget.remaining -= head + (n - tailBefore)
  const rows = tailBefore - head
  const columns = tailAfter - head
  if (rows === 0 && columns === 0) return []
  if (rows === 0 || columns === 0) {
    return [{ beforeStart: head, beforeEnd: tailBefore, afterStart: head, afterEnd: tailAfter }]
  }

  const limit = Math.min(maxDistance, rows + columns)
  const offset = limit + 1
  const furthest = new Int32Array(2 * limit + 3)
  // trace[d] holds the furthest x on diagonals -d..d after the search at distance d.
  const trace: Int32Array[] = []
  let distance = -1
  search: for (let d = 0; d <= limit; d += 1) {
    budget.remaining -= (d + 1) * DIAGONAL_COST
    if (budget.remaining < 0) return undefined
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && furthest[offset + k - 1]! < furthest[offset + k + 1]!)
          ? furthest[offset + k + 1]!
          : furthest[offset + k - 1]! + 1
      let y = x - k
      const start = x
      while (x < rows && y < columns && before[head + x] === after[head + y]) {
        x += 1
        y += 1
      }
      budget.remaining -= x - start
      furthest[offset + k] = x
      if (x >= rows && y >= columns) {
        trace.push(furthest.slice(offset - d, offset + d + 1))
        distance = d
        break search
      }
    }
    if (budget.remaining < 0) return undefined
    trace.push(furthest.slice(offset - d, offset + d + 1))
  }
  if (distance < 0) return undefined

  const deleted = new Uint8Array(rows)
  const inserted = new Uint8Array(columns)
  let x = rows
  let y = columns
  for (let d = distance; d > 0; d -= 1) {
    const previous = trace[d - 1]!
    // previous[i] is diagonal i - (d - 1).
    const at = (k: number): number => previous[k + d - 1]!
    const k = x - y
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1))
    const previousK = down ? k + 1 : k - 1
    const previousX = at(previousK)
    const previousY = previousX - previousK
    if (down) inserted[previousY] = 1
    else deleted[previousX] = 1
    x = previousX
    y = previousY
  }

  const regions: Region[] = []
  let i = 0
  let j = 0
  while (i < rows || j < columns) {
    if (i < rows && j < columns && deleted[i] === 0 && inserted[j] === 0) {
      i += 1
      j += 1
      continue
    }
    const region = { beforeStart: head + i, beforeEnd: 0, afterStart: head + j, afterEnd: 0 }
    while ((i < rows && deleted[i] === 1) || (j < columns && inserted[j] === 1)) {
      while (i < rows && deleted[i] === 1) i += 1
      while (j < columns && inserted[j] === 1) j += 1
    }
    regions.push({ ...region, beforeEnd: head + i, afterEnd: head + j })
  }
  return regions
}

function countLines(text: string): number {
  let count = text.length > 0 && !text.endsWith('\n') ? 1 : 0
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) count += 1
  return count
}

/** Numbers the distinct strings of both lists, so a search compares numbers rather than text. */
function intern(left: readonly string[], right: readonly string[]): [Int32Array, Int32Array] {
  const ids = new Map<string, number>()
  const number = (items: readonly string[]): Int32Array => {
    const result = new Int32Array(items.length)
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index]!
      let id = ids.get(item)
      if (id === undefined) {
        id = ids.size
        ids.set(item, id)
      }
      result[index] = id
    }
    return result
  }
  return [number(left), number(right)]
}

/** Each line with its trailing newline; a last line without one stands alone. */
function splitLines(text: string): string[] {
  const lines: string[] = []
  let start = 0
  while (start < text.length) {
    const newline = text.indexOf('\n', start)
    const end = newline === -1 ? text.length : newline + 1
    lines.push(text.slice(start, end))
    start = end
  }
  return lines
}

// A run of letters, digits, marks, and underscores; a run of horizontal whitespace; a newline; or
// any other single code point. The `u` flag keeps a surrogate pair inside one token.
const TOKEN = /[\p{L}\p{N}\p{M}_]+|[^\S\n]+|\n|./gsu
const HORIZONTAL_SPACE = /^[^\S\n]+$/u

interface Tokens {
  texts: string[]
  /** The UTF-16 offset of each token, then the text's length. */
  starts: number[]
}

const WORD_CHARACTER = /[\p{L}\p{N}\p{M}_]/u
const SPACE_CHARACTER = /[^\S\n]/u
// Letters and the like, and horizontal space, run on into one token; anything else is a token alone.
type CharacterClass = 'word' | 'space' | 'single'

function classAt(text: string, index: number): CharacterClass {
  const code = text.codePointAt(index)!
  if (code < 0x80) {
    if ((code >= 0x61 && code <= 0x7a) || (code >= 0x41 && code <= 0x5a) || (code >= 0x30 && code <= 0x39)) {
      return 'word'
    }
    if (code === 0x5f) return 'word'
    if (code === 0x20 || code === 0x09 || code === 0x0b || code === 0x0c || code === 0x0d) return 'space'
    return 'single'
  }
  const character = String.fromCodePoint(code)
  if (WORD_CHARACTER.test(character)) return 'word'
  return SPACE_CHARACTER.test(character) ? 'space' : 'single'
}

/** Whether `TOKEN` puts a token boundary at `index` of `text`. */
function isTokenBoundary(text: string, index: number): boolean {
  if (index <= 0 || index >= text.length) return true
  const previousCode = text.charCodeAt(index - 1)
  if (isLowSurrogate(text.charCodeAt(index)) && isHighSurrogate(previousCode)) return false
  const previous =
    index >= 2 && isLowSurrogate(previousCode) && isHighSurrogate(text.charCodeAt(index - 2)) ? index - 2 : index - 1
  const left = classAt(text, previous)
  return left === 'single' || left !== classAt(text, index)
}

function commonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length)
  let length = 0
  while (length < limit && left.charCodeAt(length) === right.charCodeAt(length)) length += 1
  return length
}

/** The common suffix, at most `limit` long so it never overlaps a common prefix. */
function commonSuffixLength(left: string, right: string, limit: number): number {
  let length = 0
  while (length < limit && left.charCodeAt(left.length - 1 - length) === right.charCodeAt(right.length - 1 - length)) {
    length += 1
  }
  return length
}

function tokenize(text: string): Tokens {
  const texts: string[] = []
  const starts: number[] = []
  for (const match of text.matchAll(TOKEN)) {
    texts.push(match[0])
    starts.push(match.index)
  }
  starts.push(text.length)
  return { texts, starts }
}

/** An edit in the coordinates of the original text, before any other edit applies. */
interface PlacedEdit {
  start: number
  deleteText: string
  insertText: string
}

/**
 * The word-level edits inside one changed run of lines. Two edits with exactly one horizontal
 * whitespace token between them become one, so "a b" to "x y" is one change rather than two; the
 * merged edit then sheds the tokens its ends share, never part of a word.
 */
function tokenEdits(before: string, after: string, maxDistance: number, budget: WorkBudget): PlacedEdit[] | undefined {
  // Common text at either end, cut back to a token boundary on both sides, needs no tokenizing.
  // Each step back is charged, and a word longer than MAX_TOKEN_WALK leaves the run one span.
  let head = commonPrefixLength(before, after)
  let walked = 0
  while (head > 0 && !(isTokenBoundary(before, head) && isTokenBoundary(after, head))) {
    head -= 1
    walked += 1
    if (walked > MAX_TOKEN_WALK) return undefined
  }
  let tail = commonSuffixLength(before, after, Math.min(before.length, after.length) - head)
  const walkedBack = walked
  while (tail > 0 && !(isTokenBoundary(before, before.length - tail) && isTokenBoundary(after, after.length - tail))) {
    tail -= 1
    walked += 1
    if (walked - walkedBack > MAX_TOKEN_WALK) return undefined
  }
  budget.remaining -= walked * TOKEN_CHARACTER_COST
  if (budget.remaining < 0) return undefined
  const cost = (before.length + after.length - 2 * (head + tail)) * TOKEN_CHARACTER_COST
  if (cost > budget.remaining) return undefined
  budget.remaining -= cost
  const changedBefore = before.slice(head, before.length - tail)
  const changedAfter = after.slice(head, after.length - tail)
  const left = tokenize(changedBefore)
  const right = tokenize(changedAfter)
  const regions = myersRegions(...intern(left.texts, right.texts), maxDistance, budget)
  if (regions === undefined) return undefined

  const merged: Region[] = []
  for (const region of regions) {
    const last = merged[merged.length - 1]
    if (
      last !== undefined &&
      region.beforeStart - last.beforeEnd === 1 &&
      HORIZONTAL_SPACE.test(left.texts[last.beforeEnd]!)
    ) {
      last.beforeEnd = region.beforeEnd
      last.afterEnd = region.afterEnd
    } else {
      merged.push({ ...region })
    }
  }
  // Myers leaves no common token at the ends of an edit it found, but a merged edit can have one.
  for (const region of merged) {
    while (
      region.beforeStart < region.beforeEnd &&
      region.afterStart < region.afterEnd &&
      left.texts[region.beforeStart] === right.texts[region.afterStart]
    ) {
      region.beforeStart += 1
      region.afterStart += 1
    }
    while (
      region.beforeEnd > region.beforeStart &&
      region.afterEnd > region.afterStart &&
      left.texts[region.beforeEnd - 1] === right.texts[region.afterEnd - 1]
    ) {
      region.beforeEnd -= 1
      region.afterEnd -= 1
    }
  }

  return merged.flatMap(region => {
    const deleteText = changedBefore.slice(left.starts[region.beforeStart], left.starts[region.beforeEnd])
    const insertText = changedAfter.slice(right.starts[region.afterStart], right.starts[region.afterEnd])
    return deleteText === '' && insertText === ''
      ? []
      : [{ start: head + left.starts[region.beforeStart]!, deleteText, insertText }]
  })
}

/** How finely `createGranularEdits` splits a change. */
export type EditGranularity = 'tokens' | 'hunks' | 'span'

export interface GranularEditOptions {
  /** `tokens` (the default) edits words, `hunks` each changed run of lines, `span` everything at once. */
  granularity?: EditGranularity
  /** Limits on the Myers edit distance and on the search's total work; the defaults suit 2 MB documents. */
  maxLineDistance?: number
  maxTokenDistance?: number
  workBudget?: number
}

/** Positions in the text the previous edits left, from edits placed in the original text. */
function inOrder(placed: readonly PlacedEdit[]): TextEdit[] {
  let shift = 0
  return placed.map(edit => {
    const position = edit.start + shift
    shift += edit.insertText.length - edit.deleteText.length
    return { position, deleteText: edit.deleteText, insertText: edit.insertText }
  })
}

/**
 * The edits that turn `before` into `after` at each granularity the search reached, finest first:
 * one per changed group of words, then one per changed run of lines, then one span. One line
 * search serves both of the first two. A search past its limits degrades to one span, for the
 * whole text when the line search gives up and for one run of lines when its word search does.
 * Each position counts the text the previous edits left, so the edits apply in order.
 */
export function* granularEditPlans(
  before: string,
  after: string,
  options: Omit<GranularEditOptions, 'granularity'> = {}
): Generator<TextEdit[], void, undefined> {
  if (before === after) {
    yield []
    return
  }
  const span = [createMinimalTextEdit(before, after)!]
  const budget: WorkBudget = { remaining: options.workBudget ?? DIFF_WORK_BUDGET }
  // Whole lines common to both ends need no splitting; the newline that ends each lies inside them.
  const prefix = commonPrefixLength(before, after)
  const head = prefix === 0 ? 0 : before.lastIndexOf('\n', prefix - 1) + 1
  const suffix = commonSuffixLength(before, after, Math.min(before.length, after.length) - prefix)
  const newline = suffix === 0 ? -1 : before.indexOf('\n', before.length - suffix)
  const tail = newline === -1 ? 0 : before.length - newline - 1
  const changedBefore = before.slice(head, before.length - tail)
  const changedAfter = after.slice(head, after.length - tail)
  budget.remaining -= (countLines(changedBefore) + countLines(changedAfter)) * LINE_COST
  if (budget.remaining < 0) {
    yield span
    return
  }
  const beforeLines = splitLines(changedBefore)
  const afterLines = splitLines(changedAfter)
  const lineRegions = myersRegions(
    ...intern(beforeLines, afterLines),
    options.maxLineDistance ?? MAX_LINE_DISTANCE,
    budget
  )
  if (lineRegions === undefined) {
    yield span
    return
  }

  const lineStarts = (lines: string[]): number[] => {
    const starts = [head]
    for (const line of lines) starts.push(starts[starts.length - 1]! + line.length)
    return starts
  }
  const beforeStarts = lineStarts(beforeLines)
  const afterStarts = lineStarts(afterLines)
  const hunks = lineRegions.map(region => {
    const start = beforeStarts[region.beforeStart]!
    const deleted = before.slice(start, beforeStarts[region.beforeEnd])
    const inserted = after.slice(afterStarts[region.afterStart], afterStarts[region.afterEnd])
    const whole = createMinimalTextEdit(deleted, inserted)
    return { start, deleted, inserted, whole: whole === null ? [] : [{ ...whole, start: start + whole.position }] }
  })

  const words: PlacedEdit[] = []
  for (const hunk of hunks) {
    const found = tokenEdits(hunk.deleted, hunk.inserted, options.maxTokenDistance ?? MAX_TOKEN_DISTANCE, budget)
    if (found === undefined) words.push(...hunk.whole)
    else for (const word of found) words.push({ ...word, start: hunk.start + word.start })
  }
  yield inOrder(words)
  yield inOrder(hunks.flatMap(hunk => hunk.whole))
  yield span
}

/**
 * Edits that turn `before` into `after`, one per changed group of words: a line diff, then a word
 * diff inside each changed run of lines. Each position counts the text the previous edits left,
 * so they apply in order. A search past its limits degrades to one span, for the whole text when
 * the line search gives up and for one run of lines when its word search does.
 */
export function createGranularEdits(before: string, after: string, options: GranularEditOptions = {}): TextEdit[] {
  if (before === after) return []
  const granularity = options.granularity ?? 'tokens'
  if (granularity === 'span') return [createMinimalTextEdit(before, after)!]
  const plans = granularEditPlans(before, after, options)
  const words = plans.next().value!
  if (granularity === 'tokens') return words
  const lines = plans.next().value
  // A line search that gave up yields only the span.
  return lines ?? words
}

// Code points above U+FFFF, and unpaired surrogates, which Overleaf's legacy editor cannot store.
const OUTSIDE_BMP = /[\u{10000}-\u{10FFFF}\uD800-\uDFFF]/gu

/**
 * Splits one edit around each character outside the BMP that it deletes and inserts again, so
 * that character stays in place. The pieces apply in order from `edit.position`. When the edit
 * would have to send one, because its text adds one or reorders them, `insertedAt` is the offset
 * of the first such character counted from the start of the text the edit applies to.
 */
function splitAroundOutsideBmp(edit: TextEdit): { edits: TextEdit[] } | { insertedAt: number } {
  const deleted = [...edit.deleteText.matchAll(OUTSIDE_BMP)]
  const kept: Array<{ deleteIndex: number; insertIndex: number; length: number }> = []
  let next = 0
  for (const inserted of edit.insertText.matchAll(OUTSIDE_BMP)) {
    while (next < deleted.length && deleted[next]![0] !== inserted[0]) next += 1
    const match = deleted[next]
    if (match === undefined) return { insertedAt: edit.position + inserted.index }
    kept.push({ deleteIndex: match.index, insertIndex: inserted.index, length: match[0].length })
    next += 1
  }
  if (kept.length === 0) return { edits: [edit] }

  const end = { deleteIndex: edit.deleteText.length, insertIndex: edit.insertText.length, length: 0 }
  const edits: TextEdit[] = []
  let deleteStart = 0
  let insertStart = 0
  // Once the earlier pieces are applied, the text matches the edit's result up to `offset`.
  let offset = edit.position
  for (const anchor of [...kept, end]) {
    const insertText = edit.insertText.slice(insertStart, anchor.insertIndex)
    const piece = createMinimalTextEdit(edit.deleteText.slice(deleteStart, anchor.deleteIndex), insertText)
    if (piece !== null) edits.push({ ...piece, position: offset + piece.position })
    offset += insertText.length + anchor.length
    deleteStart = anchor.deleteIndex + anchor.length
    insertStart = anchor.insertIndex + anchor.length
  }
  return { edits }
}

/**
 * Edits from `before` to `after` that never send again a character outside the BMP that `before`
 * already holds: the minimal edit is split around each such character it would only re-insert,
 * and each piece between them is edited on its own. The edits apply in order, each position
 * counted in the text the previous ones left. When `after` adds such a character, or reorders
 * them, `insertedAt` is the UTF-16 offset in `after` of the first one that would have to be sent.
 */
export function createOutsideBmpPreservingEdits(
  before: string,
  after: string
): { edits: TextEdit[] } | { insertedAt: number } {
  const edit = createMinimalTextEdit(before, after)
  if (edit === null) return { edits: [] }
  return splitAroundOutsideBmp(edit)
}

/**
 * `edits`, each split around the characters outside the BMP it would only send again, or
 * undefined when one of them would have to send such a character.
 */
export function preserveOutsideBmp(edits: readonly TextEdit[]): TextEdit[] | undefined {
  const result: TextEdit[] = []
  for (const edit of edits) {
    const split = splitAroundOutsideBmp(edit)
    if (!('edits' in split)) return undefined
    result.push(...split.edits)
  }
  return result
}

/**
 * `edits` split around the characters outside the BMP they would only send again, which neither
 * of Overleaf's editors accepts in an insertion. When the edits pair such characters so that one
 * would still be sent, the whole change is planned as one minimal edit split the same way, and
 * when even that must send one, because `after` adds it, as that one minimal edit.
 */
export function outsideBmpSafeEdits(before: string, after: string, edits: readonly TextEdit[]): TextEdit[] {
  const kept = preserveOutsideBmp(edits)
  if (kept !== undefined) return kept
  const whole = createOutsideBmpPreservingEdits(before, after)
  return 'edits' in whole ? whole.edits : [createMinimalTextEdit(before, after)!]
}

export function applyTextEdit(content: string, edit: TextEdit | null): string {
  if (edit === null) return content
  const actual = content.slice(edit.position, edit.position + edit.deleteText.length)
  if (actual !== edit.deleteText) throw new Error('Delete text does not match content.')
  return content.slice(0, edit.position) + edit.insertText + content.slice(edit.position + edit.deleteText.length)
}

/** Applies edits in order, each at a position in the text the previous ones left. */
export function applyTextEdits(content: string, edits: readonly TextEdit[]): string {
  return edits.reduce<string>((result, edit) => applyTextEdit(result, edit), content)
}
