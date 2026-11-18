import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { describe, expect, test, vi } from 'vitest'

import { AccessPolicy } from '../../src/core/policy.js'
import { McpError } from '../../src/core/errors.js'
import { SIGN_IN_TOOL } from '../../src/mcp/sign-in.js'
import { LISTED_TOOL_NAMES, MCP_ONLY_TOOLS, offeredToolNames, TOOL_NAMES } from '../../src/mcp/tools.js'
import { createMcpServer } from '../../src/server.js'
import { fakeServiceRuntime } from '../helpers/fake-runtime.js'
import { OUTPUTS } from '../helpers/operation-outputs.js'

function signInRuntime(
  signIn = vi.fn(async () => ({ ...OUTPUTS.auth_status, status: 'signed_in', alreadySignedIn: false }))
) {
  return { ...fakeServiceRuntime(), signIn }
}

async function connect(runtime: object, options: Parameters<typeof createMcpServer>[2] = {}) {
  const server = createMcpServer(runtime as never, undefined, options)
  const client = new Client({ name: 'sign-in-test', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  const names = (await client.listTools()).tools.map(tool => tool.name)
  return { server, client, names }
}

describe('sign_in', () => {
  test('is listed only for a runtime that can sign in, right after auth_status', async () => {
    const plain = await connect(fakeServiceRuntime())
    expect(plain.names).toEqual(TOOL_NAMES)
    await plain.client.close()

    const capable = await connect(signInRuntime())
    expect(capable.names).toEqual(LISTED_TOOL_NAMES)
    expect(capable.names.slice(0, 2)).toEqual(['auth_status', 'sign_in'])
    expect(MCP_ONLY_TOOLS).toEqual(['sign_in'])
    await capable.client.close()
  })

  test('is left out with the account toolset, or when OVERLEAF_ALLOWED_EFFECTS omits sign-in', async () => {
    const withoutAccount = await connect(signInRuntime(), { toolsets: ['files'] })
    expect(withoutAccount.names).not.toContain('sign_in')
    await withoutAccount.client.close()

    const runtime = { ...signInRuntime(), policy: await AccessPolicy.create({ allowedEffects: ['overleaf-read'] }) }
    const restricted = await connect(runtime)
    expect(restricted.names).not.toContain('sign_in')
    expect(offeredToolNames({}, runtime)).not.toContain('sign_in')
    await restricted.client.close()
  })

  test('declares what it can do and stays short', async () => {
    const { client } = await connect(signInRuntime())
    const tool = (await client.listTools()).tools.find(entry => entry.name === 'sign_in')!
    expect(tool.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    })
    expect(tool.description).toBe(SIGN_IN_TOOL.description)
    expect(tool.description!.length).toBeLessThan(600)
    expect(tool.description).toMatch(/only when the user agrees/u)
    await client.close()
  })

  test.each([
    ['signed in', { ...OUTPUTS.auth_status, status: 'signed_in', alreadySignedIn: true }],
    ['waiting', { status: 'waiting', deadline: '2026-11-18T12:05:00.000Z' }],
  ])('returns a result its output schema accepts when %s', async (_case, value) => {
    const signIn = vi.fn(async () => value)
    const { client } = await connect(signInRuntime(signIn as never))
    // The client checks structuredContent against the declared outputSchema.
    const result = await client.callTool({ name: 'sign_in', arguments: {} })
    expect(result.isError).toBeFalsy()
    expect(result.structuredContent).toEqual(value)
    expect(SIGN_IN_TOOL.outputSchema.safeParse(value).success).toBe(true)
    await client.close()
  })

  test('reports a failure in the shape every tool uses', async () => {
    const signIn = vi.fn(async () => {
      throw new McpError('AUTH_EXPIRED', 'Chrome closed before Overleaf login completed.', {
        details: { reason: 'sign_in_in_progress' },
      })
    })
    const { client } = await connect(signInRuntime(signIn))
    const result = await client.callTool({ name: 'sign_in', arguments: {} })
    expect(result.isError).toBe(true)
    const [content] = result.content as Array<{ text: string }>
    expect(JSON.parse(content!.text)).toEqual({
      code: 'AUTH_EXPIRED',
      message: 'Chrome closed before Overleaf login completed.',
      retryable: false,
      details: { reason: 'sign_in_in_progress' },
    })
    await client.close()
  })
})
