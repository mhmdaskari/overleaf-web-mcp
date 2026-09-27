import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'

import { McpError } from './errors.js'

/**
 * Computes the git blob hash Overleaf stores for binary file entities.
 *
 * Overleaf's `FileHashManager` hashes `"blob " + byteLength + "\0" + content` with SHA-1,
 * which is byte-for-byte what `git hash-object <file>` produces. Plain `sha1sum` output
 * never matches, because it omits the header.
 *
 * Only binary `file` entities carry this hash. Overleaf stores no content hash for `doc`
 * entities, so text documents can only be compared by reading their content.
 */
export function gitBlobHash(content: Uint8Array): string {
  return createHash('sha1')
    .update(`blob ${content.byteLength}\0`, 'utf8')
    .update(content)
    .digest('hex')
}

/** Files up to this size are read whole; larger ones are streamed through the hash. */
export const STREAMING_HASH_THRESHOLD_BYTES = 8 * 1024 * 1024

export interface FileBlobHash {
  hash: string
  size: number
}

/**
 * Computes `gitBlobHash` for a file on disk without buffering files larger than
 * `STREAMING_HASH_THRESHOLD_BYTES`.
 *
 * The header needs the byte length before any content, so the size comes from `stat` on the
 * same open handle; a file that grows or shrinks while it is read is refused rather than
 * hashed under a length it no longer has.
 */
export async function gitBlobHashFile(path: string): Promise<FileBlobHash> {
  const handle = await open(path, 'r')
  try {
    const { size } = await handle.stat()
    if (size <= STREAMING_HASH_THRESHOLD_BYTES) {
      const bytes = await handle.readFile()
      if (bytes.byteLength !== size) throw changedWhileReading(path)
      return { hash: gitBlobHash(bytes), size }
    }
    const hash = createHash('sha1').update(`blob ${size}\0`, 'utf8')
    let read = 0
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      const bytes = chunk as Buffer
      read += bytes.byteLength
      hash.update(bytes)
    }
    if (read !== size) throw changedWhileReading(path)
    return { hash: hash.digest('hex'), size }
  } finally {
    await handle.close()
  }
}

function changedWhileReading(path: string): McpError {
  return new McpError('INVALID_ARGUMENT', `${path} changed while it was being read. Try again.`)
}
