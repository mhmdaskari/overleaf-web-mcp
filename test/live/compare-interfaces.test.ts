import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'

import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { createOverleafClient, type OverleafClient } from '../../src/client.js'
import { readConfig, type AppConfig } from '../../src/config.js'
import type { OperationInput, OperationName, OperationOutput } from '../../src/contracts/operations.js'
import { asMcpError } from '../../src/core/errors.js'
import { createProxyRoute, type ProxyRoute } from '../../src/http/proxy.js'
import type { RuntimeDependencies } from '../../src/runtime.js'

/**
 * Runs four agent tasks against one throwaway project through the three interfaces: the MCP
 * server (`node dist/cli.js serve` over stdio), spawned `node dist/cli.js` commands, and
 * `createOverleafClient` in this process. Each task runs cold (a new session) and then warm (the
 * same session again). Every task must succeed through every interface and phase, its checks
 * included, and outcomes must match across interfaces; round trips, bytes, timings, and upstream
 * requests are only measured, written to a JSON report, and never asserted.
 *
 * The report holds tool names, codes, counts, sizes, and durations, never document text, comment
 * bodies, file names, or project ids.
 */
const enabled = process.env.RUN_OVERLEAF_LIVE_TESTS === '1' && process.env.RUN_OVERLEAF_LIVE_COMPARE_TESTS === '1'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const CLI = join(ROOT, 'dist', 'cli.js')
// A dist/ built before the operation commands has dist/cli.js but no dist/cli/run.js.
const BUILD_OUTPUTS = [CLI, join(ROOT, 'dist', 'cli', 'run.js')]
const CALL_TIMEOUT_MS = 300_000
const TASK_TIMEOUT_MS = 20 * 60_000
// Overleaf refuses a compile that starts within about a second of the previous one.
const COMPILE_GAP_MS = 2_000

const INTERFACES = ['mcp', 'cli', 'sdk'] as const
type InterfaceName = (typeof INTERFACES)[number]
const PHASES = ['cold', 'warm'] as const
type Phase = (typeof PHASES)[number]
type TaskName = 'revise' | 'sync' | 'diagnose' | 'review'

/** Every (interface, phase) pair, which names that run's own files. */
const LABELS = INTERFACES.flatMap(name => PHASES.map(phase => `${name}-${phase}`))

const REVISE_DOCUMENT =
  '\\section{Introduction}\nIntroduction text for the revise task.\n\n\\section{Methods}\nMethods text for the revise task.\n'
const REVIEW_DOCUMENT = '\\section{Results}\nThe measured value is 42 units.\n'
const REVIEW_ANCHOR = 'measured value'
// A tracked suggestion away from the comment's anchor: one insert, ".0", rejected afterwards.
const REVIEW_SUGGESTION: readonly [string, string] = ['42 units', '42.0 units']
const BROKEN_DOCUMENT =
  '\\documentclass{article}\n\\begin{document}\n\\undefinedcommand Disposable diagnose test.\n\\end{document}\n'
const CHAPTER = 'Disposable chapter for the sync task.\n'
// A 1x1 PNG, enough for an upload and a hash comparison.
const FIGURE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
)

type Fetcher = NonNullable<RuntimeDependencies['fetcher']>

interface Upstream {
  requests: number
  requestBytes: number
  responseBytes: number
}

interface CallRecord {
  step: string
  tool: OperationName
  /** `check` calls verify the task afterwards and are left out of round trips and bytes. */
  purpose: 'task' | 'check'
  ok: boolean
  code: string | null
  exitCode?: number
  ms: number
  /** What an agent reads: the MCP text block, the CLI's stdout and stderr, the SDK value as JSON. */
  resultBytes: number
  /** The whole MCP tool result (text block and structuredContent); the same as resultBytes otherwise. */
  transportBytes: number
  upstream: Upstream | null
}

interface CallResult {
  ok: boolean
  value: unknown
  code: string | null
  record: Omit<CallRecord, 'step' | 'purpose'>
}

interface StartupRecord {
  /** MCP: spawn to initialized, the child's bootstrap included. SDK: createOverleafClient. CLI: null. */
  ms: number | null
  upstream: Upstream | null
  discovery?: { request: string; bytes: number; ms: number }
}

/** What must match across interfaces. Where a run failed is recorded apart, since a CLI has no startup step. */
interface Outcome {
  status: 'success' | 'failure'
  errorCode: string | null
}

interface RunRecord {
  outcome: Outcome
  /** The step or check that failed, or `startup`. */
  failedAt: string | null
  roundTrips: number
  checkCalls: number
  resultBytes: number
  transportBytes: number
  startup: StartupRecord
  timeToFirstResultMs: number | null
  callMs: number
  wallMs: number
  upstream: Upstream | null
  upstreamUnavailable?: string
  checks: Record<string, unknown>
  calls: CallRecord[]
}

interface Report {
  generatedAt: string
  project: { name: string }
  notes: string[]
  interfaces: Record<InterfaceName, Record<string, unknown>>
  tasks: Partial<Record<TaskName, Partial<Record<InterfaceName, Partial<Record<Phase, RunRecord>>>>>>
  cleanup?: { trashed: boolean; errorCode?: string }
}

/** A step that failed or a check that did not hold; it ends the run with this outcome. */
class TaskFailure extends Error {
  constructor(
    readonly failedAt: string,
    readonly errorCode: string
  ) {
    super(`${failedAt}: ${errorCode}`)
  }
}

function utf8Length(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

function camelCase(name: string): string {
  return name.replace(/_([a-z])/gu, (_match, letter: string) => letter.toUpperCase())
}

/** The code of an error rendered as `{ code, message, retryable, details? }` JSON. */
function errorCodeOf(text: string): string | undefined {
  try {
    const parsed = JSON.parse(text) as { code?: unknown }
    return typeof parsed.code === 'string' ? parsed.code : undefined
  } catch {
    return undefined
  }
}

function addUpstream(left: Upstream, right: Upstream): Upstream {
  return {
    requests: left.requests + right.requests,
    requestBytes: left.requestBytes + right.requestBytes,
    responseBytes: left.responseBytes + right.responseBytes,
  }
}

function subtractUpstream(after: Upstream, before: Upstream): Upstream {
  return {
    requests: after.requests - before.requests,
    requestBytes: after.requestBytes - before.requestBytes,
    responseBytes: after.responseBytes - before.responseBytes,
  }
}

function bodyBytes(body: RequestInit['body']): number {
  if (body === undefined || body === null) return 0
  if (typeof body === 'string') return utf8Length(body)
  if (body instanceof FormData) {
    // Field values only: the multipart boundaries and headers are not counted.
    let total = 0
    for (const [, value] of body) total += typeof value === 'string' ? utf8Length(value) : value.size
    return total
  }
  if (body instanceof ArrayBuffer) return body.byteLength
  if (ArrayBuffer.isView(body)) return body.byteLength
  return 0
}

/**
 * Counts every HTTP request the in-process client makes (REST calls and the Socket.IO handshake)
 * and the decoded bytes of each response. The response is returned untouched, so its `url` still
 * shows a redirect to the login page; a clone is read for the count.
 */
class UpstreamCounter {
  #totals: Upstream = { requests: 0, requestBytes: 0, responseBytes: 0 }
  #pending: Array<Promise<void>> = []

  constructor(private readonly base: Fetcher) {}

  readonly fetcher: Fetcher = async (input, init) => {
    this.#totals.requests += 1
    this.#totals.requestBytes += bodyBytes(init?.body)
    const response = await this.base(input, init)
    this.#pending.push(
      response
        .clone()
        .arrayBuffer()
        .then(
          buffer => {
            this.#totals.responseBytes += buffer.byteLength
          },
          () => undefined
        )
    )
    return response
  }

  async snapshot(): Promise<Upstream> {
    const pending = this.#pending
    this.#pending = []
    await Promise.allSettled(pending)
    return { ...this.#totals }
  }
}

/** Every variable of this process, plus the new project in OVERLEAF_ALLOWED_PROJECTS when one is set. */
function childEnvironment(projectId: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  const allowed = env.OVERLEAF_ALLOWED_PROJECTS
  // A project created by one process is allowed only inside it, so the other processes need its id.
  if (allowed !== undefined && allowed.trim() !== '') env.OVERLEAF_ALLOWED_PROJECTS = `${allowed},${projectId}`
  return env
}

interface CliRun {
  exitCode: number
  stdout: string
  stderr: string
  ms: number
}

/** Runs `node dist/cli.js <args>`, with `stdin` piped in, and resolves whatever the exit code. */
async function runCli(args: string[], env: Record<string, string>, stdin?: string): Promise<CliRun> {
  const started = performance.now()
  return await new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [CLI, ...args],
      { cwd: ROOT, env, timeout: CALL_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        const ms = performance.now() - started
        if (error === null) {
          resolve({ exitCode: 0, stdout, stderr, ms })
        } else if (typeof error.code === 'number') {
          resolve({ exitCode: error.code, stdout, stderr, ms })
        } else {
          reject(
            new Error(`${args.slice(0, 2).join(' ')} did not exit normally (${String(error.signal ?? error.code)}).`)
          )
        }
      }
    )
    child.stdin?.end(stdin)
  })
}

/**
 * The command an agent would type for a call: an alias where one covers the input exactly, else
 * `call <tool> --request -` with the request on stdin, so document text never goes in argv.
 */
function cliCommand(tool: OperationName, input: Record<string, unknown>): { args: string[]; stdin?: string } {
  const keys = Object.keys(input)
  const only = (...allowed: string[]): boolean => keys.every(key => allowed.includes(key))
  const value = (key: string): string => String(input[key])
  const option = (flag: string, key: string): string[] => (input[key] === undefined ? [] : [flag, value(key)])
  switch (tool) {
    case 'read_file':
      if (only('projectId', 'filePath')) return { args: ['files', 'read', value('projectId'), value('filePath')] }
      break
    case 'plan_sync':
      if (only('projectId', 'localFolderPath', 'destinationFolderPath')) {
        return {
          args: [
            'sync',
            'plan',
            value('projectId'),
            value('localFolderPath'),
            ...option('--destination', 'destinationFolderPath'),
          ],
        }
      }
      break
    case 'sync_directory':
      if (only('projectId', 'localFolderPath', 'destinationFolderPath', 'mode', 'planToken')) {
        return {
          args: [
            'sync',
            'apply',
            value('projectId'),
            value('localFolderPath'),
            ...option('--mode', 'mode'),
            ...option('--plan-token', 'planToken'),
            ...option('--destination', 'destinationFolderPath'),
          ],
        }
      }
      break
    case 'compile_project':
      if (only('projectId', 'rootFilePath')) {
        return { args: ['compile', 'run', value('projectId'), ...option('--root', 'rootFilePath')] }
      }
      break
    case 'get_compile_log':
      if (only('projectId', 'buildRef', 'format') && input.format === 'errors-only') {
        return { args: ['compile', 'log', value('projectId'), '--build-ref', value('buildRef'), '--errors-only'] }
      }
      break
    case 'list_tracked_changes':
      if (only('projectId', 'filePath')) {
        return { args: ['tracked-changes', 'list', value('projectId'), ...option('--file', 'filePath')] }
      }
      break
    case 'manage_tracked_changes':
      if (only('projectId', 'filePath', 'revision', 'action', 'changeIds', 'confirmCount')) {
        const changeIds = input.changeIds as string[]
        return {
          args: [
            'tracked-changes',
            value('action'),
            value('projectId'),
            value('filePath'),
            '--revision',
            value('revision'),
            ...changeIds.flatMap(id => ['--change', id]),
            ...option('--confirm-count', 'confirmCount'),
          ],
        }
      }
      break
    case 'list_comments':
      if (only('projectId', 'filePath', 'status')) {
        return {
          args: [
            'comments',
            'list',
            value('projectId'),
            ...option('--file', 'filePath'),
            ...option('--status', 'status'),
          ],
        }
      }
      break
    default:
      break
  }
  return { args: ['call', tool, '--request', '-'], stdin: JSON.stringify(input) }
}

/** One interface. A cold run calls `start()` first; a warm run reuses what it started. */
interface Driver {
  readonly name: InterfaceName
  start(): Promise<StartupRecord>
  call(tool: OperationName, input: Record<string, unknown>): Promise<CallResult>
  stop(): Promise<void>
}

function notStarted(tool: OperationName, code: string): CallResult {
  return {
    ok: false,
    value: undefined,
    code,
    record: { tool, ok: false, code, ms: 0, resultBytes: 0, transportBytes: 0, upstream: null },
  }
}

class McpDriver implements Driver {
  readonly name = 'mcp' as const
  #client: Client | undefined
  #stderr = ''
  #startupFailure: string | undefined

  constructor(private readonly env: Record<string, string>) {}

  async start(): Promise<StartupRecord> {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI, 'serve'],
      // The transport passes on only a few variables by default; the session and policy need all.
      env: this.env,
      cwd: ROOT,
      stderr: 'pipe',
    })
    // Drained from the start, so a chatty child never blocks; only a startup error's code is read.
    transport.stderr?.on('data', (chunk: Buffer) => {
      this.#stderr = (this.#stderr + chunk.toString('utf8')).slice(-4_096)
    })
    const client = new Client({ name: 'overleaf-live-compare', version: '1.0.0' })
    const started = performance.now()
    try {
      await client.connect(transport)
    } catch {
      await client.close().catch(() => undefined)
      const lastLine = this.#stderr.trim().split('\n').at(-1) ?? ''
      this.#startupFailure = errorCodeOf(lastLine) ?? 'TRANSPORT_CLOSED'
      throw new TaskFailure('startup', this.#startupFailure)
    }
    const ms = performance.now() - started
    // Kept before anything else can throw, so stop() always ends the child.
    this.#client = client
    // What a client reads before its first call; it also lets callTool check structuredContent.
    const listed = performance.now()
    const tools = await client.listTools()
    const discovery = {
      request: 'tools/list',
      bytes: utf8Length(JSON.stringify(tools)),
      ms: performance.now() - listed,
    }
    return { ms, upstream: null, discovery }
  }

  async call(tool: OperationName, input: Record<string, unknown>): Promise<CallResult> {
    const client = this.#client
    if (client === undefined) return notStarted(tool, this.#startupFailure ?? 'NOT_STARTED')
    const started = performance.now()
    let result: Awaited<ReturnType<Client['callTool']>>
    try {
      result = await client.callTool({ name: tool, arguments: input }, { timeout: CALL_TIMEOUT_MS })
    } catch (error) {
      const raw = (error as { code?: unknown }).code
      const code = `MCP_CLIENT_${typeof raw === 'string' || typeof raw === 'number' ? String(raw) : 'ERROR'}`
      return notStarted(tool, code)
    }
    const ms = performance.now() - started
    let text = ''
    for (const block of result.content) {
      if (block.type === 'text') text += block.text
    }
    const record = {
      tool,
      ms,
      resultBytes: utf8Length(text),
      transportBytes: utf8Length(JSON.stringify(result)),
      upstream: null,
    }
    if (result.isError === true) {
      const code = errorCodeOf(text) ?? 'UNRECOGNIZED'
      return { ok: false, value: undefined, code, record: { ...record, ok: false, code } }
    }
    return { ok: true, value: result.structuredContent, code: null, record: { ...record, ok: true, code: null } }
  }

  async stop(): Promise<void> {
    const client = this.#client
    this.#client = undefined
    // Ends stdin; serve waits for running calls, closes its sockets, and exits.
    await client?.close()
  }
}

class CliDriver implements Driver {
  readonly name = 'cli' as const

  constructor(private readonly env: Record<string, string>) {}

  async start(): Promise<StartupRecord> {
    // Every command is its own process with its own bootstrap, so there is no session to start.
    return { ms: null, upstream: null }
  }

  async call(tool: OperationName, input: Record<string, unknown>): Promise<CallResult> {
    const { args, stdin } = cliCommand(tool, input)
    const run = await runCli(args, this.env, stdin)
    const bytes = utf8Length(run.stdout) + utf8Length(run.stderr)
    const base = { tool, exitCode: run.exitCode, ms: run.ms, resultBytes: bytes, transportBytes: bytes, upstream: null }
    // Exit 6 is a partial bulk result, which MCP and the SDK return as a result too.
    if (run.exitCode === 0 || run.exitCode === 6) {
      try {
        const value: unknown = JSON.parse(run.stdout)
        return { ok: true, value, code: null, record: { ...base, ok: true, code: null } }
      } catch {
        return {
          ok: false,
          value: undefined,
          code: 'UNPARSEABLE_STDOUT',
          record: { ...base, ok: false, code: 'UNPARSEABLE_STDOUT' },
        }
      }
    }
    const code = errorCodeOf(run.stderr.trim()) ?? `EXIT_${run.exitCode}`
    return { ok: false, value: undefined, code, record: { ...base, ok: false, code } }
  }

  async stop(): Promise<void> {}
}

class SdkDriver implements Driver {
  readonly name = 'sdk' as const
  #client: OverleafClient | undefined
  #startupFailure: string | undefined

  constructor(
    private readonly config: AppConfig,
    private readonly counter: UpstreamCounter
  ) {}

  async start(): Promise<StartupRecord> {
    const before = await this.counter.snapshot()
    const started = performance.now()
    try {
      this.#client = await createOverleafClient({
        config: this.config,
        dependencies: { fetcher: this.counter.fetcher },
      })
    } catch (error) {
      this.#startupFailure = asMcpError(error).code
      throw new TaskFailure('startup', this.#startupFailure)
    }
    const ms = performance.now() - started
    return { ms, upstream: subtractUpstream(await this.counter.snapshot(), before) }
  }

  async call(tool: OperationName, input: Record<string, unknown>): Promise<CallResult> {
    const client = this.#client
    if (client === undefined) return notStarted(tool, this.#startupFailure ?? 'NOT_STARTED')
    const method = (client as unknown as Record<string, ((input: object) => Promise<unknown>) | undefined>)[
      camelCase(tool)
    ]
    if (method === undefined) return notStarted(tool, 'NO_SUCH_METHOD')
    const before = await this.counter.snapshot()
    const started = performance.now()
    let ok: boolean
    let value: unknown
    let code: string | null
    let rendered: string
    try {
      value = await method(input)
      ok = true
      code = null
      rendered = JSON.stringify(value, null, 2)
    } catch (error) {
      const failure = asMcpError(error)
      ok = false
      code = failure.code
      rendered = JSON.stringify(failure.toJSON(), null, 2)
    }
    const ms = performance.now() - started
    const upstream = subtractUpstream(await this.counter.snapshot(), before)
    const bytes = utf8Length(rendered)
    return { ok, value, code, record: { tool, ok, code, ms, resultBytes: bytes, transportBytes: bytes, upstream } }
  }

  async stop(): Promise<void> {
    const client = this.#client
    this.#client = undefined
    await client?.close()
  }
}

/** One task through one interface in one phase: its calls, checks, and first result time. */
class TaskRun {
  readonly calls: CallRecord[] = []
  readonly checks: Record<string, unknown> = {}
  firstResultAt: number | undefined

  constructor(
    readonly driver: Driver,
    readonly projectId: string,
    readonly label: string,
    readonly folder: string
  ) {}

  async attempt<N extends OperationName>(
    step: string,
    tool: N,
    input: OperationInput<N>,
    purpose: 'task' | 'check' = 'task'
  ): Promise<CallResult> {
    const result = await this.driver.call(tool, input as Record<string, unknown>)
    this.firstResultAt ??= performance.now()
    this.calls.push({ step, purpose, ...result.record })
    return result
  }

  async ok<N extends OperationName>(
    step: string,
    tool: N,
    input: OperationInput<N>,
    purpose: 'task' | 'check' = 'task'
  ): Promise<OperationOutput<N>> {
    const result = await this.attempt(step, tool, input, purpose)
    if (!result.ok) throw new TaskFailure(step, result.code ?? 'UNKNOWN')
    return result.value as OperationOutput<N>
  }

  check(name: string, holds: boolean): void {
    if (!holds) throw new TaskFailure(name, 'CHECK_FAILED')
  }

  need<T>(name: string, value: T | undefined): T {
    if (value === undefined) throw new TaskFailure(name, 'CHECK_FAILED')
    return value
  }
}

let lastCompileAt = 0

async function compileGap(): Promise<void> {
  const wait = lastCompileAt + COMPILE_GAP_MS - Date.now()
  if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait))
}

/** 1-based line and UTF-16 column of the first occurrence, with an end just past it. */
function locate(content: string, text: string) {
  const lines = content.split('\n')
  for (const [index, line] of lines.entries()) {
    const column = line.indexOf(text)
    if (column >= 0) {
      return {
        start: { line: index + 1, column: column + 1 },
        end: { line: index + 1, column: column + 1 + text.length },
      }
    }
  }
  return undefined
}

interface TaskDefinition {
  name: TaskName
  title: string
  /** Runs before the run's clock starts. */
  before?: () => Promise<void>
  run(run: TaskRun): Promise<void>
}

const TASKS: readonly TaskDefinition[] = [
  {
    name: 'revise',
    title: 'revising one section, then refusing a stale-revision write',
    run: async run => {
      const { projectId } = run
      const filePath = `revise-${run.label}.tex`
      const outline = await run.ok('get_sections', 'get_sections', { projectId, filePath })
      const methods = run.need(
        'methods_section_found',
        outline.sections.find(section => section.title === 'Methods')
      )
      const section = await run.ok('get_section_content', 'get_section_content', {
        projectId,
        filePath,
        sectionId: methods.id,
      })
      await run.ok('write_section', 'write_section', {
        projectId,
        filePath,
        revision: section.revision,
        sectionId: methods.id,
        content: section.content.replace('Methods text', 'Revised methods text'),
      })
      // The revision read before the write is stale now; the write must be refused, not applied.
      const stale = await run.attempt('stale_write_section', 'write_section', {
        projectId,
        filePath,
        revision: section.revision,
        sectionId: methods.id,
        content: section.content.replace('Methods text', 'Stale methods text'),
      })
      run.checks.conflictOutcome = stale.ok ? 'applied' : stale.code
      run.check('stale_write_refused_with_revision_conflict', !stale.ok && stale.code === 'REVISION_CONFLICT')
    },
  },
  {
    name: 'sync',
    title: 'syncing figures and sources, then re-planning',
    run: async run => {
      const { projectId } = run
      const localFolderPath = join(run.folder, `sync-${run.label}`)
      const destinationFolderPath = `sync-${run.label}`
      const plan = await run.ok('plan_sync', 'plan_sync', { projectId, localFolderPath, destinationFolderPath })
      run.checks.plannedUploads = plan.toUpload.length
      const applied = await run.ok('sync_directory', 'sync_directory', {
        projectId,
        localFolderPath,
        destinationFolderPath,
        mode: 'additive',
        planToken: plan.planToken,
      })
      run.checks.syncStatus = applied.status
      run.checks.completedSteps = applied.completed.length
      run.checks.failedSteps = applied.failed.length
      run.check('sync_complete', applied.status === 'complete' && applied.failed.length === 0)
      const again = await run.ok('plan_sync_again', 'plan_sync', { projectId, localFolderPath, destinationFolderPath })
      run.checks.toUploadAfterSync = again.toUpload.length
      run.check('nothing_left_to_upload', again.toUpload.length === 0)
    },
  },
  {
    name: 'diagnose',
    title: 'diagnosing a failed build from one compile',
    before: compileGap,
    run: async run => {
      const { projectId } = run
      const filePath = `diagnose-${run.label}.tex`
      await run.ok('create_file', 'create_file', { projectId, filePath, content: BROKEN_DOCUMENT })
      let build: OperationOutput<'compile_project'>
      try {
        build = await run.ok('compile_project', 'compile_project', { projectId, rootFilePath: filePath })
      } finally {
        lastCompileAt = Date.now()
      }
      const located = build.summary.errors.filter(entry => entry.file !== undefined && entry.line !== undefined)
      run.checks.compileCalls = 1
      run.checks.status = build.status
      run.checks.builtCleanly = build.summary.builtCleanly
      run.checks.errorCount = build.summary.errorCount
      run.checks.errorsLocated = located.length
      run.checks.errorInWrittenFile = located.some(entry => entry.file === filePath)
      run.checks.compileResultBytes = run.calls.at(-1)?.resultBytes ?? null
      run.checks.pdfSizeBytes = build.summary.pdfSizeBytes ?? null
      run.checks.buildRefPresent = build.buildRef !== undefined
      run.checks.outputFileCount = build.outputFiles.length
      run.checks.pdfInOutput = build.outputFiles.some(file => file.path === 'output.pdf')
      run.checks.logInOutput = build.outputFiles.some(file => file.path === 'output.log')
      run.check('build_not_clean', !build.summary.builtCleanly)
      run.check('errors_located', located.length > 0)
      const buildRef = run.need('build_ref_present', build.buildRef)
      // The log of the same build, by buildRef: no second compile is needed to read it.
      const log = await run.ok('get_compile_log', 'get_compile_log', { projectId, buildRef, format: 'errors-only' })
      run.checks.logErrorLines = log.errorLines.length
      run.checks.extraCompileNeeded = false
    },
  },
  {
    name: 'review',
    title: 'resolving a review task on a comment thread and a tracked change',
    run: async run => {
      const { projectId } = run
      const filePath = `review-${run.label}.tex`
      const before = await run.ok('read_file', 'read_file', { projectId, filePath })
      const range = run.need('anchor_text_found', locate(before.content, REVIEW_ANCHOR))
      const added = await run.ok('add_comment', 'add_comment', {
        projectId,
        filePath,
        revision: before.revision,
        ...range,
        expectedText: REVIEW_ANCHOR,
        content: 'Please give the source of this value.',
      })
      const listed = await run.ok('list_comments', 'list_comments', { projectId, filePath, status: 'open' })
      const thread = listed.threads.find(candidate => candidate.id === added.threadId)
      run.checks.threadListed = thread !== undefined
      run.checks.threadLocated = thread?.filePath === filePath && thread.start !== undefined
      run.check('thread_listed', thread !== undefined)
      await run.ok('reply_to_comment', 'reply_to_comment', {
        projectId,
        threadId: added.threadId,
        content: 'The source is now cited.',
      })
      // A reply changes no document text, so the revision add_comment returned is still current.
      const resolved = await run.ok('set_comment_status', 'set_comment_status', {
        projectId,
        filePath,
        revision: added.revision,
        threadId: added.threadId,
        status: 'resolved',
      })
      run.checks.finalStatus = resolved.status
      // A tracked suggestion, listed and rejected, which leaves the text as it was before it.
      const [from, to] = REVIEW_SUGGESTION
      await run.ok('write_file_tracked', 'write_file', {
        projectId,
        filePath,
        revision: resolved.revision,
        content: before.content.replace(from, to),
        writeMode: 'tracked',
      })
      const suggestions = await run.ok('list_tracked_changes', 'list_tracked_changes', { projectId, filePath })
      const changes = suggestions.documents[0]?.changes ?? []
      run.checks.trackedChangesListed = changes.length
      run.checks.trackedChangeByAuthor = changes.every(change => change.authorId !== null)
      run.check('one_tracked_insert_listed', changes.length === 1 && changes[0]?.type === 'insert')
      const document = run.need('tracked_document_listed', suggestions.documents[0])
      const decided = await run.ok('manage_tracked_changes', 'manage_tracked_changes', {
        projectId,
        filePath,
        revision: document.revision,
        action: 'reject',
        changeIds: changes.map(change => change.changeId),
        confirmCount: changes.length,
      })
      run.checks.remainingChangeCount = decided.remainingChangeCount
      run.check('tracked_change_rejected', decided.remainingChangeCount === 0)
      const after = await run.ok('read_back', 'read_file', { projectId, filePath }, 'check')
      run.checks.accidentalMutations = after.content === before.content ? 0 : 1
      run.check('document_unchanged', after.content === before.content)
    },
  },
]

describe.skipIf(!enabled)('one task set through MCP, the command line, and the SDK', () => {
  const name = `mcp-compare-${Date.now()}`
  const report: Report = {
    generatedAt: new Date().toISOString(),
    project: { name },
    notes: [
      'cold runs start a new session (a serve process, or an SDK client); warm runs reuse it. Every CLI command is its own process, cold or warm.',
      'roundTrips and resultBytes count task calls only; checkCalls are verification reads made afterwards.',
      'resultBytes: the MCP text block, the CLI stdout plus stderr, or the SDK value as JSON.stringify(value, null, 2); transportBytes for MCP is the whole tool result, structuredContent included.',
      'startup.ms: MCP is spawn to initialized, including the child bootstrap GET /project; SDK is createOverleafClient; CLI is null because each command call ms includes its own process start and bootstrap (see interfaces.cli.processBaselineMs for a command with no session).',
      'upstream counts HTTP requests (REST and the Socket.IO handshake) through a counting fetcher, decoded response bytes, and request body bytes (multipart counted by field values only). WebSocket frames are not counted. Spawned processes take no fetcher, so their upstream is null.',
      'The SDK runs src/ under vitest; serve and the CLI run dist/, so rebuild before comparing.',
    ],
    interfaces: { mcp: {}, cli: {}, sdk: {} },
    tasks: {},
  }
  let reportPath: string
  let scratch: string
  let projectId: string | undefined
  let setup: OverleafClient | undefined
  let env: Record<string, string>
  let config: AppConfig
  let proxy: ProxyRoute | undefined
  let counter: UpstreamCounter

  beforeAll(async () => {
    if (BUILD_OUTPUTS.some(path => !existsSync(path))) {
      throw new Error('dist/ is missing or predates the operation commands; run npm run build first.')
    }
    reportPath =
      process.env.OVERLEAF_LIVE_COMPARE_REPORT ??
      join(await mkdtemp(join(tmpdir(), 'overleaf-compare-report-')), 'compare-interfaces.json')
    scratch = await mkdtemp(join(tmpdir(), 'overleaf-live-compare-'))

    setup = await createOverleafClient()
    const created = await setup.createProject({ name })
    projectId = created.projectId
    env = childEnvironment(projectId)
    config = readConfig(env)
    // The counting fetcher keeps a configured proxy, as the runtime's own fetcher would.
    proxy = config.proxyUrl === undefined ? undefined : createProxyRoute(config.proxyUrl)
    const base: Fetcher = proxy?.fetcher ?? (async (input, init) => await fetch(input, init))
    counter = new UpstreamCounter(base)

    // Each run gets its own documents and sync folder, so no run sees another's changes.
    const seed = join(scratch, 'seed')
    await mkdir(seed)
    for (const label of LABELS) {
      await writeFile(join(seed, `revise-${label}.tex`), REVISE_DOCUMENT)
      await writeFile(join(seed, `review-${label}.tex`), REVIEW_DOCUMENT)
      const folder = join(scratch, `sync-${label}`)
      await mkdir(join(folder, 'figures'), { recursive: true })
      await writeFile(join(folder, 'chapter.tex'), CHAPTER)
      await writeFile(join(folder, 'figures', 'plot.png'), FIGURE)
    }
    const plan = await setup.planSync({ projectId, localFolderPath: seed })
    const seeded = await setup.syncDirectory({
      projectId,
      localFolderPath: seed,
      mode: 'additive',
      planToken: plan.planToken,
    })
    if (seeded.status !== 'complete') throw new Error('Seeding the throwaway project did not complete.')

    // What the CLI costs before any session: node start-up and module loading.
    const baselines: number[] = []
    for (let attempt = 0; attempt < 3; attempt += 1) {
      baselines.push((await runCli(['schema', 'read_file', '--input'], env)).ms)
    }
    const help = await runCli(['--help'], env)
    report.interfaces.cli = {
      process: 'node dist/cli.js <command>, one process per call',
      processBaselineMs: Math.min(...baselines),
      discovery: { request: '--help', bytes: utf8Length(help.stdout) },
    }
    report.interfaces.mcp = { process: 'node dist/cli.js serve over stdio, one per task', upstream: null }
    report.interfaces.sdk = {
      process: 'createOverleafClient in the test process, one client per task',
      upstream: 'counted through an injected fetcher',
    }
  }, 10 * 60_000)

  afterAll(async () => {
    let cleanupFailure: string | undefined
    if (setup !== undefined && projectId !== undefined) {
      try {
        // Trash, never delete: a failed run must leave something a human can inspect.
        await setup.manageProject({ projectId, action: 'trash', confirmName: name })
        report.cleanup = { trashed: true }
      } catch (error) {
        cleanupFailure = asMcpError(error).code
        report.cleanup = { trashed: false, errorCode: cleanupFailure }
      }
    }
    await setup?.close()
    await proxy?.close()
    if (reportPath !== undefined) {
      await mkdir(dirname(reportPath), { recursive: true })
      await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
      console.log(`Interface comparison report: ${reportPath}`)
    }
    if (scratch !== undefined) await rm(scratch, { recursive: true, force: true })
    if (cleanupFailure !== undefined) {
      throw new Error(`Could not trash ${name} (${cleanupFailure}); trash it in the web UI.`)
    }
  }, 5 * 60_000)

  function driverFor(which: InterfaceName): Driver {
    switch (which) {
      case 'mcp':
        return new McpDriver(env)
      case 'cli':
        return new CliDriver(env)
      case 'sdk':
        return new SdkDriver(config, counter)
    }
  }

  async function runPhase(task: TaskDefinition, driver: Driver, phase: Phase): Promise<RunRecord> {
    await task.before?.()
    const run = new TaskRun(driver, projectId ?? '', `${driver.name}-${phase}`, scratch)
    const started = performance.now()
    let startup: StartupRecord = { ms: null, upstream: null }
    let outcome: Outcome = { status: 'success', errorCode: null }
    let failedAt: string | null = null
    try {
      if (phase === 'cold') startup = await driver.start()
      await task.run(run)
    } catch (error) {
      if (!(error instanceof TaskFailure)) throw error
      outcome = { status: 'failure', errorCode: error.errorCode }
      failedAt = error.failedAt
    }
    const wallMs = performance.now() - started
    const taskCalls = run.calls.filter(call => call.purpose === 'task')
    const sum = (pick: (call: CallRecord) => number): number => taskCalls.reduce((total, call) => total + pick(call), 0)
    let upstream: Upstream | null = null
    if (driver.name === 'sdk') {
      // The session's own start-up requests plus the task calls'; verification reads are left out.
      upstream = taskCalls.reduce(
        (total, call) => (call.upstream === null ? total : addUpstream(total, call.upstream)),
        startup.upstream ?? { requests: 0, requestBytes: 0, responseBytes: 0 }
      )
    }
    return {
      outcome,
      failedAt,
      roundTrips: taskCalls.length,
      checkCalls: run.calls.length - taskCalls.length,
      resultBytes: sum(call => call.resultBytes),
      transportBytes: sum(call => call.transportBytes),
      startup,
      timeToFirstResultMs: run.firstResultAt === undefined ? null : run.firstResultAt - started,
      callMs: sum(call => call.ms),
      wallMs,
      upstream,
      ...(upstream === null ? { upstreamUnavailable: 'spawned process: no fetcher can be injected' } : {}),
      checks: run.checks,
      calls: run.calls,
    }
  }

  for (const task of TASKS) {
    test(
      `${task.title} succeeds with the same outcome through all three interfaces`,
      async () => {
        const results: Partial<Record<InterfaceName, Partial<Record<Phase, RunRecord>>>> = {}
        report.tasks[task.name] = results
        for (const which of INTERFACES) {
          const driver = driverFor(which)
          const phases: Partial<Record<Phase, RunRecord>> = {}
          results[which] = phases
          try {
            for (const phase of PHASES) phases[phase] = await runPhase(task, driver, phase)
          } finally {
            await driver.stop()
          }
        }
        const outcomes = Object.fromEntries(
          INTERFACES.map(which => [which, { cold: results[which]?.cold?.outcome, warm: results[which]?.warm?.outcome }])
        )
        console.log(`${task.name}: ${JSON.stringify(outcomes)}`)
        // A check that fails the same way everywhere, such as a stale write that applied, still fails the task.
        for (const which of INTERFACES) {
          for (const phase of PHASES) {
            const run = results[which]?.[phase]
            expect(run?.outcome, `${task.name} ${which} ${phase} (${run?.failedAt ?? 'ok'})`).toEqual({
              status: 'success',
              errorCode: null,
            })
          }
        }
        expect(outcomes.cli).toEqual(outcomes.mcp)
        expect(outcomes.sdk).toEqual(outcomes.mcp)
      },
      TASK_TIMEOUT_MS
    )
  }
})
