import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { readConfig } from '../../src/config.js'
import { McpError } from '../../src/core/errors.js'
import { OverleafRuntime } from '../../src/runtime.js'
import type { HistorySnapshot } from '../../src/protocol/ot.js'
import { resolveProjectPath } from '../../src/overleaf/tree.js'

const enabled = process.env.RUN_OVERLEAF_LIVE_TESTS === '1'

describe.skipIf(!enabled)('disposable Overleaf live project', () => {
  let runtime: OverleafRuntime
  let projectId: string

  beforeAll(async () => {
    projectId = process.env.OVERLEAF_LIVE_TEST_PROJECT_ID ?? ''
    if (!projectId) {
      throw new McpError(
        'INVALID_ARGUMENT',
        'OVERLEAF_LIVE_TEST_PROJECT_ID is required when RUN_OVERLEAF_LIVE_TESTS=1.'
      )
    }
    runtime = await OverleafRuntime.create(readConfig())
  })

  afterAll(async () => {
    await runtime?.close()
  })

  test('authenticates and joins the configured disposable project', async () => {
    await expect(runtime.authStatus()).resolves.toMatchObject({ authenticated: true })
    const tree = await runtime.entities.getProjectTree(projectId)
    expect(Array.isArray(tree.entities)).toBe(true)
    expect(tree.hashNote).toMatch(/git blob hash/u)
  })

  test.skipIf(process.env.RUN_OVERLEAF_LIVE_REVIEW_TESTS !== '1')(
    'reads review threads without mutating them when the deployment supports comments',
    async () => {
    const result = await runtime.comments.listComments(projectId, { status: 'all' })
    expect(Array.isArray(result.threads)).toBe(true)
    }
  )

  test.skipIf(process.env.RUN_OVERLEAF_LIVE_TRACKED_WRITE_TESTS !== '1')(
    'creates and verifies disposable tracked initial content',
    async () => {
      const filePath = `mcp-tracked-${Date.now()}.tex`
      try {
        const written = await runtime.createFile(
          projectId,
          filePath,
          '\\section{Tracked}\nDisposable live-test content.\n',
          'tracked'
        )
        expect(written).toMatchObject({ writeMode: 'tracked' })
        await expect(runtime.documents.readFile(projectId, filePath)).resolves.toMatchObject({
          content: '\\section{Tracked}\nDisposable live-test content.\n',
        })
        const trackingObserved = await runtime.connections.withConnection(
          projectId,
          async connection => await connection.queue.run(async () => {
            const entity = resolveProjectPath(connection.getTree(), filePath, 'doc')
            const document = await connection.joinDocument(entity.id)
            try {
              if (document.protocol === 'history-ot') {
                const snapshot = document.rawSnapshot as HistorySnapshot
                return snapshot.trackedChanges?.some(
                  change =>
                    change.tracking.type === 'insert' &&
                    change.tracking.userId === runtime.userId
                ) ?? false
              }
              const changes = (document.ranges as { changes?: unknown[] } | undefined)?.changes ?? []
              return changes.length > 0 && JSON.stringify(changes).includes(runtime.userId ?? '')
            } finally {
              await connection.leaveDocument(entity.id)
            }
          })
        )
        expect(trackingObserved).toBe(true)
      } finally {
        const tree = await runtime.entities.getProjectTree(projectId)
        if (tree.entities.some(entity => entity.path === filePath)) {
          await runtime.entities.manageEntity(projectId, {
            action: 'delete',
            path: filePath,
            confirmPath: filePath,
          })
        }
      }
    }
  )

  test.skipIf(process.env.RUN_OVERLEAF_LIVE_HISTORY_TESTS !== '1')(
    'reads recent project history without mutation',
    async () => {
      const result = await runtime.history.monitorProjectHistory(projectId)
      expect(result.projectId).toBe(projectId)
      expect(Array.isArray(result.updates)).toBe(true)
      if (result.updates[0]) {
        expect(Number.isInteger(result.updates[0].fromVersion)).toBe(true)
        expect(Number.isInteger(result.updates[0].toVersion)).toBe(true)
        expect(new Date(result.updates[0].startedAt).toISOString()).toBe(
          result.updates[0].startedAt
        )
        expect(new Date(result.updates[0].endedAt).toISOString()).toBe(
          result.updates[0].endedAt
        )
        expect(JSON.stringify(result.updates[0])).not.toContain('"email"')
      }
    }
  )
})

describe.skipIf(!enabled || process.env.RUN_OVERLEAF_LIVE_LIFECYCLE_TESTS !== '1')(
  'disposable Overleaf project lifecycle',
  () => {
    let runtime: OverleafRuntime

    beforeAll(async () => {
      runtime = await OverleafRuntime.create(readConfig())
    })

    afterAll(async () => {
      await runtime?.close()
    })

    test('creates, configures, compiles, and trashes a project without the web UI', async () => {
      const name = `mcp-lifecycle-${Date.now()}`
      const created = await runtime.projects.createProject(name, 'blank')
      try {
        expect(created.rootDocPath).toBe('main.tex')

        // The dashboard endpoint must return every project, or listing and counting would lie.
        const fetched = await runtime.account.fetchProjects()
        expect(fetched.projects).toHaveLength(fetched.totalSize)
        const listing = await runtime.account.listProjects({ query: name })
        expect(listing.projects.map(project => project.id)).toContain(created.projectId)

        await runtime.createFile(
          created.projectId,
          'paper.tex',
          '\\documentclass{article}\n\\begin{document}\nDisposable lifecycle test.\n\\end{document}\n'
        )
        const settings = await runtime.projects.updateProjectSettings(created.projectId, {
          rootFilePath: 'paper.tex',
        })
        expect(settings.rootDocPath).toBe('paper.tex')
        await expect(runtime.compile.compileProject(created.projectId)).resolves.toMatchObject({
          status: 'success',
          rootFilePath: 'paper.tex',
        })
      } finally {
        // Trash, never delete: a failed assertion must leave something a human can inspect.
        await runtime.projects.manageProject(created.projectId, { action: 'trash', confirmName: name })
        await expect(runtime.account.findProject(created.projectId)).resolves.toMatchObject({
          trashed: true,
        })
      }
    })
  }
)

describe.skipIf(!enabled || process.env.RUN_OVERLEAF_LIVE_SYNC_TESTS !== '1')(
  'disposable Overleaf folder sync',
  () => {
    let runtime: OverleafRuntime

    beforeAll(async () => {
      runtime = await OverleafRuntime.create(readConfig())
    })

    afterAll(async () => {
      await runtime?.close()
    })

    test('plans, mirrors, and re-plans a local folder into a throwaway project', async () => {
      const folder = await mkdtemp(join(tmpdir(), 'overleaf-live-sync-'))
      await mkdir(join(folder, 'sections'))
      await writeFile(
        join(folder, 'main.tex'),
        '\\documentclass{article}\n\\begin{document}\n\\input{sections/intro}\n\\end{document}\n'
      )
      await writeFile(join(folder, 'sections', 'intro.tex'), 'Disposable sync test.\n')
      await writeFile(join(folder, 'main.aux'), 'ignored build output\n')

      const name = `mcp-sync-${Date.now()}`
      const created = await runtime.projects.createProject(name, 'blank')
      try {
        const plan = await runtime.sync.planSync(created.projectId, folder)
        expect(plan.ignored.entries.map(entry => entry.localPath)).toContain('main.aux')
        expect(plan.toUpload.map(entry => entry.destinationPath)).toEqual(['main.tex', 'sections/intro.tex'])

        const result = await runtime.sync.syncDirectory(created.projectId, folder, {
          mode: 'mirror',
          planToken: plan.planToken,
          confirmDeleteCount: plan.remoteOnly.length,
        })
        expect(result.status).toBe('complete')

        const again = await runtime.sync.planSync(created.projectId, folder)
        expect(again.toUpload).toEqual([])
        expect(again.remoteOnly).toEqual([])
        expect(again.identical.count).toBe(2)
      } finally {
        await runtime.projects.manageProject(created.projectId, { action: 'trash', confirmName: name })
        await rm(folder, { recursive: true })
      }
    })
  }
)
