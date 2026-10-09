import { describe, expect, test, vi } from 'vitest'

import { OPERATION_NAMES, OPERATIONS, type OperationName } from '../../src/contracts/operations.js'
import { McpError } from '../../src/core/errors.js'
import { createOverleafService } from '../../src/service/operations.js'

function fakeRuntime() {
  const resolved = () => vi.fn<(...args: any[]) => Promise<any>>(async () => ({}))
  return {
    authStatus: resolved(),
    account: { listProjects: resolved() },
    projects: {
      createProject: resolved(),
      cloneProject: resolved(),
      importProjectZip: resolved(),
      downloadProjectZip: resolved(),
      manageProject: resolved(),
      updateProjectSettings: resolved(),
    },
    entities: {
      getProjectTree: resolved(),
      manageEntity: resolved(),
      uploadFile: resolved(),
      downloadFile: resolved(),
    },
    documents: { readFile: resolved(), writeFile: resolved() },
    createFile: resolved(),
    sections: { getSections: resolved(), getSectionContent: resolved(), writeSection: resolved() },
    compile: { compileProject: resolved(), stopCompile: resolved() },
    comments: {
      listComments: resolved(),
      replyToComment: resolved(),
      addComment: resolved(),
      setCommentStatus: resolved(),
    },
    history: { monitorProjectHistory: resolved() },
    sync: { planSync: resolved(), syncDirectory: resolved(), deleteEntities: resolved(), batchUpload: resolved() },
  }
}

const position = { line: 1, column: 1 }

/** A minimal valid input for every operation. */
const INPUTS: Record<OperationName, Record<string, unknown>> = {
  auth_status: {},
  list_projects: {},
  create_project: { name: 'Paper' },
  clone_project: { sourceProjectId: 's', name: 'Copy' },
  import_project_zip: { localZipPath: '/tmp/paper.zip' },
  manage_project: { projectId: 'p', action: 'trash', confirmName: 'Paper' },
  update_project_settings: { projectId: 'p', compiler: 'xelatex' },
  get_project_tree: { projectId: 'p' },
  read_file: { projectId: 'p', filePath: 'main.tex' },
  write_file: { projectId: 'p', filePath: 'main.tex', revision: 'r', content: 'text' },
  create_file: { projectId: 'p', filePath: 'new.tex' },
  manage_entity: { projectId: 'p', action: 'delete', path: 'old.tex', confirmPath: 'old.tex' },
  upload_file: { projectId: 'p', localPath: '/tmp/a.png' },
  batch_upload: { projectId: 'p', files: [{ localPath: '/tmp/a.png', destinationPath: 'a.png' }] },
  download_file: { projectId: 'p', filePath: 'a.png', localPath: '/tmp/a.png' },
  download_project_zip: { projectId: 'p', localPath: '/tmp/p.zip' },
  plan_sync: { projectId: 'p', localFolderPath: '/tmp/paper' },
  sync_directory: { projectId: 'p', localFolderPath: '/tmp/paper', mode: 'additive', planToken: 't' },
  delete_entities: { projectId: 'p', paths: ['a.png'], confirmCount: 1 },
  get_sections: { projectId: 'p', filePath: 'main.tex' },
  get_section_content: { projectId: 'p', filePath: 'main.tex', sectionId: 's' },
  write_section: { projectId: 'p', filePath: 'main.tex', revision: 'r', sectionId: 's', content: 'x' },
  compile_project: { projectId: 'p' },
  stop_compile: { projectId: 'p' },
  list_comments: { projectId: 'p' },
  reply_to_comment: { projectId: 'p', threadId: 't', content: 'Thanks' },
  add_comment: {
    projectId: 'p',
    filePath: 'main.tex',
    revision: 'r',
    start: position,
    end: position,
    expectedText: 'x',
    content: 'Why?',
  },
  set_comment_status: { projectId: 'p', filePath: 'main.tex', revision: 'r', threadId: 't', status: 'resolved' },
  monitor_project_history: { projectId: 'p' },
}

function allMocks(runtime: ReturnType<typeof fakeRuntime>): Array<ReturnType<typeof vi.fn>> {
  return Object.values(runtime).flatMap(value =>
    typeof value === 'function' ? [value] : Object.values(value as Record<string, ReturnType<typeof vi.fn>>)
  )
}

function containsSignal(value: unknown, seen = new Set<unknown>()): boolean {
  if (value instanceof AbortSignal) return true
  if (value === null || typeof value !== 'object' || seen.has(value)) return false
  seen.add(value)
  return Object.values(value).some(item => containsSignal(item, seen))
}

describe('operation registry', () => {
  test('defines every operation once, in registration order', () => {
    expect(Object.keys(OPERATIONS)).toEqual(OPERATION_NAMES)
    expect(Object.keys(createOverleafService(fakeRuntime()))).toEqual(OPERATION_NAMES)
  })

  test('every minimal input parses against its contract', () => {
    for (const name of OPERATION_NAMES) {
      const schema = (OPERATIONS[name] as { inputSchema?: { safeParse(value: unknown): { success: boolean } } }).inputSchema
      if (schema !== undefined) expect(schema.safeParse(INPUTS[name]).success, name).toBe(true)
    }
  })
})

describe('createOverleafService', () => {
  test('reaches the domain runtime for every operation and never hands it an abort signal', async () => {
    const runtime = fakeRuntime()
    const service = createOverleafService(runtime) as unknown as Record<
      OperationName,
      (input: unknown, context?: unknown) => Promise<unknown>
    >
    const signal = AbortSignal.abort()
    for (const name of OPERATION_NAMES) {
      await service[name](INPUTS[name], { signal })
    }
    const calls = allMocks(runtime).flatMap(mock => mock.mock.calls)
    expect(calls.length).toBeGreaterThanOrEqual(OPERATION_NAMES.length)
    // Cancelling a request must never abort a write that was already submitted.
    expect(calls.some(args => containsSignal(args))).toBe(false)
  })

  test('rejects with McpError and reports only the tool and code', async () => {
    const runtime = fakeRuntime()
    runtime.documents.readFile.mockRejectedValue(new Error('socket said: secret document text'))
    runtime.compile.stopCompile.mockRejectedValue(new McpError('PERMISSION_DENIED', 'Overleaf denied this operation.'))
    const diagnostics: unknown[] = []
    const service = createOverleafService(runtime)
    const context = { onDiagnostic: (diagnostic: unknown) => diagnostics.push(diagnostic) }

    await expect(service.read_file({ projectId: 'p', filePath: 'main.tex' }, context)).rejects.toBeInstanceOf(McpError)
    await expect(service.stop_compile({ projectId: 'p' }, context)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
    expect(diagnostics).toEqual([
      { tool: 'read_file', code: 'REMOTE_ERROR' },
      { tool: 'stop_compile', code: 'PERMISSION_DENIED' },
    ])
  })

  test('a diagnostic sink that throws does not change the outcome', async () => {
    const runtime = fakeRuntime()
    runtime.compile.stopCompile.mockRejectedValue(new McpError('NOT_FOUND', 'gone'))
    const service = createOverleafService(runtime)
    await expect(
      service.stop_compile({ projectId: 'p' }, { onDiagnostic: () => { throw new Error('closed') } })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  test('shapes manage_project and manage_entity actions and refuses missing companion fields', async () => {
    const runtime = fakeRuntime()
    const service = createOverleafService(runtime)

    await expect(service.manage_project({ projectId: 'p', action: 'trash' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    })
    await expect(service.manage_entity({ projectId: 'p', action: 'delete', path: 'a.tex' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    })
    expect(runtime.projects.manageProject).not.toHaveBeenCalled()
    expect(runtime.entities.manageEntity).not.toHaveBeenCalled()

    await service.manage_entity({ projectId: 'p', action: 'move', path: 'a.tex', destinationFolderPath: 'sec' })
    expect(runtime.entities.manageEntity).toHaveBeenCalledWith('p', {
      action: 'move',
      path: 'a.tex',
      destinationFolderPath: 'sec',
    })
  })

  test('passes progress through to the sync operations', async () => {
    const runtime = fakeRuntime()
    const onProgress = vi.fn(async () => undefined)
    await createOverleafService(runtime).plan_sync({ projectId: 'p', localFolderPath: '/w' }, { onProgress })
    expect(runtime.sync.planSync).toHaveBeenCalledWith('p', '/w', expect.objectContaining({ onProgress }))
  })
})
