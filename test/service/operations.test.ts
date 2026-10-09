import { describe, expect, test, vi } from 'vitest'

import { OPERATION_NAMES, OPERATIONS, type OperationName } from '../../src/contracts/operations.js'
import { McpError } from '../../src/core/errors.js'
import { createOverleafService } from '../../src/service/operations.js'
import { INPUTS } from '../helpers/operation-inputs.js'

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
