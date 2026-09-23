import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { connect, type AddressInfo, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'vitest'
import { WebSocketServer } from 'ws'

import { readConfig } from '../../src/config.js'
import { McpError } from '../../src/core/errors.js'
import { bypassesProxy, resolveProxyUrl } from '../../src/http/proxy.js'
import { OverleafRuntime } from '../../src/runtime.js'

const HTTPS_TARGET = new URL('https://www.overleaf.com')
const HTTP_TARGET = new URL('http://overleaf.internal:8080')

function rejection(run: () => unknown): McpError {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(McpError)
    return error as McpError
  }
  throw new Error('expected a rejection')
}

describe('proxy selection', () => {
  test('connects directly when no proxy variable is set', () => {
    expect(resolveProxyUrl(HTTPS_TARGET, {})).toBeUndefined()
    expect(resolveProxyUrl(HTTPS_TARGET, { HTTPS_PROXY: '  ' })).toBeUndefined()
  })

  test('selects the variable by the target scheme, with no fallback between them', () => {
    const env = { HTTPS_PROXY: 'http://secure.proxy:3128', HTTP_PROXY: 'http://plain.proxy:3128' }
    expect(resolveProxyUrl(HTTPS_TARGET, env)).toBe('http://secure.proxy:3128/')
    expect(resolveProxyUrl(HTTP_TARGET, env)).toBe('http://plain.proxy:3128/')
    expect(resolveProxyUrl(HTTPS_TARGET, { HTTP_PROXY: 'http://plain.proxy:3128' })).toBeUndefined()
    expect(resolveProxyUrl(HTTP_TARGET, { HTTPS_PROXY: 'http://secure.proxy:3128' })).toBeUndefined()
  })

  test('prefers the lowercase variable and skips an empty one', () => {
    expect(
      resolveProxyUrl(HTTPS_TARGET, { https_proxy: 'http://lower:1', HTTPS_PROXY: 'http://upper:2' })
    ).toBe('http://lower:1/')
    expect(
      resolveProxyUrl(HTTPS_TARGET, { https_proxy: '', HTTPS_PROXY: 'http://upper:2' })
    ).toBe('http://upper:2/')
  })

  test('treats a bare host:port as an HTTP proxy and keeps credentials', () => {
    expect(resolveProxyUrl(HTTPS_TARGET, { HTTPS_PROXY: 'proxy.corp:3128' })).toBe(
      'http://proxy.corp:3128/'
    )
    expect(
      resolveProxyUrl(HTTPS_TARGET, { HTTPS_PROXY: 'https://user:p%40ss@proxy.corp:443' })
    ).toBe('https://user:p%40ss@proxy.corp/')
  })

  test('rejects unusable values by variable name without echoing them', () => {
    const socks = rejection(() =>
      resolveProxyUrl(HTTPS_TARGET, { HTTPS_PROXY: 'socks5://user:secret@proxy.corp:1080' })
    )
    expect(socks.code).toBe('INVALID_ARGUMENT')
    expect(socks.message).toContain('HTTPS_PROXY')
    expect(socks.message).toContain('SOCKS')
    expect(socks.message).not.toContain('secret')

    const malformed = rejection(() =>
      resolveProxyUrl(HTTPS_TARGET, { https_proxy: 'not a url with secret' })
    )
    expect(malformed.code).toBe('INVALID_ARGUMENT')
    expect(malformed.message).toBe('https_proxy is not a valid proxy URL.')
    expect(malformed.cause).toBeUndefined()
  })

  test('readConfig resolves the proxy against OVERLEAF_BASE_URL and fails at startup', () => {
    expect(readConfig({ HTTPS_PROXY: 'http://proxy.corp:3128' }).proxyUrl).toBe(
      'http://proxy.corp:3128/'
    )
    expect(readConfig({}).proxyUrl).toBeUndefined()
    expect(
      readConfig({
        OVERLEAF_BASE_URL: 'https://overleaf.internal',
        HTTPS_PROXY: 'http://proxy.corp:3128',
        NO_PROXY: '.internal',
      }).proxyUrl
    ).toBeUndefined()
    expect(rejection(() => readConfig({ HTTPS_PROXY: 'socks5://proxy.corp:1080' })).code).toBe(
      'INVALID_ARGUMENT'
    )
  })
})

describe('NO_PROXY', () => {
  test('exempts a matching target, even from a proxy value that would be rejected', () => {
    expect(
      resolveProxyUrl(new URL('https://overleaf.internal'), {
        HTTPS_PROXY: 'socks5://proxy.corp:1080',
        no_proxy: 'localhost, overleaf.internal',
      })
    ).toBeUndefined()
  })

  test('matches hosts and subdomains on a label boundary', () => {
    const target = new URL('https://overleaf.corp.example')
    expect(bypassesProxy(target, '*')).toBe(true)
    expect(bypassesProxy(target, 'overleaf.corp.example')).toBe(true)
    expect(bypassesProxy(target, 'corp.example')).toBe(true)
    expect(bypassesProxy(target, '.corp.example')).toBe(true)
    expect(bypassesProxy(target, '*.corp.example')).toBe(true)
    expect(bypassesProxy(target, 'OVERLEAF.CORP.EXAMPLE.')).toBe(true)
    expect(bypassesProxy(target, 'rp.example')).toBe(false)
    expect(bypassesProxy(target, 'other.example,,  ')).toBe(false)
    expect(bypassesProxy(target, '')).toBe(false)
  })

  test('requires a listed port to equal the target port', () => {
    expect(bypassesProxy(new URL('https://overleaf.internal'), 'overleaf.internal:443')).toBe(true)
    expect(bypassesProxy(new URL('https://overleaf.internal'), 'overleaf.internal:8443')).toBe(false)
    expect(bypassesProxy(HTTP_TARGET, 'overleaf.internal:8080')).toBe(true)
    expect(bypassesProxy(HTTP_TARGET, 'overleaf.internal:80')).toBe(false)
  })

  test('matches IP addresses exactly', () => {
    expect(bypassesProxy(new URL('http://10.0.0.5'), '10.0.0.5')).toBe(true)
    expect(bypassesProxy(new URL('http://10.0.0.5'), '0.0.5')).toBe(false)
    expect(bypassesProxy(new URL('http://10.0.0.5'), '10.0.0.0/8')).toBe(false)
    expect(bypassesProxy(new URL('http://[::1]:8080'), '[::1]:8080')).toBe(true)
    expect(bypassesProxy(new URL('http://[::1]:8080'), '::1')).toBe(true)
  })
})

interface Tunnel {
  target: string
  authorization: string | undefined
  localPort: number | undefined
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as AddressInfo).port
}

/** A CONNECT-only proxy on loopback, so no request can reach the target except through it. */
function connectProxy(tunnels: Tunnel[]): Server {
  const proxy = createServer((_request, response) => {
    response.writeHead(405)
    response.end()
  })
  proxy.on('connect', (request: IncomingMessage, client: Socket, head: Buffer) => {
    const [host, port] = (request.url ?? '').split(':')
    const upstream = connect(Number(port), host, () => {
      tunnels.push({
        target: request.url ?? '',
        authorization: request.headers['proxy-authorization'],
        localPort: upstream.localPort,
      })
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      upstream.write(head)
      upstream.pipe(client)
      client.pipe(upstream)
    })
    upstream.on('error', () => client.destroy())
    client.on('error', () => upstream.destroy())
  })
  return proxy
}

describe('proxied runtime', () => {
  test('routes the bootstrap, the handshake, and the WebSocket through one proxy', async () => {
    const tunnels: Tunnel[] = []
    const seen: { what: string; remotePort: number | undefined; cookie?: string }[] = []
    const overleaf = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://overleaf.test')
      seen.push({ what: `${request.method} ${url.pathname}`, remotePort: request.socket.remotePort })
      if (url.pathname === '/project') {
        response.end('<meta name="ol-csrfToken" content="csrf"><meta name="ol-user_id" content="user">')
      } else if (url.pathname === '/socket.io/1/') {
        response.setHeader('set-cookie', 'GCLB=sticky-route; Path=/; HttpOnly')
        response.end('SOCKET_SESSION:60:60:websocket')
      } else {
        response.writeHead(404)
        response.end()
      }
    })
    const sockets = new WebSocketServer({ server: overleaf })
    sockets.on('connection', (socket, request) => {
      seen.push({
        what: `WS ${request.url ?? ''}`,
        remotePort: request.socket.remotePort,
        cookie: request.headers.cookie ?? '',
      })
      socket.send(
        '5:::{"name":"joinProjectResponse","args":[{"publicId":"P.client","project":{"_id":"project","rootFolder":[]},"permissionsLevel":"owner","protocolVersion":2}]}'
      )
    })
    const proxy = connectProxy(tunnels)
    const overleafPort = await listen(overleaf)
    const proxyPort = await listen(proxy)

    const directory = await mkdtemp(join(tmpdir(), 'overleaf-proxy-'))
    const cookiePath = join(directory, 'cookies.txt')
    await writeFile(cookiePath, '# Netscape HTTP Cookie File\n')
    if (process.platform !== 'win32') await chmod(cookiePath, 0o600)

    const runtime = await OverleafRuntime.create(
      readConfig({
        OVERLEAF_BASE_URL: `http://127.0.0.1:${overleafPort}`,
        OVERLEAF_COOKIE_JAR_FILE: cookiePath,
        OVERLEAF_REQUEST_TIMEOUT_MS: '5000',
        HTTP_PROXY: `http://proxy%40user:p%3Ass@127.0.0.1:${proxyPort}`,
      })
    )
    try {
      const publicId = await runtime.connections.withConnection(
        'project',
        async connection => connection.publicId
      )
      expect(publicId).toBe('P.client')
    } finally {
      await runtime.close()
      sockets.close()
      overleaf.closeAllConnections()
      proxy.closeAllConnections()
      await new Promise(resolve => overleaf.close(resolve))
      await new Promise(resolve => proxy.close(resolve))
    }

    expect(seen.map(entry => entry.what)).toEqual([
      'GET /project',
      'GET /socket.io/1/',
      'WS /socket.io/1/websocket/SOCKET_SESSION',
    ])
    // The load-balancer cookie from the proxied handshake reached the proxied WebSocket.
    expect(seen[2]?.cookie).toContain('GCLB=sticky-route')
    const tunnelPorts = new Set(tunnels.map(tunnel => tunnel.localPort))
    for (const entry of seen) expect(tunnelPorts.has(entry.remotePort)).toBe(true)
    const expectedAuthorization = `Basic ${Buffer.from('proxy@user:p:ss').toString('base64')}`
    for (const tunnel of tunnels) {
      expect(tunnel.target).toBe(`127.0.0.1:${overleafPort}`)
      expect(tunnel.authorization).toBe(expectedAuthorization)
    }
  })
})
