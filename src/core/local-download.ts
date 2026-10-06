import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, link, open, rename, stat, unlink, type FileHandle } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import { McpError } from './errors.js'

/**
 * A local file a download may create or replace, checked, and with its temporary file already
 * created, before anything is requested. Call `discard` if the download is never written.
 */
export interface LocalDownloadTarget {
  /** Absolute path of the destination. */
  path: string
  /** The path the caller supplied, for messages. */
  localPath: string
  overwrite: boolean
  temporary: string
  handle: FileHandle
  discard(): Promise<void>
}

/** How many leading bytes `checks.head` receives, or fewer when the body is shorter. */
export const DOWNLOAD_HEAD_BYTES = 8

/** How many trailing bytes `checks.tail` receives at most: a zip's end record with its longest comment. */
export const DOWNLOAD_TAIL_BYTES = 22 + 0xffff

/** Format checks on a download, run before the file is put in place; a check that throws stops it. */
export interface DownloadChecks {
  head?(head: Uint8Array): void
  tail?(tail: Uint8Array): void
}

/** Codes `link` reports on file systems without hard links; Windows reports EISDIR on FAT and exFAT. */
const NO_HARD_LINKS = new Set(['EPERM', 'ENOTSUP', 'EXDEV', 'ENOSYS', 'EISDIR'])

const ERRNO_PATTERN = /^E[A-Z0-9]{1,15}$/u

function errnoCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code
}

function existsMismatch(localPath: string, cause?: unknown): McpError {
  return new McpError(
    'CONFIRMATION_MISMATCH',
    `${localPath} already exists. Pass overwrite: true to replace it; nothing was written.`,
    cause === undefined ? {} : { cause }
  )
}

/** A local file-system failure, typed and carrying only the caller's path and the errno code. */
function localWriteFailure(error: unknown, localPath: string): McpError {
  if (error instanceof McpError) return error
  const code = errnoCode(error)
  return new McpError(
    'INVALID_ARGUMENT',
    `${localPath} could not be written${code === undefined ? '' : ` (${code})`}; nothing was written.`,
    {
      cause: error,
      ...(code !== undefined && ERRNO_PATTERN.test(code) ? { details: { errno: code } } : {}),
    }
  )
}

/**
 * Checks a local destination before any request: its folder must exist and be writable, and an
 * existing file is replaced only with `overwrite`. The temporary file is created here, so a
 * folder that cannot be written fails before anything is sent. Whether the destination exists is
 * checked again when the file is put in place, so a file that appears meanwhile is not replaced.
 */
export async function prepareLocalDownload(
  localPath: string,
  overwrite: boolean
): Promise<LocalDownloadTarget> {
  const path = resolve(localPath)
  const folder = await stat(dirname(path)).catch(() => undefined)
  if (folder === undefined || !folder.isDirectory()) {
    throw new McpError('NOT_FOUND', `The folder for ${localPath} does not exist.`)
  }
  const existing = await stat(path).catch((error: unknown) => {
    if (errnoCode(error) === 'ENOENT') return undefined
    throw localWriteFailure(error, localPath)
  })
  if (existing?.isDirectory() === true) {
    throw new McpError('INVALID_ARGUMENT', `${localPath} is a folder; name the file to write.`)
  }
  if (existing !== undefined && !overwrite) throw existsMismatch(localPath)
  // Only unique within the folder; the destination's name is left out so a long one still fits.
  const temporary = join(dirname(path), `.download-${randomBytes(6).toString('hex')}.part`)
  const handle = await open(temporary, 'wx').catch((error: unknown) => {
    throw localWriteFailure(error, localPath)
  })
  let discarded = false
  return {
    path,
    localPath,
    overwrite,
    temporary,
    handle,
    discard: async () => {
      if (discarded) return
      discarded = true
      await handle.close().catch(() => undefined)
      await unlink(temporary).catch(() => undefined)
    },
  }
}

function keepTail(tail: Uint8Array, chunk: Uint8Array): Uint8Array {
  if (chunk.byteLength >= DOWNLOAD_TAIL_BYTES) return chunk.slice(chunk.byteLength - DOWNLOAD_TAIL_BYTES)
  const keep = Math.min(tail.byteLength, DOWNLOAD_TAIL_BYTES - chunk.byteLength)
  const joined = new Uint8Array(keep + chunk.byteLength)
  joined.set(tail.subarray(tail.byteLength - keep))
  joined.set(chunk, keep)
  return joined
}

function interrupted(error: unknown): McpError {
  const name = (error as { name?: unknown } | null)?.name
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new McpError('TIMEOUT', 'The download timed out before it finished; nothing was written.', {
      retryable: true,
      cause: error,
    })
  }
  return new McpError('REMOTE_ERROR', 'The download was interrupted; nothing was written.', {
    retryable: true,
    cause: error,
  })
}

/**
 * Streams a response body into the target's temporary file, then puts it in place. With
 * `overwrite` the rename is atomic, so a failed download never destroys the existing file;
 * without it the file is linked into place, which fails rather than replace a file that appeared
 * in the meantime. The temporary file is removed on every path.
 */
export async function writeDownload(
  body: ReadableStream<Uint8Array>,
  target: LocalDownloadTarget,
  checks: DownloadChecks = {}
): Promise<{ bytes: number; replaced: boolean }> {
  const { handle, temporary, localPath } = target
  const reader = body.getReader()
  try {
    let bytes = 0
    let head: Uint8Array | undefined = new Uint8Array(0)
    let tail: Uint8Array = new Uint8Array(0)
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>
      try {
        chunk = await reader.read()
      } catch (error) {
        throw interrupted(error)
      }
      if (chunk.done) break
      // The head is checked before the bytes that complete it are written.
      if (head !== undefined) {
        const joined: Uint8Array = new Uint8Array(head.byteLength + chunk.value.byteLength)
        joined.set(head)
        joined.set(chunk.value, head.byteLength)
        if (joined.byteLength >= DOWNLOAD_HEAD_BYTES) {
          checks.head?.(joined.subarray(0, DOWNLOAD_HEAD_BYTES))
          head = undefined
        } else {
          head = joined
        }
      }
      if (checks.tail !== undefined) tail = keepTail(tail, chunk.value)
      await handle.write(chunk.value).catch((error: unknown) => {
        throw localWriteFailure(error, localPath)
      })
      bytes += chunk.value.byteLength
    }
    if (head !== undefined) checks.head?.(head)
    checks.tail?.(tail)
    await handle.close().catch((error: unknown) => {
      throw localWriteFailure(error, localPath)
    })

    if (target.overwrite) {
      const replaced = await stat(target.path).then(
        () => true,
        () => false
      )
      await rename(temporary, target.path).catch((error: unknown) => {
        throw localWriteFailure(error, localPath)
      })
      return { bytes, replaced }
    }
    try {
      await link(temporary, target.path)
    } catch (error) {
      const code = errnoCode(error)
      if (code === 'EEXIST') throw existsMismatch(localPath, error)
      if (code === undefined || !NO_HARD_LINKS.has(code)) throw localWriteFailure(error, localPath)
      // Some file systems have no hard links; an exclusive copy keeps the same guarantee.
      try {
        await copyFile(temporary, target.path, constants.COPYFILE_EXCL)
      } catch (copyError) {
        if (errnoCode(copyError) === 'EEXIST') throw existsMismatch(localPath, copyError)
        throw localWriteFailure(copyError, localPath)
      }
    }
    return { bytes, replaced: false }
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  } finally {
    await target.discard()
  }
}
