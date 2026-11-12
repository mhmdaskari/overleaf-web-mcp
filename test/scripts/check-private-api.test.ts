import { readFile } from 'node:fs/promises'

import { describe, expect, test } from 'vitest'

import {
  checkCatalogue,
  declaredPaths,
  featureRouters,
  parseCatalogue,
  pathMatches,
  routeDeclared,
  runCheck,
  WEB_ROUTER,
  type CatalogueRoute,
  type FetchSource,
} from '../../scripts/check-private-api.js'

const catalogue = await readFile(new URL('../../docs/private-api.md', import.meta.url), 'utf8')

const EDITOR_ROUTER = 'services/web/app/src/Features/Editor/EditorRouter.mjs'
const REALTIME_ROUTER = 'services/real-time/app/js/Router.js'

// Small stand-ins written for these tests, in the shapes Overleaf's routers use.
const FIXTURE_SOURCES: Record<string, string> = {
  [WEB_ROUTER]: [
    "import EditorRouter from './Features/Editor/EditorRouter.mjs'",
    "for (const route of ['/project', '/project/trashed']) {",
    '  webRouter.get(route, ProjectListController.projectListPage)',
    '}',
    'webRouter.post(',
    "  '/project/:Project_id/rename',",
    '  ProjectController.renameProject',
    ')',
    "webRouter.get('/Project/:Project_id/build/:build_id/output/:file(.+)', CompileController.getFileFromClsi)",
    "privateApiRouter.post('/project/:Project_id/doc/:doc_id/changes/reject', handler)",
  ].join('\n'),
  [EDITOR_ROUTER]: [
    "const fileUploadEndpoint = '/Project/:Project_id/upload'",
    'webRouter.post(fileUploadEndpoint, UploadsController.uploadFile)',
    "webRouter.delete('/project/:Project_id/doc/:entity_id', EditorHttpController.deleteDoc)",
  ].join('\n'),
  [REALTIME_ROUTER]: "client.on('joinDoc', function (docId, fromVersion, options, callback) {})",
}

function fixtureFetch(overrides: Record<string, string | undefined> = {}): FetchSource {
  const sources = { ...FIXTURE_SOURCES, ...overrides }
  return async path => sources[path]
}

function markdown(routes: string[], messages: string[] = []): string {
  return [
    '| Method and route | Sent |',
    '| --- | --- |',
    ...routes.map(route => `| ${route} | nothing |`),
    '',
    '| Message | Direction | Declared in | Used for |',
    '| --- | --- | --- | --- |',
    ...messages.map(name => `| \`${name}\` | sent | \`${REALTIME_ROUTER}\` | reading |`),
    '',
  ].join('\n')
}

const ALL_FIXTURE_ROUTES = [
  '`GET /project`',
  '`POST /project/:id/rename`',
  '`GET /project/:id/build/:buildId/output/:file`',
  '`POST /project/:id/upload?folder_id=`',
  '`DELETE /project/:id/doc/:entityId`',
  '`GET /project/:id/ranges` †',
]

function route(method: string, path: string): CatalogueRoute {
  return { method, path, line: 1, checked: true }
}

describe('reading docs/private-api.md', () => {
  test('reads every route and socket message the page lists, and nothing it cannot read', () => {
    const parsed = parseCatalogue(catalogue)
    expect(parsed.problems).toEqual([])
    expect(parsed.routes.filter(entry => entry.checked).length).toBeGreaterThanOrEqual(30)
    expect(parsed.routes.filter(entry => !entry.checked).map(entry => `${entry.method} ${entry.path}`)).toEqual(
      expect.arrayContaining(['GET /project/:id/ranges', 'POST /project/:id/doc/:docId/changes/accept'])
    )
    expect(parsed.routes.every(entry => !entry.path.includes('?'))).toBe(true)
    expect(parsed.messages.map(entry => entry.name)).toEqual(
      expect.arrayContaining(['joinDoc', 'leaveDoc', 'applyOtUpdate', 'otUpdateApplied', 'joinProjectResponse'])
    )
  })

  test('refuses a route written in a form it cannot read, so no entry is skipped silently', () => {
    for (const cell of [
      '`POST /project/:id/doc/:docId/thread/:threadId/resolve` and `/reopen`',
      '`GET /project/:id[/user/:userId]/build/:buildId/output/:file`',
      '`GET /project` when signed in',
      'GET /project',
      '`FETCH /project`',
    ]) {
      const parsed = parseCatalogue(markdown([cell]))
      expect(parsed.problems, cell).toHaveLength(1)
      expect(parsed.problems[0], cell).toMatch(/^line 3: /u)
    }
  })

  test('refuses a message row without its declaring file', () => {
    const text = [
      '| Message | Direction | Declared in |',
      '| --- | --- | --- |',
      '| `joinDoc` | sent | Router.js |',
    ].join('\n')
    expect(parseCatalogue(text).problems).toEqual([
      'line 3: write a message as `name` with the `services/...` file declaring it',
    ])
  })

  test('fails the whole check on an unreadable entry', async () => {
    const run = await runCheck(markdown(['`GET /project` when signed in']), fixtureFetch())
    expect(run.exitCode).toBe(1)
    expect(run.stderr).toContain('line 3: write each route as its own `METHOD /path` code span')
  })
})

describe('matching against Overleaf source', () => {
  test('matches parameters by position under any name, and fixed segments ignoring case', () => {
    expect(pathMatches('/Project/:id/clone', '/project/:Project_id/clone')).toBe(true)
    expect(pathMatches('/project/:id/build/:buildId/output/:file', '/project/:P/build/:b/output/:file(.+)')).toBe(true)
    expect(pathMatches('/project/:id/upload', '/project/new/upload')).toBe(false)
    expect(pathMatches('/project/new', '/project/:Project_id')).toBe(false)
    expect(pathMatches('/project/:id', '/project/:id/rename')).toBe(false)
  })

  test('reads methods from direct declarations, keeps indirect paths, and leaves out other routers', () => {
    const declared = declaredPaths(FIXTURE_SOURCES[WEB_ROUTER]! + '\n' + FIXTURE_SOURCES[EDITOR_ROUTER]!)
    expect(declared).toEqual(
      expect.arrayContaining([
        { path: '/project' },
        { path: '/project/:Project_id/rename', method: 'POST' },
        { path: '/Project/:Project_id/upload' },
        { path: '/project/:Project_id/doc/:entity_id', method: 'DELETE' },
      ])
    )
    expect(declared.some(entry => entry.path.endsWith('/changes/reject'))).toBe(false)
  })

  test('reports a route whose path survives only under another method', () => {
    const declared = declaredPaths("webRouter.get('/Project/:Project_id', show)\nconst p = '/Project/:Project_id'")
    expect(routeDeclared(route('GET', '/Project/:id'), declared)).toBe(true)
    expect(routeDeclared(route('DELETE', '/Project/:id'), declared)).toBe(false)
  })

  test('finds the feature routers router.mjs imports', () => {
    expect(featureRouters(FIXTURE_SOURCES[WEB_ROUTER]!)).toEqual([EDITOR_ROUTER])
  })
})

describe('the check', () => {
  test('passes when every listed route and message is declared, naming what it skipped', async () => {
    const run = await runCheck(markdown(ALL_FIXTURE_ROUTES, ['joinDoc']), fixtureFetch())
    expect(run).toEqual({
      exitCode: 0,
      stdout:
        'Checked 5 routes and 1 socket messages against overleaf/overleaf; 1 routes marked † are not in its public source and were skipped: GET /project/:id/ranges.\n',
      stderr: '',
    })
  })

  test('exits 1 and names a route the fixture router lacks, and the files searched', async () => {
    const run = await runCheck(markdown([...ALL_FIXTURE_ROUTES, '`POST /project/:id/compile`']), fixtureFetch())
    expect(run.exitCode).toBe(1)
    expect(run.stdout).toBe('')
    const [missing, ...rest] = run.stderr.trimEnd().split('\n')
    expect(missing).toBe(
      `missing route POST /project/:id/compile (docs/private-api.md line 9); searched ${WEB_ROUTER} and the 1 feature routers it imports`
    )
    expect(rest).toHaveLength(1)
  })

  test('names a socket message the declaring file no longer has', async () => {
    const run = await runCheck(markdown([], ['joinDoc', 'leaveDoc']), fixtureFetch())
    expect(run.exitCode).toBe(1)
    expect(run.stderr).toContain(
      `missing socket message leaveDoc (docs/private-api.md line 7); searched ${REALTIME_ROUTER}`
    )
    expect(run.stderr).not.toContain('missing socket message joinDoc')
  })

  test('reports a source file it could not read as its own failure, not as missing routes', async () => {
    const result = await checkCatalogue(
      parseCatalogue(markdown(ALL_FIXTURE_ROUTES, ['joinDoc'])),
      fixtureFetch({ [EDITOR_ROUTER]: undefined, [REALTIME_ROUTER]: undefined })
    )
    expect(result.failures).toContain(`could not read ${EDITOR_ROUTER} from overleaf/overleaf`)
    expect(result.failures).toContain(`could not read ${REALTIME_ROUTER} from overleaf/overleaf`)
    expect(result.failures.filter(line => line.startsWith('missing socket message'))).toEqual([])

    const unreachable = await checkCatalogue(parseCatalogue(markdown(ALL_FIXTURE_ROUTES)), async () => undefined)
    expect(unreachable.failures).toEqual([`could not read ${WEB_ROUTER} from overleaf/overleaf`])
  })
})
