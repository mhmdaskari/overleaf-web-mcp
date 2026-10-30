import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CookieJar } from 'tough-cookie'
import { describe, expect, test, vi } from 'vitest'

import { McpError } from '../../src/core/errors.js'
import { OverleafHttpClient } from '../../src/http/client.js'
import { CompileApi, MAX_LOG_BYTES, decodeBuildRef } from '../../src/overleaf/compile.js'

const BUILD = '18a2b3c4d5e-9f8e7d6c5b4a3210'
const SENTINEL = 'SENTINEL-c0mpile-9d1e'
const PDF = '%PDF-1.5\n%fixture\n'

const fixture = async (name: string): Promise<string> =>
  await readFile(join(import.meta.dirname, '..', 'fixtures', 'compile', name), 'utf8')

const root = {
  id: 'root-doc',
  path: 'main.tex',
  name: 'main.tex',
  type: 'doc' as const,
  parentFolderId: 'root',
}

function outputs(...paths: string[]): Array<Record<string, unknown>> {
  return paths.map(path => ({
    path,
    type: path.split('.').at(-1),
    build: BUILD,
    url: `https://elsewhere.test/project/p/build/${BUILD}/output/${path}`,
  }))
}

interface HarnessOptions {
  /** The compile response body, or a Response for the compile request. */
  compile?: unknown
  /** Output files by path; a missing one answers 404. */
  files?: Record<string, string>
}

/** A CompileApi over the real HTTP client and a fetcher that records every URL it is asked for. */
function harness(options: HarnessOptions = {}) {
  const requests: Array<{ url: URL; method: string; body?: unknown }> = []
  const files = options.files ?? {}
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    requests.push({
      url,
      method: init?.method ?? 'GET',
      ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) } : {}),
    })
    if (url.pathname.endsWith('/compile')) {
      if (options.compile instanceof Response) return options.compile
      return Response.json(options.compile ?? { status: 'success', outputFiles: [] })
    }
    const output = /\/build\/[^/]+\/output\/(.+)$/u.exec(url.pathname)
    const body = output === null ? undefined : files[decodeURIComponent(output[1]!)]
    return body === undefined ? new Response('missing', { status: 404 }) : new Response(body)
  })
  const http = new OverleafHttpClient({ baseUrl: 'https://overleaf.test', jar: new CookieJar(), fetcher })
  const api = new CompileApi(http, async () => root)
  return { api, http, requests, fetcher }
}

async function failure(call: () => Promise<unknown>): Promise<McpError> {
  try {
    await call()
  } catch (error) {
    if (error instanceof McpError) return error
    throw error
  }
  throw new Error('expected the call to fail')
}

describe('compile_project', () => {
  test('maps rootFilePath to rootDoc_id and rootResourcePath and posts a bounded compile request with its options', async () => {
    const { api, requests } = harness()
    await expect(
      api.compileProject('project', 'main.tex', 30_000, { stopOnFirstError: true, draft: true })
    ).resolves.toMatchObject({
      status: 'success',
      rootFilePath: 'main.tex',
    })
    expect(requests).toHaveLength(1)
    expect(requests[0]!.url.pathname).toBe('/project/project/compile')
    expect(requests[0]!.url.searchParams.get('file_line_errors')).toBe('true')
    expect(requests[0]!.body).toEqual({
      rootDoc_id: 'root-doc',
      // overleaf.com builds from rootResourcePath and falls back to the configured root without it.
      rootResourcePath: 'main.tex',
      check: 'silent',
      incrementalCompilesEnabled: true,
      stopOnFirstError: true,
      draft: true,
    })
  })

  test('a deliberate \\undefined is status success but not builtCleanly', async () => {
    const { api } = harness({
      compile: { status: 'success', outputFiles: outputs('output.pdf', 'output.log') },
      files: { 'output.log': await fixture('nonstop-errors.log'), 'output.pdf': PDF },
    })
    const result = await api.compileProject('p', 'main.tex')
    expect(result.status).toBe('success')
    expect(result.summary).toMatchObject({ status: 'success', builtCleanly: false, pdfProduced: true, logRead: true })
    expect(result.summary.errorCount).toBeGreaterThanOrEqual(1)
    expect(result.summary.errors[0]).toEqual({ file: 'main.tex', line: 5, message: 'Undefined control sequence.' })
  })

  test('a clean build is builtCleanly with its page count', async () => {
    const { api, requests } = harness({
      compile: {
        status: 'success',
        outputFiles: outputs('output.pdf', 'output.log', 'output.aux'),
        stats: { 'latexmk-errors': 0 },
      },
      files: { 'output.log': await fixture('clean.log') },
    })
    const result = await api.compileProject('p', 'main.tex')
    expect(result.summary).toMatchObject({ builtCleanly: true, errorCount: 0, pageCount: 3, pdfSizeBytes: 45678 })
    // Without a BibTeX log listed, the aux file is not read.
    expect(requests).toHaveLength(2)
    expect(result).toMatchObject({ buildId: BUILD, stats: { 'latexmk-errors': 0 } })
    expect(decodeBuildRef(result.buildRef!)).toMatchObject({ projectId: 'p', buildId: BUILD })
  })

  test('a failed build returns structured errors instead of throwing', async () => {
    const { api } = harness({
      compile: { status: 'failure', outputFiles: outputs('output.log') },
      files: { 'output.log': await fixture('classic-errors.log') },
    })
    const result = await api.compileProject('p', 'main.tex')
    expect(result.summary).toMatchObject({ status: 'failure', builtCleanly: false, pdfProduced: false, errorCount: 3 })
    expect(result.summary.errors[0]).toEqual({ line: 3, message: 'Undefined control sequence.' })
  })

  // included.aux leaves its citations to an \include'd file's own aux, so it cannot rule BibTeX out.
  test.each(['bibtex.aux', 'biblatex.aux', 'included.aux'])(
    'merges the BibTeX log into the summary when %s may cite a bibliography',
    async aux => {
      const { api } = harness({
        compile: {
          status: 'success',
          outputFiles: outputs('output.pdf', 'output.log', 'output.aux', 'output.bbl', 'output.blg'),
        },
        files: {
          'output.log': await fixture('missing-bib.log'),
          'output.aux': await fixture(aux),
          'output.blg': await fixture('missing-bib.blg'),
        },
      })
      const { summary, buildRef, outputFiles } = await api.compileProject('p', 'main.tex')
      expect(outputFiles.map(file => file.path)).toEqual(expect.arrayContaining(['output.bbl', 'output.blg']))
      expect(summary).toMatchObject({
        builtCleanly: false,
        errorCount: 1,
        missingFiles: ['refs.bib'],
        undefinedCitations: ['knuth84', 'lamport94'],
      })
      expect(decodeBuildRef(buildRef!).files).toEqual(expect.arrayContaining(['output.bbl', 'output.blg']))
    }
  )

  test("a BibTeX log left over from an earlier build is not this build's", async () => {
    // Overleaf's incremental compile directory keeps an earlier root's .blg and .bbl and lists them again.
    const { api, requests } = harness({
      compile: {
        status: 'success',
        outputFiles: outputs('output.pdf', 'output.log', 'output.aux', 'output.bbl', 'output.blg'),
      },
      files: {
        'output.log': await fixture('clean.log'),
        'output.aux': await fixture('no-bib.aux'),
        'output.bbl': '\\begin{thebibliography}{1}\n\\end{thebibliography}\n',
        'output.blg': await fixture('missing-bib.blg'),
      },
    })
    const { summary, buildRef, outputFiles } = await api.compileProject('p', 'main.tex')
    expect(summary).toMatchObject({ builtCleanly: true, errorCount: 0, undefinedCitations: [], missingFiles: [] })
    // Not offered as this build's outputs, as the output tools would refuse them.
    expect(outputFiles.map(file => file.path)).toEqual(['output.pdf', 'output.log', 'output.aux'])
    expect(requests.map(request => request.url.pathname.split('/').at(-1)).sort()).toEqual([
      'compile',
      'output.aux',
      'output.log',
    ])

    // The output tools answer as for a build in which BibTeX never ran, in this process or another.
    await expect(api.getCompileLog('p', { kind: 'bibtex' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(api.downloadCompileOutput('p', '/tmp/x.bbl', { file: 'output.bbl' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    const other = harness({ files: { 'output.blg': await fixture('missing-bib.blg') } })
    await expect(other.api.getCompileLog('p', { kind: 'bibtex', buildRef })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    expect(other.requests).toHaveLength(0)
    expect(requests).toHaveLength(3)
  })

  test('a leftover BibTeX log stays out of the output tools for a build with too many outputs to list', async () => {
    const figures = Array.from({ length: 100 }, (_, index) => `fig${index}.png`)
    const { api, requests } = harness({
      compile: {
        status: 'success',
        outputFiles: outputs('output.pdf', 'output.log', 'output.aux', 'output.bbl', 'output.blg', ...figures),
      },
      files: {
        'output.log': await fixture('clean.log'),
        'output.aux': await fixture('no-bib.aux'),
        'output.bbl': '\\begin{thebibliography}{1}\n\\end{thebibliography}\n',
        'output.blg': await fixture('missing-bib.blg'),
      },
    })
    const { summary, buildRef, outputFiles } = await api.compileProject('p', 'main.tex')
    expect(summary).toMatchObject({ builtCleanly: true, errorCount: 0, missingFiles: [] })
    expect(outputFiles.map(file => file.path)).toEqual(['output.pdf', 'output.log', 'output.aux', ...figures])
    expect(decodeBuildRef(buildRef!).files).toBeUndefined()
    const before = requests.length

    await expect(api.getCompileLog('p', { kind: 'bibtex' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(api.downloadCompileOutput('p', '/tmp/x.bbl', { file: 'output.bbl' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    expect(requests).toHaveLength(before)
    await expect(api.getCompileLog('p')).resolves.toMatchObject({ file: 'output.log' })

    const other = harness({ files: { 'output.blg': await fixture('missing-bib.blg') } })
    await expect(other.api.getCompileLog('p', { kind: 'bibtex', buildRef })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    expect(other.requests).toHaveLength(0)
    const forged = Buffer.from(
      JSON.stringify({ format: 1, projectId: 'p', buildId: BUILD, noBibliography: 'no' })
    ).toString('base64url')
    expect(() => decodeBuildRef(forged)).toThrow(McpError)
  })

  test("a \\citation without \\bibdata does not make a leftover BibTeX log this build's", async () => {
    // \cite with no \bibliography writes \citation lines but no \bibdata, so latexmk never runs BibTeX.
    const { api } = harness({
      compile: {
        status: 'success',
        outputFiles: outputs('output.pdf', 'output.log', 'output.aux', 'output.bbl', 'output.blg'),
      },
      files: {
        'output.log': await fixture('missing-bib.log'),
        'output.aux': await fixture('citation-only.aux'),
        'output.blg': await fixture('missing-bib.blg'),
      },
    })
    const { summary } = await api.compileProject('p', 'main.tex')
    // The LaTeX log's own undefined citations stay; the stale log's missing database does not.
    expect(summary).toMatchObject({
      builtCleanly: true,
      errorCount: 0,
      missingFiles: [],
      undefinedCitations: ['knuth84', 'lamport94'],
    })
    await expect(api.getCompileLog('p', { kind: 'bibtex' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  test('a BibTeX log is still merged when the aux file cannot be read, so the build is never reported clean on a guess', async () => {
    const { api } = harness({
      compile: { status: 'success', outputFiles: outputs('output.pdf', 'output.log', 'output.aux', 'output.blg') },
      files: { 'output.log': await fixture('clean.log'), 'output.blg': await fixture('missing-bib.blg') },
    })
    const { summary } = await api.compileProject('p', 'main.tex')
    expect(summary).toMatchObject({ builtCleanly: false, errorCount: 1, missingFiles: ['refs.bib'] })
    await expect(api.getCompileLog('p', { kind: 'bibtex' })).resolves.toMatchObject({ file: 'output.blg' })
  })

  test('a log that cannot be read is never reported clean', async () => {
    const { api } = harness({ compile: { status: 'success', outputFiles: outputs('output.pdf', 'output.log') } })
    const { summary } = await api.compileProject('p', 'main.tex')
    expect(summary).toMatchObject({ builtCleanly: false, pdfProduced: true, logRead: false, errorCount: 0 })
  })

  test.each([
    ['too-recently-compiled', 'COMPILE_RATE_LIMITED', true],
    ['rate-limited', 'COMPILE_RATE_LIMITED', true],
    ['autocompile-backoff', 'COMPILE_RATE_LIMITED', true],
    ['compile-in-progress', 'COMPILE_RATE_LIMITED', true],
    ['clsi-maintenance', 'COMPILE_UNAVAILABLE', true],
    ['unavailable', 'COMPILE_UNAVAILABLE', true],
    ['timedout', 'COMPILE_TIMEOUT', false],
    ['terminated', 'COMPILE_FAILED', false],
    ['exited', 'COMPILE_FAILED', false],
    ['project-too-large', 'COMPILE_FAILED', false],
    ['validation-problems', 'COMPILE_FAILED', false],
    ['something-new', 'COMPILE_FAILED', false],
  ])('status %s is %s, retryable %s', async (status, code, retryable) => {
    const { api } = harness({ compile: { status, outputFiles: [] } })
    const error = await failure(() => api.compileProject('p', 'main.tex'))
    expect(error).toMatchObject({ code, retryable })
    expect(error.details).toMatchObject({ status, rootFilePath: 'main.tex' })
  })

  test('too-recently-compiled says how long to wait', async () => {
    const { api } = harness({ compile: { status: 'too-recently-compiled', outputFiles: [] } })
    expect((await failure(() => api.compileProject('p', 'main.tex'))).details).toEqual({
      status: 'too-recently-compiled',
      rootFilePath: 'main.tex',
      retryAfterMs: 1_000,
    })
  })

  test("HTTP 429 is COMPILE_RATE_LIMITED with the server's wait", async () => {
    const { api } = harness({
      compile: new Response('slow down', { status: 429, headers: { 'retry-after': '7' } }),
    })
    const error = await failure(() => api.compileProject('p', 'main.tex'))
    expect(error).toMatchObject({ code: 'COMPILE_RATE_LIMITED', retryable: true })
    expect(error.details).toEqual({ status: 'rate-limited', rootFilePath: 'main.tex', retryAfterMs: 7_000 })
  })

  test('an empty 200 body is PROTOCOL_UNSUPPORTED', async () => {
    const { api } = harness({ compile: new Response('', { status: 200 }) })
    const error = await failure(() => api.compileProject('p', 'main.tex'))
    expect(error).toMatchObject({ code: 'PROTOCOL_UNSUPPORTED' })
    expect(error.details).toEqual({ endpoint: 'compile', expectedKeys: ['status', 'outputFiles'], receivedKeys: [] })
  })

  test('malformed output files are PROTOCOL_UNSUPPORTED', async () => {
    const { api } = harness({ compile: { status: 'success', outputFiles: 'output.pdf', 'not an identifier': 1 } })
    const error = await failure(() => api.compileProject('p', 'main.tex'))
    expect(error.code).toBe('PROTOCOL_UNSUPPORTED')
    // Keys are reported only when they are short identifiers.
    expect(error.details).toMatchObject({ receivedKeys: ['outputFiles', 'status'] })
  })

  test('nothing from the response beyond the validated fields reaches a result or an error', async () => {
    const extra = {
      timings: { compileE2E: SENTINEL },
      pdfDownloadDomain: `https://${SENTINEL}.test`,
      unknownKey: SENTINEL,
      validationProblems: { [SENTINEL]: SENTINEL },
      stats: { 'latex-runs': 2, odd: SENTINEL, [`${SENTINEL} key`]: 1, infinite: Infinity },
    }
    const succeeded = harness({
      compile: {
        status: 'success',
        outputFiles: [{ path: 'output.pdf', type: 'pdf', build: BUILD, url: SENTINEL }],
        ...extra,
      },
    })
    const result = await succeeded.api.compileProject('p', 'main.tex')
    expect(JSON.stringify(result)).not.toContain(SENTINEL)
    expect(result.outputFiles).toEqual([{ path: 'output.pdf', type: 'pdf', build: BUILD }])
    expect(result.stats).toEqual({ 'latex-runs': 2 })

    for (const status of ['timedout', 'terminated', `${SENTINEL} free text`]) {
      const { api } = harness({
        compile: { status, outputFiles: [{ path: 'output.log', type: 'log', build: BUILD, url: SENTINEL }], ...extra },
      })
      const error = await failure(() => api.compileProject('p', 'main.tex'))
      expect(JSON.stringify(error.toJSON())).not.toContain(SENTINEL)
      expect(
        Object.keys(error.details ?? {}).every(key => ['status', 'rootFilePath', 'buildId', 'buildRef'].includes(key))
      ).toBe(true)
    }
  })

  test('a timed-out build keeps its log reachable from another runtime through buildRef', async () => {
    const first = harness({ compile: { status: 'timedout', outputFiles: outputs('output.log') } })
    const error = await failure(() => first.api.compileProject('p', 'main.tex'))
    expect(error).toMatchObject({ code: 'COMPILE_TIMEOUT', details: { buildId: BUILD } })
    const buildRef = error.details!.buildRef as string

    const second = harness({ files: { 'output.log': await fixture('classic-errors.log') } })
    const log = await second.api.getCompileLog('p', { buildRef })
    expect(log.buildId).toBe(BUILD)
    expect(second.requests.map(request => request.url.pathname)).toEqual([
      `/project/p/build/${BUILD}/output/output.log`,
    ])
  })

  test('a compile request that timed out is not retryable, since the compile may still run', async () => {
    const http = {
      postJson: vi.fn(async () => {
        throw new McpError('TIMEOUT', 'timed out', { retryable: true })
      }),
      getStream: vi.fn(),
    }
    const api = new CompileApi(http, async () => root)
    await expect(api.compileProject('p', 'main.tex')).rejects.toMatchObject({ code: 'TIMEOUT', retryable: false })
    expect(http.postJson).toHaveBeenCalledTimes(1)
  })

  test("defaults to the project's configured root document when no path is given", async () => {
    const http = { postJson: vi.fn(async () => ({ status: 'success', outputFiles: [] })), getStream: vi.fn() }
    const resolvePath = vi.fn()
    const api = new CompileApi(http, resolvePath, 120_000, async () => ({
      ...root,
      id: 'configured-root',
      path: '0_main.tex',
    }))

    // A blank project ships with a stub main.tex, so the configured root is the honest default.
    await expect(api.compileProject('project')).resolves.toMatchObject({
      status: 'success',
      rootFilePath: '0_main.tex',
    })
    expect(resolvePath).not.toHaveBeenCalled()
    expect(http.postJson).toHaveBeenCalledWith(
      '/project/project/compile?file_line_errors=true',
      expect.objectContaining({ rootDoc_id: 'configured-root' }),
      { timeoutMs: 120_000 }
    )
  })

  test('asks for a root path when the project has none configured', async () => {
    const http = { postJson: vi.fn(), getStream: vi.fn() }
    const api = new CompileApi(http, vi.fn(), 120_000, async () => undefined)
    await expect(api.compileProject('project')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(http.postJson).not.toHaveBeenCalled()
  })
})

describe('download_compile_output', () => {
  const folder = async (): Promise<string> => await mkdtemp(join(tmpdir(), 'compile-output-'))

  test('writes the PDF in one call, requesting only paths under the project', async () => {
    const { api, requests } = harness({
      compile: { status: 'success', outputFiles: outputs('output.pdf', 'output.log'), clsiServerId: 'clsi-1' },
      files: { 'output.pdf': PDF, 'output.log': await fixture('clean.log') },
    })
    await api.compileProject('p', 'main.tex')
    const dir = await folder()
    const result = await api.downloadCompileOutput('p', join(dir, 'paper.pdf'))
    expect(result).toEqual({
      localPath: join(dir, 'paper.pdf'),
      file: 'output.pdf',
      sizeBytes: Buffer.byteLength(PDF),
      buildId: BUILD,
      replaced: false,
    })
    expect((await readFile(join(dir, 'paper.pdf'), 'latin1')).startsWith('%PDF-')).toBe(true)
    for (const request of requests) {
      expect(request.url.origin).toBe('https://overleaf.test')
      expect(request.url.pathname.startsWith('/project/p/')).toBe(true)
    }
    expect(requests.at(-1)!.url.searchParams.get('clsiserverid')).toBe('clsi-1')
  })

  describe('per-user compiles (Overleaf CE and Server Pro)', () => {
    const PROJECT = '0123456789abcdef01234567'
    const USER = '76543210fedcba9876543210'
    const perUser = (path: string, project = PROJECT, user = USER, build = BUILD): Record<string, unknown> => ({
      path,
      type: path.split('.').at(-1),
      build: BUILD,
      url: `/project/${project}/user/${user}/build/${build}/output/${path}`,
    })
    const outputPaths = (requests: Array<{ url: URL }>): string[] =>
      requests.map(request => request.url.pathname).filter(path => !path.endsWith('/compile'))

    test('requests outputs under the user the compile response names, and returns neither url nor user', async () => {
      const { api, requests } = harness({
        compile: {
          status: 'success',
          outputFiles: [perUser('output.pdf'), perUser('output.log')],
          clsiServerId: 'clsi-1',
        },
        files: { 'output.pdf': PDF, 'output.log': await fixture('clean.log') },
      })
      const result = await api.compileProject(PROJECT, 'main.tex')
      expect(result.summary).toMatchObject({ builtCleanly: true, logRead: true })
      expect(result.outputFiles).toEqual([
        { path: 'output.pdf', type: 'pdf', build: BUILD },
        { path: 'output.log', type: 'log', build: BUILD },
      ])
      expect(decodeBuildRef(result.buildRef!)).toMatchObject({ projectId: PROJECT, buildId: BUILD, userId: USER })

      const dir = await mkdtemp(join(tmpdir(), 'compile-output-'))
      await api.downloadCompileOutput(PROJECT, join(dir, 'paper.pdf'))
      expect(outputPaths(requests)).toEqual([
        `/project/${PROJECT}/user/${USER}/build/${BUILD}/output/output.log`,
        `/project/${PROJECT}/user/${USER}/build/${BUILD}/output/output.pdf`,
      ])
      for (const request of requests) expect(request.url.origin).toBe('https://overleaf.test')
      expect(requests.at(-1)!.url.searchParams.get('clsiserverid')).toBe('clsi-1')
    })

    test('a buildRef carries the user to a later process', async () => {
      const first = harness({ compile: { status: 'timedout', outputFiles: [perUser('output.log')] } })
      const error = await failure(() => first.api.compileProject(PROJECT, 'main.tex'))
      const second = harness({ files: { 'output.log': await fixture('classic-errors.log') } })
      await second.api.getCompileLog(PROJECT, { buildRef: error.details!.buildRef as string })
      expect(outputPaths(second.requests)).toEqual([
        `/project/${PROJECT}/user/${USER}/build/${BUILD}/output/output.log`,
      ])
    })

    test.each([
      ['another project', [perUser('output.log', 'fedcba9876543210fedcba98')]],
      ['another build', [perUser('output.log', PROJECT, USER, '1a2b3c-4d5e6f')]],
      [
        'another origin',
        [
          {
            ...perUser('output.log'),
            url: `https://elsewhere.test/project/${PROJECT}/user/${USER}/build/${BUILD}/output/output.log`,
          },
        ],
      ],
      [
        'a malformed user',
        [{ ...perUser('output.log'), url: `/project/${PROJECT}/user/../build/${BUILD}/output/output.log` }],
      ],
      ['two different users', [perUser('output.log'), perUser('output.pdf', PROJECT, 'aaaaaaaaaaaaaaaaaaaaaaaa')]],
    ])('a url naming %s is ignored, and the path stays the one without a user', async (_, outputFiles) => {
      const { api, requests } = harness({
        compile: { status: 'success', outputFiles },
        files: { 'output.log': await fixture('clean.log') },
      })
      const result = await api.compileProject(PROJECT, 'main.tex')
      expect(decodeBuildRef(result.buildRef!)).not.toHaveProperty('userId')
      expect(outputPaths(requests)).toEqual([`/project/${PROJECT}/build/${BUILD}/output/output.log`])
    })

    test('a buildRef with a user that is not an ObjectId is INVALID_ARGUMENT', async () => {
      const { api, fetcher } = harness()
      for (const userId of ['../x', 'not-hex-not-hex-not-hex!', 'abc', 7]) {
        const forged = Buffer.from(JSON.stringify({ format: 1, projectId: PROJECT, buildId: BUILD, userId })).toString(
          'base64url'
        )
        await expect(api.getCompileLog(PROJECT, { buildRef: forged })).rejects.toMatchObject({
          code: 'INVALID_ARGUMENT',
        })
      }
      expect(fetcher).not.toHaveBeenCalled()
    })
  })

  test('refuses an unsafe file before any request', async () => {
    const { api, fetcher } = harness()
    for (const file of ['../x', '/etc/passwd', 'a/../b', 'a\\b', '']) {
      await expect(api.downloadCompileOutput('p', '/tmp/x.pdf', { file })).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
      })
    }
    expect(fetcher).not.toHaveBeenCalled()
  })

  test('without a compile in this process it is NO_BUILD', async () => {
    const { api, fetcher } = harness()
    await expect(api.downloadCompileOutput('p', '/tmp/x.pdf')).rejects.toMatchObject({ code: 'NO_BUILD' })
    await expect(api.getCompileLog('p')).rejects.toMatchObject({ code: 'NO_BUILD' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  test('refuses to replace a local file without overwrite, before downloading', async () => {
    const { api, requests } = harness({
      compile: { status: 'success', outputFiles: outputs('output.pdf') },
      files: { 'output.pdf': PDF },
    })
    await api.compileProject('p', 'main.tex')
    const dir = await folder()
    const path = join(dir, 'paper.pdf')
    await writeFile(path, 'previous')
    const before = requests.length
    await expect(api.downloadCompileOutput('p', path)).rejects.toMatchObject({ code: 'CONFIRMATION_MISMATCH' })
    expect(requests.length).toBe(before)
    expect(await readFile(path, 'utf8')).toBe('previous')
    await expect(api.downloadCompileOutput('p', path, { overwrite: true })).resolves.toMatchObject({ replaced: true })
  })

  test('a file the build did not produce is NOT_FOUND, an expired build BUILD_NOT_FOUND', async () => {
    const { api } = harness({ compile: { status: 'success', outputFiles: outputs('output.pdf') } })
    await api.compileProject('p', 'main.tex')
    const dir = await folder()
    await expect(
      api.downloadCompileOutput('p', join(dir, 'a.gz'), { file: 'output.synctex.gz' })
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    await expect(api.downloadCompileOutput('p', join(dir, 'a.pdf'))).rejects.toMatchObject({ code: 'BUILD_NOT_FOUND' })
  })

  test('a .pdf that is not a PDF is refused and nothing is written', async () => {
    const { api } = harness({
      compile: { status: 'success', outputFiles: outputs('output.pdf') },
      files: { 'output.pdf': '<html>login</html>' },
    })
    await api.compileProject('p', 'main.tex')
    const dir = await folder()
    await expect(api.downloadCompileOutput('p', join(dir, 'a.pdf'))).rejects.toMatchObject({
      code: 'PROTOCOL_UNSUPPORTED',
    })
    await expect(readFile(join(dir, 'a.pdf'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('a buildRef for another project is refused', async () => {
    const { api } = harness({ compile: { status: 'success', outputFiles: outputs('output.pdf') } })
    const { buildRef } = await api.compileProject('p', 'main.tex')
    await expect(api.downloadCompileOutput('q', '/tmp/x.pdf', { buildRef })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    })
    await expect(api.getCompileLog('p', { buildRef: 'not-a-ref' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })
})

describe('get_compile_log', () => {
  test('returns a bounded tail and the error lines', async () => {
    const log = await fixture('nonstop-errors.log')
    const { api } = harness({
      compile: { status: 'success', outputFiles: outputs('output.pdf', 'output.log', 'output.aux', 'output.blg') },
      files: {
        'output.log': log,
        'output.aux': await fixture('bibtex.aux'),
        'output.blg': await fixture('missing-bib.blg'),
      },
    })
    await api.compileProject('p', 'main.tex')

    const tail = await api.getCompileLog('p', { tail: 3 })
    expect(tail.log.split('\n')).toEqual(log.trimEnd().split('\n').slice(-3))
    expect(tail.truncated).toBe(true)
    expect(tail.errorLines).toEqual([
      { line: 12, text: './main.tex:5: Undefined control sequence.' },
      { line: 22, text: "./sections/intro.tex:12: LaTeX Error: File `missing-figure.png' not found." },
    ])

    const errorsOnly = await api.getCompileLog('p', { format: 'errors-only' })
    expect(errorsOnly.log).toBe(tail.errorLines.map(line => line.text).join('\n'))
    expect(errorsOnly.truncated).toBe(false)

    const bibtex = await api.getCompileLog('p', { kind: 'bibtex', format: 'errors-only' })
    expect(bibtex).toMatchObject({ file: 'output.blg', log: "I couldn't open database file refs.bib" })
  })

  test('reads at most 1 MB', async () => {
    const big = `${'x'.repeat(100)}\n`.repeat(Math.ceil((MAX_LOG_BYTES * 2) / 101))
    const { api } = harness({
      compile: { status: 'success', outputFiles: outputs('output.log') },
      files: { 'output.log': big },
    })
    await api.compileProject('p', 'main.tex')
    const log = await api.getCompileLog('p', { tail: 5 })
    expect(log.truncated).toBe(true)
    expect(log.log.split('\n')).toHaveLength(5)
  })
})
