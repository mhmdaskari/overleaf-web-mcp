import { McpError } from './errors.js'

/** One targeted change to a document: `oldText`, which must occur exactly once, becomes `newText`. */
export interface DocumentEdit {
  oldText: string
  newText: string
}

/** The most edits one `write_file` call takes. */
export const MAX_TEXT_EDITS = 100

/**
 * Applies `edits` to `text` in order, each to the text the edits before it produced. Matching is
 * exact: no whitespace, line-ending, or case folding. An `oldText` that does not occur, or occurs
 * more than once (overlapping occurrences included), is `INVALID_ARGUMENT` with `details.kind`
 * `edit_not_found` or `edit_ambiguous` and the 0-based `details.editIndex`. Errors never carry
 * document text.
 */
export function applyTextEdits(text: string, edits: readonly DocumentEdit[]): string {
  let current = text
  edits.forEach((edit, editIndex) => {
    if (edit.oldText === '') {
      throw new McpError('INVALID_ARGUMENT', 'An edit needs a non-empty oldText; nothing was sent.', {
        details: { editIndex },
      })
    }
    const at = current.indexOf(edit.oldText)
    if (at === -1) {
      throw new McpError(
        'INVALID_ARGUMENT',
        "An edit's oldText does not occur in the document as the edits before it left it; read the file again and match it exactly. Nothing was sent.",
        { details: { kind: 'edit_not_found', editIndex } }
      )
    }
    if (current.indexOf(edit.oldText, at + 1) !== -1) {
      throw new McpError(
        'INVALID_ARGUMENT',
        "An edit's oldText occurs more than once; include more of the surrounding text so it matches one place. Nothing was sent.",
        { details: { kind: 'edit_ambiguous', editIndex } }
      )
    }
    current = current.slice(0, at) + edit.newText + current.slice(at + edit.oldText.length)
  })
  return current
}
