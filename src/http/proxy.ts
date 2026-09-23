import type { Agent } from 'node:http'
import { isIP } from 'node:net'

import { HttpsProxyAgent } from 'https-proxy-agent'
import { ProxyAgent } from 'undici'

import { McpError } from '../core/errors.js'

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

const URL_SCHEME = /^[a-z][a-z\d+.-]*:\/\//iu

function firstSet(
  env: NodeJS.ProcessEnv,
  names: readonly string[]
): { name: string; value: string } | undefined {
  for (const name of names) {
    const value = env[name]?.trim()
    if (value) return { name, value }
  }
  return undefined
}

function withoutBrackets(host: string): string {
  return host.replace(/^\[(.*)\]$/u, '$1')
}

function parseNoProxyEntry(entry: string): { host: string; port?: string } {
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/u.exec(entry)
  if (bracketed) {
    return { host: bracketed[1]!, ...(bracketed[2] === undefined ? {} : { port: bracketed[2] }) }
  }
  const withPort = /^([^:]+):(\d+)$/u.exec(entry)
  if (withPort) return { host: withPort[1]!, port: withPort[2]! }
  return { host: entry }
}

/**
 * Follows curl: `*` matches every host, an entry matches that host and its subdomains (a leading
 * `.` or `*.` is optional), an optional `:port` must equal the target's port, and an IP address
 * matches only itself. CIDR ranges are not supported.
 */
export function bypassesProxy(target: URL, noProxy: string): boolean {
  const host = withoutBrackets(target.hostname.toLowerCase()).replace(/\.$/u, '')
  const port = target.port || (target.protocol === 'https:' ? '443' : '80')
  for (const raw of noProxy.split(/[\s,]+/u)) {
    const entry = raw.toLowerCase()
    if (entry === '') continue
    if (entry === '*') return true
    const parsed = parseNoProxyEntry(entry)
    if (parsed.port !== undefined && parsed.port !== port) continue
    const entryHost = parsed.host.replace(/^\*?\./u, '').replace(/\.$/u, '')
    if (entryHost === '') continue
    if (host === entryHost) return true
    if (isIP(host) === 0 && host.endsWith(`.${entryHost}`)) return true
  }
  return false
}

function parseProxyUrl(name: string, value: string): URL {
  let url: URL
  try {
    // A bare `host:port` means an HTTP proxy, as it does for curl.
    url = new URL(URL_SCHEME.test(value) ? value : `http://${value}`)
  } catch {
    // No cause and no value in the message: the value can carry proxy credentials.
    throw new McpError('INVALID_ARGUMENT', `${name} is not a valid proxy URL.`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new McpError(
      'INVALID_ARGUMENT',
      `${name} must be an http:// or https:// proxy URL; SOCKS proxies are not supported.`
    )
  }
  if (url.hostname === '') {
    throw new McpError('INVALID_ARGUMENT', `${name} is not a valid proxy URL.`)
  }
  return url
}

/**
 * Chooses the proxy for requests to `target` from the conventional environment variables, or
 * returns undefined to connect directly. The variable is selected by the target's scheme
 * (`https_proxy` for HTTPS, `http_proxy` for HTTP, lowercase before uppercase) with no fallback
 * between the two, and `no_proxy` exempts matching hosts.
 */
export function resolveProxyUrl(
  target: URL,
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  const names = target.protocol === 'https:'
    ? ['https_proxy', 'HTTPS_PROXY']
    : ['http_proxy', 'HTTP_PROXY']
  const selected = firstSet(env, names)
  if (selected === undefined) return undefined
  if (bypassesProxy(target, firstSet(env, ['no_proxy', 'NO_PROXY'])?.value ?? '')) {
    return undefined
  }
  return parseProxyUrl(selected.name, selected.value).href
}

export interface ProxyRoute {
  /** `fetch` sent through the proxy, for REST calls and the Socket.IO handshake. */
  readonly fetcher: Fetcher
  /** The agent that tunnels the collaboration WebSocket through the same proxy. */
  readonly webSocketAgent: Agent
  close(): Promise<void>
}

function webSocketProxyAgent(proxyUrl: string): Agent {
  const url = new URL(proxyUrl)
  const headers: Record<string, string> = {}
  // https-proxy-agent prints its proxy URL through `debug`, so credentials travel as a header.
  if (url.username !== '' || url.password !== '') {
    const credentials = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`
    headers['Proxy-Authorization'] = `Basic ${Buffer.from(credentials).toString('base64')}`
    url.username = ''
    url.password = ''
  }
  return new HttpsProxyAgent(url, { headers })
}

/**
 * Routes both legs of a project connection through one proxy. The Socket.IO handshake can set a
 * load-balancer cookie, so the handshake and the WebSocket that follows must take the same route.
 */
export function createProxyRoute(proxyUrl: string): ProxyRoute {
  const dispatcher = new ProxyAgent(proxyUrl)
  const webSocketAgent = webSocketProxyAgent(proxyUrl)
  return {
    fetcher: async (input, init) => await fetch(input, { ...init, dispatcher } as RequestInit),
    webSocketAgent,
    close: async () => {
      webSocketAgent.destroy()
      await dispatcher.close()
    },
  }
}
