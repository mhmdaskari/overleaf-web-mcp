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
  if (
    prefix > 0 &&
    (isHighSurrogate(before.charCodeAt(prefix - 1)) ||
      isHighSurrogate(after.charCodeAt(prefix - 1)))
  ) {
    prefix -= 1
  }

  let beforeEnd = before.length
  let afterEnd = after.length
  while (
    beforeEnd > prefix &&
    afterEnd > prefix &&
    before[beforeEnd - 1] === after[afterEnd - 1]
  ) {
    beforeEnd -= 1
    afterEnd -= 1
  }
  // The suffix boundary needs the corresponding low-surrogate guard.
  if (
    beforeEnd < before.length &&
    (isLowSurrogate(before.charCodeAt(beforeEnd)) ||
      isLowSurrogate(after.charCodeAt(afterEnd)))
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

// Code points above U+FFFF, and unpaired surrogates, which Overleaf's legacy editor cannot store.
const OUTSIDE_BMP = /[\u{10000}-\u{10FFFF}\uD800-\uDFFF]/gu

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
  // Once the earlier pieces are applied, the document matches `after` up to `offset`.
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

export function applyTextEdit(content: string, edit: TextEdit | null): string {
  if (edit === null) return content
  const actual = content.slice(edit.position, edit.position + edit.deleteText.length)
  if (actual !== edit.deleteText) throw new Error('Delete text does not match content.')
  return (
    content.slice(0, edit.position) +
    edit.insertText +
    content.slice(edit.position + edit.deleteText.length)
  )
}
