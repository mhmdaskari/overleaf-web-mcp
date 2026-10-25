import { describe, expect, test } from 'vitest'

import { readStdinStream } from '../../src/cli/stdin.js'

describe('reading stdin', () => {
  test('refuses a terminal without reading from it', async () => {
    let read = false
    const terminal = {
      isTTY: true,
      async *[Symbol.asyncIterator]() {
        read = true
        yield Buffer.from('typed')
      },
    }
    await expect(readStdinStream(terminal)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(read).toBe(false)
  })

  test('reads every chunk of a pipe, bytes or text', async () => {
    const pipe = {
      async *[Symbol.asyncIterator]() {
        yield Buffer.from('\\section{A}\n')
        yield 'body'
      },
    }
    expect(Buffer.from(await readStdinStream(pipe)).toString('utf8')).toBe('\\section{A}\nbody')
  })
})
