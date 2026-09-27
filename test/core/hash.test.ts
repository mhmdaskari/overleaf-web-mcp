import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'vitest'

import {
  gitBlobHash,
  gitBlobHashFile,
  STREAMING_HASH_THRESHOLD_BYTES,
} from '../../src/core/hash.js'

const encoder = new TextEncoder()

async function scratch(name: string, bytes: Uint8Array | string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'overleaf-hash-'))
  const path = join(directory, name)
  await writeFile(path, bytes)
  return path
}

describe('git blob hashes', () => {
  // Reference values produced by `git hash-object`, the format Overleaf stores for file entities.
  test('matches git hash-object rather than plain sha1', () => {
    expect(gitBlobHash(encoder.encode('hello\n'))).toBe(
      'ce013625030ba8dba906f756967f9e9ca394464a'
    )
    expect(gitBlobHash(encoder.encode(''))).toBe(
      'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391'
    )
    expect(gitBlobHash(encoder.encode('\\documentclass{article}\n'))).toBe(
      'afc4251d1f586cdc80598e5234f602a8dd33433c'
    )
  })

  test('hashes raw bytes, so binary content is unaffected by text decoding', () => {
    expect(gitBlobHash(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]))).toMatch(
      /^[0-9a-f]{40}$/u
    )
  })

  test('hashes files on disk exactly as git hash-object does: text, binary, and empty', async () => {
    await expect(
      gitBlobHashFile(
        await scratch('main.tex', '\\documentclass{article}\n\\begin{document}\nHi\n\\end{document}\n')
      )
    ).resolves.toEqual({ hash: 'e54c6c9399264891f59bbc04c00aff1d1d809858', size: 59 })
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
      0x52, 0xff, 0xfe,
    ])
    await expect(gitBlobHashFile(await scratch('plot.png', png))).resolves.toEqual({
      hash: 'ac46b867e6e844c117dd10ed279bb55d6c934c28',
      size: 18,
    })
    await expect(gitBlobHashFile(await scratch('empty.bin', ''))).resolves.toEqual({
      hash: 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391',
      size: 0,
    })
  })

  test('streams files above the threshold and still matches the in-memory hash', async () => {
    const bytes = new Uint8Array(STREAMING_HASH_THRESHOLD_BYTES + 12_345)
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = (index * 31) % 251
    const path = await scratch('large.pdf', bytes)

    await expect(gitBlobHashFile(path)).resolves.toEqual({
      hash: gitBlobHash(bytes),
      size: bytes.length,
    })
  })
})
