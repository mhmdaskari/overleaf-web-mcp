import { rm } from 'node:fs/promises'

import { describe, expect, test } from 'vitest'

import { createOverleafService } from '../../src/service/operations.js'
import { expectGolden } from '../helpers/golden.js'
import { createTestRuntime } from '../helpers/runtime.js'

const PROJECT = 'project-id'

/**
 * Stops a compile through the service over a real runtime whose `POST .../compile/stop` answers
 * with `answer`, and returns the result with every request made after the bootstrap.
 */
async function stopCompile(answer: () => Response): Promise<{ result: unknown; fetches: string[] }> {
  const { runtime, fetches, directory } = await createTestRuntime({
    fetcher: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if ((init?.method ?? 'GET') === 'POST' && url.pathname === `/project/${PROJECT}/compile/stop`) return answer()
      throw new Error(`unexpected ${init?.method ?? 'GET'} ${url.pathname}`)
    },
  })
  try {
    const result = await createOverleafService(runtime).stop_compile({ projectId: PROJECT })
    return { result, fetches }
  } finally {
    await runtime.close()
    await rm(directory, { recursive: true, force: true })
  }
}

// Overleaf answers a stop with no data; whatever body it sends is dropped, so every answer it can
// give that is not an error yields the same result.
const ANSWERS: Array<[string, () => Response]> = [
  ['an Express sendStatus OK body', () => new Response('OK')],
  ['an empty 204 body', () => new Response(null, { status: 204 })],
  ['an empty JSON object', () => Response.json({})],
  ['a JSON body with keys of its own', () => Response.json({ status: 'stopped', extra: 'ignored' })],
]

describe('stop_compile', () => {
  test.each(ANSWERS)('after %s', async (_label, answer) => {
    const { result, fetches } = await stopCompile(answer)
    expect(fetches).toEqual([`POST /project/${PROJECT}/compile/stop`])
    expectGolden('stop_compile', result)
  })
})
