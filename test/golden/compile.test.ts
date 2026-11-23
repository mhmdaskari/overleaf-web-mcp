import { rm } from 'node:fs/promises'

import { describe, expect, test } from 'vitest'

import { encodeBuildRef } from '../../src/overleaf/compile.js'
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

describe('inspect_build', () => {
  // A buildRef as compile_project returns it, made in another process: this runtime never compiled.
  const buildRef = encodeBuildRef({
    projectId: PROJECT,
    buildId: '18a2b3c4d5e-6f7a8b9c0d1e2f3a',
    clsiServerId: 'clsi-pool-2',
    editorId: '0b6c2f0e-4a4e-4f3b-9d3e-6f5c1a2b3c4d',
  })

  async function inspect(input: Record<string, unknown>, answer: (url: URL) => unknown) {
    const { runtime, fetches, directory } = await createTestRuntime({
      fetcher: async input => {
        const url = new URL(input instanceof Request ? input.url : String(input))
        return Response.json(answer(url))
      },
    })
    try {
      const result = await createOverleafService(runtime).inspect_build({
        projectId: PROJECT,
        ...input,
      } as Parameters<ReturnType<typeof createOverleafService>['inspect_build']>[0])
      return { result, fetches }
    } finally {
      await runtime.close()
      await rm(directory, { recursive: true, force: true })
    }
  }

  test('source_to_pdf maps a source line to its place in the PDF of a build from another process', async () => {
    const { result, fetches } = await inspect(
      { action: 'source_to_pdf', buildRef, filePath: 'chapters/intro.tex', line: 12 },
      () => ({ pdf: [{ page: 2, h: 72.5, v: 140.25, width: 343.71, height: 9.96 }], downloadedFromCache: false })
    )
    expect(fetches).toEqual([
      `GET /project/${PROJECT}/sync/code?file=chapters%2Fintro.tex&line=12&column=0&editorId=0b6c2f0e-4a4e-4f3b-9d3e-6f5c1a2b3c4d&buildId=18a2b3c4d5e-6f7a8b9c0d1e2f3a&clsiserverid=clsi-pool-2`,
    ])
    expectGolden('inspect_build', result)
  })

  test('pdf_to_source maps a point on a page back to its source line', async () => {
    const { result, fetches } = await inspect({ action: 'pdf_to_source', buildRef, page: 2, h: 100, v: 140.5 }, () => ({
      code: [{ file: './chapters/intro.tex', line: 12, column: -1 }],
      downloadedFromCache: false,
    }))
    expect(fetches).toEqual([
      `GET /project/${PROJECT}/sync/pdf?page=2&h=100.00&v=140.50&editorId=0b6c2f0e-4a4e-4f3b-9d3e-6f5c1a2b3c4d&buildId=18a2b3c4d5e-6f7a8b9c0d1e2f3a&clsiserverid=clsi-pool-2`,
    ])
    expect(result).toMatchObject({ locations: [{ filePath: 'chapters/intro.tex', line: 12 }] })
    expectGolden('inspect_build', result)
  })

  test('word_count counts the current sources and drops texcount messages', async () => {
    const { result, fetches } = await inspect({ action: 'word_count', filePath: 'main.tex' }, () => ({
      texcount: {
        encode: 'utf8',
        textWords: 7412,
        headWords: 38,
        outside: 211,
        headers: 9,
        elements: 6,
        mathInline: 54,
        mathDisplay: 12,
        errors: 0,
        messages: '!!! a message that quotes the document !!!\n',
      },
    }))
    expect(fetches).toEqual([`GET /project/${PROJECT}/wordcount?rootResourcePath=main.tex`])
    expect(JSON.stringify(result)).not.toContain('quotes the document')
    expect(result).toMatchObject({ wordCount: { totalWords: 7661 } })
    expectGolden('inspect_build', result)
  })

  test('an expired build is BUILD_NOT_FOUND, and an unknown answer PROTOCOL_UNSUPPORTED', async () => {
    const { runtime, directory } = await createTestRuntime({
      fetcher: async input => {
        const url = new URL(input instanceof Request ? input.url : String(input))
        if (url.pathname.endsWith('/sync/code')) return new Response(null, { status: 404 })
        return Response.json({ code: 'not a list' })
      },
    })
    try {
      const service = createOverleafService(runtime)
      await expect(
        service.inspect_build({ projectId: PROJECT, action: 'source_to_pdf', buildRef, filePath: 'main.tex', line: 1 })
      ).rejects.toMatchObject({ code: 'BUILD_NOT_FOUND' })
      await expect(
        service.inspect_build({ projectId: PROJECT, action: 'pdf_to_source', buildRef, page: 1, h: 1, v: 1 })
      ).rejects.toMatchObject({ code: 'PROTOCOL_UNSUPPORTED' })
      await expect(
        service.inspect_build({ projectId: PROJECT, action: 'pdf_to_source', page: 1, h: 1, v: 1 })
      ).rejects.toMatchObject({ code: 'NO_BUILD' })
      await expect(
        service.inspect_build({ projectId: PROJECT, action: 'pdf_to_source', buildRef, page: 1 })
      ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', details: { parameters: ['h', 'v'] } })
    } finally {
      await runtime.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
