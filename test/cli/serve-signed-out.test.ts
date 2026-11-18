import { spawn } from 'node:child_process'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { LISTED_TOOL_NAMES } from '../../src/mcp/tools.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

let base = ''

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'overleaf-serve-signed-out-'))
})

afterAll(async () => {
  await rm(base, { recursive: true, force: true })
})

interface Reply {
  id?: number
  result?: Record<string, any>
  error?: unknown
}

/**
 * Runs the real `serve` with no saved session and talks to it as an MCP client would: it must
 * answer, list its tools, and report AUTH_EXPIRED from a tool instead of exiting before the client
 * can connect.
 */
async function serveWithoutSession(): Promise<{ replies: Reply[]; stdout: string; code: number | null }> {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'serve'], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: join(base, 'home'),
      XDG_CONFIG_HOME: join(base, 'config'),
      APPDATA: join(base, 'appdata'),
      OVERLEAF_COOKIE_JAR_FILE: join(base, 'missing', 'cookies.txt'),
      OVERLEAF_BASE_URL: 'https://overleaf.test',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stdout = ''
  const replies: Reply[] = []
  const waiting = new Map<number, () => void>()
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk
    const lines = stdout.split('\n')
    for (const line of lines.slice(replies.length, -1)) {
      const reply = JSON.parse(line) as Reply
      replies.push(reply)
      if (typeof reply.id === 'number') waiting.get(reply.id)?.()
    }
  })
  const exited = new Promise<number | null>(resolveExit => child.once('exit', code => resolveExit(code)))
  const send = (message: Record<string, unknown>) => child.stdin.write(`${JSON.stringify(message)}\n`)
  const request = (id: number, method: string, params: Record<string, unknown>) =>
    new Promise<void>((resolveReply, reject) => {
      waiting.set(id, resolveReply)
      void exited.then(code => reject(new Error(`serve exited with ${code} before answering ${method}`)))
      send({ jsonrpc: '2.0', id, method, params })
    })

  await request(1, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'signed-out-test', version: '0' },
  })
  send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  await request(2, 'tools/list', {})
  await request(3, 'tools/call', { name: 'auth_status', arguments: {} })
  child.stdin.end()
  return { replies, stdout, code: await exited }
}

describe('serve without a saved session', () => {
  test('connects, lists its tools, and answers a tool with AUTH_EXPIRED', async () => {
    const { replies, stdout, code } = await serveWithoutSession()

    // stdout carries nothing but JSON-RPC.
    for (const line of stdout.trimEnd().split('\n')) expect(JSON.parse(line)).toMatchObject({ jsonrpc: '2.0' })
    const byId = new Map(replies.map(reply => [reply.id, reply]))
    expect(byId.get(1)?.result?.serverInfo?.name).toBe('overleaf-web-mcp')
    const listed = (byId.get(2)?.result?.tools as Array<{ name: string }>).map(tool => tool.name)
    expect(listed).toEqual(LISTED_TOOL_NAMES)
    const call = byId.get(3)?.result as { isError?: boolean; content: Array<{ text: string }> }
    expect(call.isError).toBe(true)
    expect(JSON.parse(call.content[0]!.text)).toMatchObject({ code: 'AUTH_EXPIRED' })
    expect(code).toBe(0)
  }, 30_000)

  test('wrote nothing where a session would live', async () => {
    expect(await readdir(base)).toEqual([])
  })
})
