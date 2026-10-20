import { readBoundedBody } from '../core/bounded-body.js'
import { McpError } from '../core/errors.js'
import { prepareLocalDownload, writeDownload } from '../core/local-download.js'
import { AccessPolicy } from '../core/policy.js'
import {
  emptyLogSummary,
  isBibtexErrorLine,
  isLatexErrorLine,
  MAX_MESSAGE_LENGTH,
  mergeLogSummaries,
  parseBibtexLog,
  parseLatexLog,
  type LogSummary,
} from './compile-log.js'
import type { ProjectEntity } from './tree.js'

export interface CompileHttp {
  postJson(
    path: string,
    body?: unknown,
    options?: { timeoutMs?: number }
  ): Promise<unknown>
  getStream(
    path: string,
    options?: { timeoutMs?: number }
  ): Promise<{ body: ReadableStream<Uint8Array>; contentType?: string }>
}

/** One build output, as Overleaf lists it, without the URL it was served from. */
export interface CompileOutputFile {
  path: string
  type: string
  build?: string
}

export interface CompileSummary extends LogSummary {
  /** Overleaf's own status: `success`, `failure`, or `stopped-on-first-error`. */
  status: string
  /** A PDF was produced, the log was read, and it reports no error. The field to check. */
  builtCleanly: boolean
  pdfProduced: boolean
  /** Whether output.log was read; without it nothing is known about errors. */
  logRead: boolean
}

export interface CompileResult {
  status: string
  outputFiles: CompileOutputFile[]
  /** Overleaf's counters, numbers only. */
  stats: Record<string, number>
  buildId?: string
  clsiServerId?: string
  /** The document actually compiled, whether named by the caller or taken from the project. */
  rootFilePath: string
  /** Names this build to get_compile_log and download_compile_output, in this process or another. */
  buildRef?: string
  summary: CompileSummary
}

export interface CompileOptions {
  /** Stop at the first LaTeX error, for a short log that holds the error that matters. */
  stopOnFirstError?: boolean | undefined
  /** Skip images and other slow content, for faster text-only iteration. */
  draft?: boolean | undefined
}

export interface DownloadCompileOutputOptions {
  file?: string | undefined
  buildRef?: string | undefined
  overwrite?: boolean | undefined
}

export interface DownloadedCompileOutput {
  localPath: string
  file: string
  sizeBytes: number
  buildId: string
  replaced: boolean
}

export type CompileLogKind = 'latex' | 'bibtex'

export interface CompileLogOptions {
  buildRef?: string | undefined
  kind?: CompileLogKind | undefined
  format?: 'raw' | 'errors-only' | undefined
  tail?: number | undefined
}

export interface CompileLog {
  buildId: string
  file: string
  log: string
  /** Whether anything of the log was left out: past the read limit, before the tail, or over the size bound. */
  truncated: boolean
  errorLines: Array<{ line: number; text: string }>
}

/** How much of a log is read, as Overleaf's own editor does. */
export const MAX_LOG_BYTES = 1024 * 1024
/** How many lines of a log get_compile_log returns by default, and at most. */
export const DEFAULT_LOG_TAIL = 200
export const MAX_LOG_TAIL = 2_000
/** Characters of log text returned at most, from the end. */
export const MAX_LOG_CHARS = 100_000
/** Error lines listed at most. */
export const MAX_ERROR_LINES = 100
/** How long one output download may take. */
export const DEFAULT_OUTPUT_DOWNLOAD_TIMEOUT_MS = 5 * 60_000

/** A status Overleaf reports is echoed only in this shape; anything else is `unrecognized`. */
const COMPILE_STATUS_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u
/** Overleaf's own validation of these values, from its request schemas. */
const BUILD_ID_PATTERN = /^[0-9a-f]{1,64}-[0-9a-f]{1,64}$/u
const CLSI_SERVER_ID_PATTERN = /^[a-z0-9-]{1,128}$/u
const OUTPUT_TYPE_PATTERN = /^[a-z0-9]{1,16}$/u
const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u
const MAX_OUTPUT_PATH_LENGTH = 255
/** A buildRef lists a build's outputs only up to this many. */
const MAX_LISTED_OUTPUTS = 100
/** Builds remembered per process, one per project. */
const MAX_REMEMBERED_BUILDS = 100
const MAX_BIBTEX_LOGS = 3
/**
 * What BibTeX or Biber reads from output.aux: a citation, a database, biblatex's own records, or
 * an \include'd file's aux, which may hold any of them.
 */
const AUX_BIBLIOGRAPHY_LINE = /^\\(?:citation|bibdata|abx@aux@|@input)/mu
/** BibTeX's or Biber's outputs for output.aux. */
const BIBLIOGRAPHY_OUTPUTS = new Set(['output.blg', 'output.bbl'])

/** Statuses that mean Overleaf ran the build, whatever LaTeX made of it. */
const BUILT_STATUSES = new Set(['success', 'failure', 'stopped-on-first-error'])

const RATE_LIMITED_STATUSES = new Set([
  'too-recently-compiled',
  'rate-limited',
  'autocompile-backoff',
  'compile-in-progress',
])
const UNAVAILABLE_STATUSES = new Set(['clsi-maintenance', 'unavailable', 'clsi-unavailable'])

/** Overleaf refuses a second compile within this long of the last. */
const RECOMPILE_DELAY_MS = 1_000

interface BuildRecord {
  projectId: string
  buildId: string
  clsiServerId?: string
  /** Every output path, when there were few enough to list. */
  files?: string[]
}

interface BuildRefPayload extends BuildRecord {
  format: 1
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** An output path is relative, without `..`, backslashes, or control characters. */
export function isSafeOutputPath(path: string): boolean {
  if (path === '' || path.length > MAX_OUTPUT_PATH_LENGTH || path.startsWith('/')) return false
  // eslint-disable-next-line no-control-regex
  if (/[\\\u0000-\u001f\u007f]/u.test(path)) return false
  return path.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..')
}

function protocolError(raw: unknown): McpError {
  const receivedKeys = isRecord(raw)
    ? Object.keys(raw).filter(key => KEY_PATTERN.test(key)).sort().slice(0, 20)
    : []
  return new McpError('PROTOCOL_UNSUPPORTED', 'Overleaf answered the compile request in a shape this server does not recognize.', {
    details: { endpoint: 'compile', expectedKeys: ['status', 'outputFiles'], receivedKeys },
  })
}

/** Reduces Overleaf's response to what this server returns; nothing else of it goes further. */
function validateResponse(raw: unknown): {
  status: string
  outputFiles: CompileOutputFile[]
  stats: Record<string, number>
  clsiServerId?: string
} {
  if (!isRecord(raw) || typeof raw.status !== 'string') throw protocolError(raw)
  const listed = raw.outputFiles ?? []
  if (!Array.isArray(listed)) throw protocolError(raw)
  const outputFiles: CompileOutputFile[] = []
  for (const file of listed) {
    if (!isRecord(file) || typeof file.path !== 'string') throw protocolError(raw)
    // A path this server would refuse to request is left out rather than passed on.
    if (!isSafeOutputPath(file.path)) continue
    const extension = /\.([a-z0-9]{1,16})$/u.exec(file.path)?.[1]
    const type =
      typeof file.type === 'string' && OUTPUT_TYPE_PATTERN.test(file.type) ? file.type : (extension ?? 'file')
    outputFiles.push({
      path: file.path,
      type,
      ...(typeof file.build === 'string' && BUILD_ID_PATTERN.test(file.build) ? { build: file.build } : {}),
    })
  }
  const stats: Record<string, number> = {}
  if (isRecord(raw.stats)) {
    for (const [key, value] of Object.entries(raw.stats)) {
      if (KEY_PATTERN.test(key) && typeof value === 'number' && Number.isFinite(value)) stats[key] = value
    }
  }
  return {
    status: COMPILE_STATUS_PATTERN.test(raw.status) ? raw.status : 'unrecognized',
    outputFiles,
    stats,
    ...(typeof raw.clsiServerId === 'string' && CLSI_SERVER_ID_PATTERN.test(raw.clsiServerId)
      ? { clsiServerId: raw.clsiServerId }
      : {}),
  }
}

export function encodeBuildRef(record: BuildRecord): string {
  const payload: BuildRefPayload = { format: 1, ...record }
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

export function decodeBuildRef(token: string): BuildRecord {
  try {
    const payload = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as Partial<BuildRefPayload>
    if (
      payload.format !== 1 ||
      typeof payload.projectId !== 'string' ||
      typeof payload.buildId !== 'string' ||
      !BUILD_ID_PATTERN.test(payload.buildId) ||
      (payload.clsiServerId !== undefined &&
        (typeof payload.clsiServerId !== 'string' || !CLSI_SERVER_ID_PATTERN.test(payload.clsiServerId))) ||
      (payload.files !== undefined &&
        (!Array.isArray(payload.files) ||
          payload.files.length > MAX_LISTED_OUTPUTS ||
          !payload.files.every(file => typeof file === 'string' && isSafeOutputPath(file))))
    ) {
      throw new Error('invalid fields')
    }
    return {
      projectId: payload.projectId,
      buildId: payload.buildId,
      ...(payload.clsiServerId === undefined ? {} : { clsiServerId: payload.clsiServerId }),
      ...(payload.files === undefined ? {} : { files: payload.files }),
    }
  } catch (error) {
    throw new McpError('INVALID_ARGUMENT', 'buildRef is invalid; pass one compile_project returned.', { cause: error })
  }
}

function statusError(status: string, rootFilePath: string, record: BuildRecord | undefined): McpError {
  const details = {
    status,
    rootFilePath,
    ...(record === undefined ? {} : { buildId: record.buildId, buildRef: encodeBuildRef(record) }),
  }
  if (RATE_LIMITED_STATUSES.has(status)) {
    return new McpError(
      'COMPILE_RATE_LIMITED',
      `Overleaf did not run this compile (${status}); nothing was built. Wait, then compile once more.`,
      {
        retryable: true,
        details: { ...details, ...(status === 'too-recently-compiled' ? { retryAfterMs: RECOMPILE_DELAY_MS } : {}) },
      }
    )
  }
  if (UNAVAILABLE_STATUSES.has(status)) {
    return new McpError(
      'COMPILE_UNAVAILABLE',
      `Overleaf's compile service is unavailable (${status}); nothing was built. Try again later.`,
      { retryable: true, details }
    )
  }
  if (status === 'timedout') {
    return new McpError(
      'COMPILE_TIMEOUT',
      'The compile reached Overleaf\'s time limit for this account. Compiling again will not help by itself: try draft or stopOnFirstError, or read the partial log with get_compile_log when details has a buildRef.',
      { details }
    )
  }
  return new McpError('COMPILE_FAILED', `Overleaf ended the compile with status ${status} and no build to report on.`, {
    details,
  })
}

function outputPath(record: BuildRecord, file: string): string {
  const encoded = file.split('/').map(segment => encodeURIComponent(segment)).join('/')
  const path = `/project/${encodeURIComponent(record.projectId)}/build/${encodeURIComponent(record.buildId)}/output/${encoded}`
  return record.clsiServerId === undefined ? path : `${path}?clsiserverid=${encodeURIComponent(record.clsiServerId)}`
}

function startsLikePdf(head: Uint8Array): boolean {
  return head.byteLength >= 5 && Buffer.from(head.subarray(0, 5)).toString('latin1') === '%PDF-'
}

export class CompileApi {
  readonly #http: CompileHttp
  readonly #resolvePath: (projectId: string, path: string, type: 'doc') => Promise<ProjectEntity>
  readonly #defaultTimeoutMs: number
  readonly #resolveRootDocument:
    | ((projectId: string) => Promise<ProjectEntity | undefined>)
    | undefined
  readonly #policy: AccessPolicy
  /** The latest build of each project this process compiled, which the output tools default to. */
  readonly #latest = new Map<string, BuildRecord>()

  constructor(
    http: CompileHttp,
    resolvePath: (projectId: string, path: string, type: 'doc') => Promise<ProjectEntity>,
    defaultTimeoutMs = 120_000,
    resolveRootDocument?: (projectId: string) => Promise<ProjectEntity | undefined>,
    policy: AccessPolicy = AccessPolicy.permissive
  ) {
    this.#http = http
    this.#resolvePath = resolvePath
    this.#defaultTimeoutMs = defaultTimeoutMs
    this.#resolveRootDocument = resolveRootDocument
    this.#policy = policy
  }

  /**
   * Compiles the project, defaulting to the root document configured in Overleaf itself, and
   * reports on the build from its logs.
   *
   * A blank Overleaf project ships with a stub `main.tex`, so a project whose real manuscript
   * lives under another name compiles the stub unless a root is named or configured.
   */
  async compileProject(
    projectId: string,
    rootFilePath?: string,
    timeoutMs = this.#defaultTimeoutMs,
    options: CompileOptions = {}
  ): Promise<CompileResult> {
    this.#policy.assertProject(projectId)
    // Reading the logs afterwards is part of the call, so that read is allowed first.
    this.#policy.assertEffect('compile', 'overleaf-read')
    const boundedTimeout = Math.max(1_000, Math.min(timeoutMs, 15 * 60_000))
    const root =
      rootFilePath === undefined
        ? await this.#projectRootDocument(projectId)
        : await this.#resolvePath(projectId, rootFilePath, 'doc')
    let raw: unknown
    try {
      // file_line_errors makes TeX name the file of each error, as `./file.tex:12: message`.
      raw = await this.#http.postJson(
        `/project/${encodeURIComponent(projectId)}/compile?file_line_errors=true`,
        {
          rootDoc_id: root.id,
          // overleaf.com builds from rootResourcePath; without it, it builds the configured root.
          rootResourcePath: root.path,
          check: 'silent',
          incrementalCompilesEnabled: true,
          ...(options.stopOnFirstError === true ? { stopOnFirstError: true } : {}),
          ...(options.draft === true ? { draft: true } : {}),
        },
        { timeoutMs: boundedTimeout }
      )
    } catch (error) {
      throw this.#requestFailure(error, root.path)
    }
    const response = validateResponse(raw)
    const buildId = response.outputFiles.find(file => file.build !== undefined)?.build
    // Recorded before any throw, so a timed-out build's log stays reachable.
    const record = buildId === undefined ? undefined : this.#remember(projectId, buildId, response)
    if (!BUILT_STATUSES.has(response.status)) throw statusError(response.status, root.path, record)
    const paths = response.outputFiles.map(file => file.path)
    const bibliography =
      record !== undefined && paths.includes('output.blg') ? await this.#citesBibliography(record, paths) : false
    // Left over from an earlier build, so the output tools answer as if BibTeX never ran.
    if (bibliography === false && record?.files !== undefined) {
      record.files = record.files.filter(file => !BIBLIOGRAPHY_OUTPUTS.has(file))
    }
    // An aux file that could not be read keeps the log in, so a build is never reported clean on a guess.
    const bibtexLogs = paths.filter(path => path.endsWith('.blg') && (path !== 'output.blg' || bibliography !== false))
    return {
      status: response.status,
      outputFiles: response.outputFiles,
      stats: response.stats,
      ...(buildId === undefined ? {} : { buildId }),
      ...(response.clsiServerId === undefined ? {} : { clsiServerId: response.clsiServerId }),
      rootFilePath: root.path,
      ...(record === undefined ? {} : { buildRef: encodeBuildRef(record) }),
      summary: await this.#summarize(response.status, paths, bibtexLogs, record),
    }
  }

  /** Writes one build output, output.pdf unless named, to a local file. */
  async downloadCompileOutput(
    projectId: string,
    localPath: string,
    options: DownloadCompileOutputOptions = {}
  ): Promise<DownloadedCompileOutput> {
    this.#policy.assertProject(projectId)
    this.#policy.assertEffect('overleaf-read', 'local-write')
    const file = options.file ?? 'output.pdf'
    this.#assertOutputPath(file)
    const record = this.#build(projectId, options.buildRef)
    this.#assertListed(record, file)
    const target = await prepareLocalDownload(
      await this.#policy.resolveLocalWrite(localPath),
      options.overwrite === true
    )
    let body: ReadableStream<Uint8Array>
    try {
      body = (await this.#fetch(record, file, DEFAULT_OUTPUT_DOWNLOAD_TIMEOUT_MS)).body
    } catch (error) {
      await target.discard()
      throw error
    }
    const written = await writeDownload(body, target, file.endsWith('.pdf')
      ? {
          head: head => {
            if (!startsLikePdf(head)) {
              throw new McpError('PROTOCOL_UNSUPPORTED', `Overleaf did not return a PDF for ${file}; nothing was written.`, {
                details: { file },
              })
            }
          },
        }
      : {})
    return { localPath: target.path, file, sizeBytes: written.bytes, buildId: record.buildId, replaced: written.replaced }
  }

  /** Returns a bounded tail of a build's LaTeX or BibTeX log, and the lines that report errors. */
  async getCompileLog(projectId: string, options: CompileLogOptions = {}): Promise<CompileLog> {
    this.#policy.assertProject(projectId)
    this.#policy.assertEffect('overleaf-read')
    const kind = options.kind ?? 'latex'
    const tail = Math.max(1, Math.min(options.tail ?? DEFAULT_LOG_TAIL, MAX_LOG_TAIL))
    const record = this.#build(projectId, options.buildRef)
    const file = kind === 'bibtex' ? this.#bibtexLog(record) : 'output.log'
    this.#assertListed(record, file)
    const read = await this.#readText(record, file)
    const lines = read.text.split(/\r?\n/u)
    if (lines.at(-1) === '') lines.pop()
    const isError = kind === 'bibtex' ? isBibtexErrorLine : isLatexErrorLine
    const errors: Array<{ line: number; text: string }> = []
    lines.forEach((text, index) => {
      if (isError(text)) errors.push({ line: index + 1, text: text.slice(0, MAX_MESSAGE_LENGTH) })
    })
    const errorLines = errors.slice(0, MAX_ERROR_LINES)
    const selected = options.format === 'errors-only' ? errors.map(entry => entry.text) : lines
    const kept = selected.slice(-tail)
    let log = kept.join('\n')
    let truncated = read.truncated || kept.length < selected.length || errors.length > errorLines.length
    if (log.length > MAX_LOG_CHARS) {
      log = log.slice(log.length - MAX_LOG_CHARS)
      truncated = true
    }
    return { buildId: record.buildId, file, log, truncated, errorLines }
  }

  /** Reads up to maxBytes of one build output, for MCP resources. */
  async readCompileOutput(
    projectId: string,
    file: string,
    maxBytes: number
  ): Promise<{ bytes: Uint8Array; truncated: boolean; buildId: string }> {
    this.#policy.assertProject(projectId)
    this.#policy.assertEffect('overleaf-read')
    this.#assertOutputPath(file)
    const record = this.#build(projectId)
    this.#assertListed(record, file)
    const { body } = await this.#fetch(record, file, DEFAULT_OUTPUT_DOWNLOAD_TIMEOUT_MS)
    const read = await this.#read(body, maxBytes)
    return { ...read, buildId: record.buildId }
  }

  async stopCompile(projectId: string): Promise<{ stopped: true }> {
    this.#policy.assertProject(projectId)
    this.#policy.assertEffect('compile')
    await this.#http.postJson(`/project/${encodeURIComponent(projectId)}/compile/stop`, {})
    return { stopped: true }
  }

  async #projectRootDocument(projectId: string): Promise<ProjectEntity> {
    const root = await this.#resolveRootDocument?.(projectId)
    if (root === undefined) {
      throw new McpError(
        'INVALID_ARGUMENT',
        'This project has no root document configured in Overleaf. Pass rootFilePath, or set one in the project settings.'
      )
    }
    return root
  }

  #requestFailure(error: unknown, rootFilePath: string): unknown {
    if (!(error instanceof McpError)) return error
    if (error.code === 'RATE_LIMITED') {
      const retryAfterMs = error.details?.retryAfterMs
      return new McpError('COMPILE_RATE_LIMITED', 'Overleaf rate-limited this compile; nothing was built. Wait, then compile once more.', {
        retryable: true,
        details: {
          status: 'rate-limited',
          rootFilePath,
          ...(typeof retryAfterMs === 'number' ? { retryAfterMs } : {}),
        },
        cause: error,
      })
    }
    if (error.code === 'TIMEOUT') {
      // The compile may still be running, so asking again could start a second one.
      return new McpError(
        'TIMEOUT',
        'The compile request timed out, and Overleaf may still be compiling; it was not retried. Wait before compiling again, or call stop_compile.',
        { details: { rootFilePath }, cause: error }
      )
    }
    return error
  }

  #remember(projectId: string, buildId: string, response: { outputFiles: CompileOutputFile[]; clsiServerId?: string }): BuildRecord {
    const record: BuildRecord = {
      projectId,
      buildId,
      ...(response.clsiServerId === undefined ? {} : { clsiServerId: response.clsiServerId }),
      ...(response.outputFiles.length <= MAX_LISTED_OUTPUTS ? { files: response.outputFiles.map(file => file.path) } : {}),
    }
    this.#latest.delete(projectId)
    this.#latest.set(projectId, record)
    if (this.#latest.size > MAX_REMEMBERED_BUILDS) {
      const oldest = this.#latest.keys().next().value
      if (oldest !== undefined) this.#latest.delete(oldest)
    }
    return record
  }

  #build(projectId: string, buildRef?: string): BuildRecord {
    if (buildRef !== undefined) {
      const record = decodeBuildRef(buildRef)
      if (record.projectId !== projectId) {
        throw new McpError('INVALID_ARGUMENT', 'buildRef names a build of another project; pass the projectId it was compiled for.')
      }
      return record
    }
    const latest = this.#latest.get(projectId)
    if (latest === undefined) {
      throw new McpError(
        'NO_BUILD',
        'No compile of this project has run in this server process. Call compile_project first, or pass the buildRef an earlier compile returned.'
      )
    }
    return latest
  }

  #assertOutputPath(file: string): void {
    if (!isSafeOutputPath(file)) {
      throw new McpError('INVALID_ARGUMENT', 'file must be a relative output path such as output.pdf, without "..".', {
        details: { kind: 'invalid_output_path' },
      })
    }
  }

  #assertListed(record: BuildRecord, file: string): void {
    if (record.files !== undefined && !record.files.includes(file)) {
      throw new McpError('NOT_FOUND', `Build ${record.buildId} produced no ${file}.`, {
        details: { buildId: record.buildId, file },
      })
    }
  }

  #bibtexLog(record: BuildRecord): string {
    const logs = record.files?.filter(file => file.endsWith('.blg')) ?? []
    return logs.includes('output.blg') ? 'output.blg' : (logs[0] ?? 'output.blg')
  }

  async #fetch(record: BuildRecord, file: string, timeoutMs?: number): Promise<{ body: ReadableStream<Uint8Array> }> {
    try {
      return await this.#http.getStream(outputPath(record, file), timeoutMs === undefined ? undefined : { timeoutMs })
    } catch (error) {
      if (error instanceof McpError && error.code === 'NOT_FOUND') {
        throw new McpError(
          'BUILD_NOT_FOUND',
          `Overleaf no longer has ${file} from build ${record.buildId}; it keeps build output only for a while. Compile again.`,
          { details: { buildId: record.buildId, file }, cause: error }
        )
      }
      throw error
    }
  }

  async #read(body: ReadableStream<Uint8Array>, maxBytes: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
    try {
      return await readBoundedBody(body, maxBytes)
    } catch (error) {
      throw new McpError('REMOTE_ERROR', 'Reading the build output was interrupted.', { retryable: true, cause: error })
    }
  }

  async #readText(record: BuildRecord, file: string): Promise<{ text: string; truncated: boolean }> {
    const { body } = await this.#fetch(record, file)
    const { bytes, truncated } = await this.#read(body, MAX_LOG_BYTES)
    return { text: new TextDecoder().decode(bytes), truncated }
  }

  /**
   * Whether this build's output.aux gives BibTeX or Biber anything to read, which ties the listed
   * output.blg to this build: Overleaf's incremental compile directory keeps an earlier build's
   * .blg and .bbl and lists them again. Undefined when the aux file could not be read in full.
   */
  async #citesBibliography(record: BuildRecord, paths: string[]): Promise<boolean | undefined> {
    if (!paths.includes('output.aux')) return false
    try {
      const { text, truncated } = await this.#readText(record, 'output.aux')
      if (AUX_BIBLIOGRAPHY_LINE.test(text)) return true
      return truncated ? undefined : false
    } catch {
      return undefined
    }
  }

  async #summarize(
    status: string,
    paths: string[],
    bibtexLogs: string[],
    record: BuildRecord | undefined
  ): Promise<CompileSummary> {
    const pdfProduced = paths.includes('output.pdf')
    let parsed = emptyLogSummary()
    let logRead = false
    // A log that cannot be read leaves the build unreported, never reported clean.
    if (record !== undefined && paths.includes('output.log')) {
      try {
        parsed = parseLatexLog((await this.#readText(record, 'output.log')).text)
        logRead = true
      } catch {
        logRead = false
      }
    }
    if (record !== undefined) {
      for (const blg of bibtexLogs.slice(0, MAX_BIBTEX_LOGS)) {
        try {
          parsed = mergeLogSummaries(parsed, parseBibtexLog((await this.#readText(record, blg)).text))
        } catch {
          // The LaTeX log already reports the citations BibTeX could not resolve.
        }
      }
    }
    return {
      status,
      builtCleanly: pdfProduced && logRead && parsed.errorCount === 0,
      pdfProduced,
      logRead,
      ...parsed,
    }
  }
}
