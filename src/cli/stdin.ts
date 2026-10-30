import { McpError } from '../core/errors.js'

/**
 * Reads all of a stream, refusing a terminal: an operation command never waits for typed input.
 * `src/cli.ts` passes process.stdin, so only it touches the process streams.
 */
export async function readStdinStream(stream: { isTTY?: boolean } & AsyncIterable<unknown>): Promise<Uint8Array> {
  if (stream.isTTY === true) {
    throw new McpError(
      'INVALID_ARGUMENT',
      'stdin is a terminal; pipe the input in. Operation commands never wait for typed input.'
    )
  }
  const chunks: Uint8Array[] = []
  for await (const chunk of stream) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Uint8Array))
  return Buffer.concat(chunks)
}
