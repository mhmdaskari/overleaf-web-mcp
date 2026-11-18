import { describe, expect, test } from 'vitest'

import {
  bundleFileName,
  bundleProblems,
  extensionEnvironment,
  productionPackages,
  REQUIRED_BUNDLE_FILES,
  zipEntryNames,
} from '../../scripts/build-mcpb.js'

/** A stored (uncompressed) zip holding the named empty files, as `mcpb pack` would list them. */
function zipOf(names: readonly string[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const name of names) {
    const nameBytes = Buffer.from(name, 'utf8')
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(nameBytes.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(0x0800, 8) // UTF-8 names
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, nameBytes)
    centrals.push(central, nameBytes)
    offset += local.length + nameBytes.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(names.length, 8)
  end.writeUInt16LE(names.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

const LOCK = {
  packages: {
    '': { name: 'overleaf-web-mcp' },
    'node_modules/zod': { version: '4.0.0' },
    'node_modules/@modelcontextprotocol/server': { version: '2.3.1' },
    'node_modules/@modelcontextprotocol/server/node_modules/inner': { version: '1.0.0' },
    'node_modules/optional-native': { version: '1.0.0', devOptional: true, optional: true },
    'node_modules/vitest': { version: '3.0.0', dev: true },
    'node_modules/@modelcontextprotocol/client': { version: '2.3.1', dev: true },
  },
}

describe('bundle file name', () => {
  test('names the package and version', () => {
    expect(bundleFileName({ name: 'overleaf-web-mcp', version: '1.3.0' })).toBe('overleaf-web-mcp-1.3.0.mcpb')
  })
})

describe('extension environment', () => {
  const manifest = {
    server: {
      mcp_config: {
        env: { A: '${user_config.a}', B: '${user_config.b}', C: 'x-${user_config.c}-y' },
      },
    },
    user_config: { a: { default: 'fallback' }, b: { default: '' } },
  }

  test('uses the given value, then the default, and keeps a placeholder that has neither', () => {
    expect(extensionEnvironment(manifest, { a: 'given' })).toEqual({ A: 'given', B: '', C: 'x-${user_config.c}-y' })
    expect(extensionEnvironment(manifest)).toEqual({ A: 'fallback', B: '', C: 'x-${user_config.c}-y' })
  })
})

describe('zip entry names', () => {
  test('lists every file in the central directory, in order', () => {
    const names = ['manifest.json', 'dist/cli.js', 'node_modules/zod/package.json', 'dist/ünïcode.js']
    expect(zipEntryNames(zipOf(names))).toEqual(names)
  })

  test('refuses a file that is not a zip', () => {
    expect(() => zipEntryNames(Buffer.from('not a zip at all, just text'))).toThrow(/not a zip/u)
  })
})

describe('bundle contents', () => {
  const production = productionPackages(LOCK)

  test('production packages leave out the root and every dev-only package', () => {
    expect([...production].sort()).toEqual([
      'node_modules/@modelcontextprotocol/server',
      'node_modules/@modelcontextprotocol/server/node_modules/inner',
      'node_modules/optional-native',
      'node_modules/zod',
    ])
  })

  test('accepts the required files, built output, and production dependencies', () => {
    expect(
      bundleProblems(
        [
          ...REQUIRED_BUNDLE_FILES,
          'dist/runtime.js',
          'package-lock.json',
          'node_modules/zod/index.js',
          'node_modules/@modelcontextprotocol/server/dist/index.js',
          'node_modules/@modelcontextprotocol/server/node_modules/inner/index.js',
          'node_modules/.package-lock.json',
        ],
        production
      )
    ).toEqual([])
  })

  test('names each missing required file', () => {
    const paths = REQUIRED_BUNDLE_FILES.filter(path => path !== 'dist/cli.js' && path !== 'manifest.json')
    expect(bundleProblems(paths, production)).toEqual(['missing manifest.json', 'missing dist/cli.js'])
  })

  test.each([
    'src/cli.ts',
    'test/server.test.ts',
    'scripts/build-mcpb.ts',
    'skills/overleaf-sync-sources/SKILL.md',
    '.github/workflows/ci.yml',
    'cookies.txt',
    '.env',
    'node_modules/vitest/index.js',
    'node_modules/@modelcontextprotocol/client/dist/index.js',
    'node_modules/unlisted/index.js',
    'README.md',
  ])('refuses to bundle %s', path => {
    expect(bundleProblems([...REQUIRED_BUNDLE_FILES, path], production)).toEqual([`must not bundle ${path}`])
  })
})
