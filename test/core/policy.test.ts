import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'vitest'

import { readConfig } from '../../src/config.js'
import { AccessPolicy, assertPathSafeId } from '../../src/core/policy.js'

async function folders() {
  const base = await mkdtemp(join(tmpdir(), 'overleaf-policy-'))
  const inside = join(base, 'allowed')
  const outside = join(base, 'elsewhere')
  await mkdir(inside)
  await mkdir(outside)
  await writeFile(join(inside, 'main.tex'), 'in')
  await writeFile(join(outside, 'secret.tex'), 'out')
  return { base, inside, outside }
}

describe('path-safe ids', () => {
  test.each(['../x?', 'p/1', 'p\\1', 'a.b', 'p?x', 'p#x', 'p%2F', '', 'p\n'])('refuses %j', id => {
    expect(() => assertPathSafeId(id, 'projectId')).toThrow(expect.objectContaining({
      code: 'INVALID_ARGUMENT',
      details: { parameter: 'projectId' },
    }))
  })

  test('accepts Overleaf object ids and other plain ids', () => {
    for (const id of ['64b7f1c2e4b0a1b2c3d4e5f6', 'p', 'project-1', 'p 1']) {
      expect(() => assertPathSafeId(id, 'projectId')).not.toThrow()
    }
  })
})

describe('access policy', () => {
  test('allows everything but unsafe ids by default', async () => {
    const policy = await AccessPolicy.create({})
    expect(() => policy.assertProject('any')).not.toThrow()
    expect(() => policy.assertEffect('overleaf-delete', 'local-write')).not.toThrow()
    await expect(policy.resolveLocalRead('/no/such/file')).resolves.toBe('/no/such/file')
    expect(() => policy.assertProject('../x')).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }))
  })

  test('limits projects to the allowlist, plus those this process created', async () => {
    const policy = await AccessPolicy.create({ allowedProjects: ['a'] })
    expect(() => policy.assertProject('a')).not.toThrow()
    expect(() => policy.assertProject('b')).toThrow(expect.objectContaining({ code: 'POLICY_DENIED' }))
    expect(() => policy.assertProject('b', 'sourceProjectId')).toThrow(expect.objectContaining({
      details: { parameter: 'sourceProjectId' },
    }))
    policy.allowProject('b')
    expect(() => policy.assertProject('b')).not.toThrow()
    expect(policy.allowsProject('c')).toBe(false)
  })

  test('refuses effects outside the allowed list', async () => {
    const policy = await AccessPolicy.create({ allowedEffects: ['overleaf-read'] })
    expect(() => policy.assertEffect('overleaf-read')).not.toThrow()
    expect(() => policy.assertEffect('overleaf-read', 'overleaf-write')).toThrow(expect.objectContaining({
      code: 'POLICY_DENIED',
      details: { effect: 'overleaf-write' },
    }))
    await expect(policy.resolveLocalRead('/x')).rejects.toMatchObject({ code: 'POLICY_DENIED' })
  })

  test('keeps local reads inside the read roots, judging a link by where it leads', async () => {
    const { inside, outside } = await folders()
    await symlink(join(outside, 'secret.tex'), join(inside, 'link.tex'))
    const policy = await AccessPolicy.create({ localReadRoots: [inside] })

    await expect(policy.resolveLocalRead(join(inside, 'main.tex'))).resolves.toMatch(/main\.tex$/u)
    await expect(policy.resolveLocalRead(join(inside, 'missing.tex'))).resolves.toMatch(/missing\.tex$/u)
    for (const path of [join(outside, 'secret.tex'), join(inside, 'link.tex'), join(inside, '..', 'elsewhere')]) {
      await expect(policy.resolveLocalRead(path)).rejects.toMatchObject({
        code: 'PATH_OUTSIDE_ROOT',
        details: { kind: 'outside_read_roots' },
      })
    }
  })

  test('never writes over the saved session, with or without write roots', async () => {
    const { base, inside } = await folders()
    const jar = join(base, 'auth', 'cookies.txt')
    const profile = join(base, 'auth', 'chrome-profile')
    await mkdir(join(base, 'auth'))
    await writeFile(jar, '')
    await symlink(jar, join(inside, 'jar-link.txt'))
    const open = await AccessPolicy.create({ cookieJarFile: jar, browserProfileDir: profile })

    for (const path of [jar, `${jar}.lock`, join(base, 'auth', '.cookies.txt.1.2.tmp'), join(profile, 'Default', 'Cookies'), join(inside, 'jar-link.txt')]) {
      await expect(open.resolveLocalWrite(path)).rejects.toMatchObject({
        code: 'PATH_OUTSIDE_ROOT',
        details: { kind: 'session_files' },
      })
    }
    await expect(open.resolveLocalWrite(join(base, 'auth', 'other.txt'))).resolves.toBe(join(base, 'auth', 'other.txt'))

    const rooted = await AccessPolicy.create({ cookieJarFile: jar, localWriteRoots: [inside] })
    await expect(rooted.resolveLocalWrite(join(inside, 'out.pdf'))).resolves.toMatch(/out\.pdf$/u)
    await expect(rooted.resolveLocalWrite(join(base, 'out.pdf'))).rejects.toMatchObject({
      details: { kind: 'outside_write_roots' },
    })
  })

  test('judges a path the way the file system resolves it, a link before the .. after it', async () => {
    const { base } = await folders()
    await mkdir(join(base, 'a', 'b'), { recursive: true })
    await mkdir(join(base, 'a', 'session'))
    const jar = join(base, 'a', 'session', 'cookies.txt')
    await writeFile(jar, 'secret')
    await symlink(join(base, 'a', 'b'), join(base, 'link'))
    const policy = await AccessPolicy.create({ cookieJarFile: jar })

    // Text-wise this is base/session/cookies.txt; the file system reaches the jar through the link.
    const throughLink = join(base, 'link') + '/../session/cookies.txt'
    await expect(policy.resolveLocalWrite(throughLink)).rejects.toMatchObject({ details: { kind: 'session_files' } })
    await expect(policy.resolveLocalRead(throughLink)).rejects.toMatchObject({ details: { kind: 'session_files' } })

    // The reverse: text-wise the jar, but the file system goes elsewhere, so that is where it writes.
    await mkdir(join(base, 'c', 'd'), { recursive: true })
    await symlink(join(base, 'c', 'd'), join(base, 'x'))
    const textuallyTheJar = join(base, 'x') + '/../a/session/cookies.txt'
    const written = await policy.resolveLocalWrite(textuallyTheJar)
    expect(written).toBe(join(await realpath(join(base, 'c')), 'a', 'session', 'cookies.txt'))
    // Two steps up from the link does reach the jar, and is refused.
    await expect(policy.resolveLocalWrite(join(base, 'x') + '/../../a/session/cookies.txt')).rejects.toMatchObject({
      details: { kind: 'session_files' },
    })
  })

  test('judges a dangling link by where it leads', async () => {
    const { inside, outside } = await folders()
    await symlink(join(outside, 'not-yet.txt'), join(inside, 'out.pdf'))
    const policy = await AccessPolicy.create({ localWriteRoots: [inside], localReadRoots: [inside] })
    await expect(policy.resolveLocalWrite(join(inside, 'out.pdf'))).rejects.toMatchObject({
      details: { kind: 'outside_write_roots' },
    })
    await symlink(join(inside, 'loop-b'), join(inside, 'loop-a'))
    await symlink(join(inside, 'loop-a'), join(inside, 'loop-b'))
    await expect(policy.resolveLocalWrite(join(inside, 'loop-a'))).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })

  test('never reads the saved session, nor a folder that holds it', async () => {
    const { base, inside } = await folders()
    const auth = join(base, 'auth')
    const jar = join(auth, 'cookies.txt')
    await mkdir(join(auth, 'chrome-profile'), { recursive: true })
    await writeFile(jar, 'secret')
    await symlink(jar, join(inside, 'jar-link.txt'))
    const policy = await AccessPolicy.create({ cookieJarFile: jar, browserProfileDir: join(auth, 'chrome-profile') })

    for (const path of [jar, join(inside, 'jar-link.txt'), join(auth, 'chrome-profile', 'Default', 'Cookies')]) {
      await expect(policy.resolveLocalRead(path), path).rejects.toMatchObject({ details: { kind: 'session_files' } })
    }
    await expect(policy.resolveLocalRead(auth, { folder: true })).rejects.toMatchObject({ details: { kind: 'session_files' } })
    await expect(policy.resolveLocalRead(base, { folder: true })).rejects.toMatchObject({ details: { kind: 'session_files' } })
    await expect(policy.resolveLocalRead(inside, { folder: true })).resolves.toBe(inside)
    await expect(policy.resolveLocalRead(join(inside, 'main.tex'))).resolves.toBe(join(inside, 'main.tex'))
  })

  test('fails at startup for a root that does not exist', async () => {
    await expect(AccessPolicy.create({ localReadRoots: ['/no/such/root'] })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      message: expect.stringContaining('OVERLEAF_LOCAL_READ_ROOTS'),
    })
    await expect(AccessPolicy.create({ allowedProjects: ['a/b'] })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })
})

describe('policy configuration', () => {
  test('reads the four variables', () => {
    const config = readConfig({
      OVERLEAF_ALLOWED_PROJECTS: 'a, b',
      OVERLEAF_LOCAL_READ_ROOTS: ['/work/paper', '/work/figures'].join(process.platform === 'win32' ? ';' : ':'),
      OVERLEAF_LOCAL_WRITE_ROOTS: '/work/out',
      OVERLEAF_ALLOWED_EFFECTS: 'overleaf-read,local-read',
    })
    expect(config).toMatchObject({
      allowedProjects: ['a', 'b'],
      localReadRoots: ['/work/paper', '/work/figures'],
      localWriteRoots: ['/work/out'],
      allowedEffects: ['overleaf-read', 'local-read'],
    })
    const unset = readConfig({ OVERLEAF_ALLOWED_PROJECTS: '' })
    expect(unset).not.toHaveProperty('allowedProjects')
    expect(unset).not.toHaveProperty('allowedEffects')
  })

  test('refuses relative roots, unknown effects, and empty entries', () => {
    expect(() => readConfig({ OVERLEAF_LOCAL_READ_ROOTS: 'relative/path' })).toThrow(/OVERLEAF_LOCAL_READ_ROOTS/u)
    expect(() => readConfig({ OVERLEAF_ALLOWED_EFFECTS: 'overleaf-read,everything' })).toThrow(/OVERLEAF_ALLOWED_EFFECTS/u)
    expect(() => readConfig({ OVERLEAF_ALLOWED_PROJECTS: 'a,,b' })).toThrow(/OVERLEAF_ALLOWED_PROJECTS/u)
  })
})
