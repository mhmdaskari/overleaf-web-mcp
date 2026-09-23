import type { Agent } from 'node:http'

import WebSocket from 'ws'
import type { CookieJar } from 'tough-cookie'

import { AUTH_LOGIN_INSTRUCTION, McpError } from '../core/errors.js'
import { USER_AGENT } from '../version.js'
import { ProjectConnection, type JoinProjectData } from './project-connection.js'
import { SocketIo09Peer, type WebSocketPeer } from './socketio09-client.js'
import { parseHandshake } from './socketio09-codec.js'

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>
type WebSocketFactory = (
  url: string,
  options: { headers: Record<string, string> }
) => WebSocketPeer

export interface OpenProjectConnectionOptions {
  baseUrl: string
  projectId: string
  jar: CookieJar
  supportedProtocolVersions: number[]
  currentUserId?: string
  timeoutMs?: number
  applyTimeoutMs?: number
  fetcher?: Fetcher
  /** Carries the WebSocket, for example through a proxy; pair it with a `fetcher` taking the same route. */
  webSocketAgent?: Agent
  webSocketFactory?: WebSocketFactory
}

function createWebSocketFactory(agent?: Agent): WebSocketFactory {
  return (url, options) =>
    new WebSocket(url, {
      headers: options.headers,
      perMessageDeflate: false,
      ...(agent === undefined ? {} : { agent }),
    })
}

function responseSetCookies(headers: Headers): string[] {
  const enhanced = headers as Headers & { getSetCookie?: () => string[] }
  if (enhanced.getSetCookie) return enhanced.getSetCookie()
  const value = headers.get('set-cookie')
  return value ? [value] : []
}

/** Performs the legacy handshake, validates project bootstrap data, and returns a live socket. */
export async function openProjectConnection(
  options: OpenProjectConnectionOptions
): Promise<ProjectConnection> {
  const baseUrl = options.baseUrl.replace(/\/$/u, '')
  const timeoutMs = options.timeoutMs ?? 30_000
  const query = new URLSearchParams({
    projectId: options.projectId,
    t: String(Date.now()),
  })
  const handshakeUrl = `${baseUrl}/socket.io/1/?${query.toString()}`
  const cookie = await options.jar.getCookieString(handshakeUrl)
  const fetcher = options.fetcher ?? fetch
  let response: Response
  try {
    response = await fetcher(handshakeUrl, {
      headers: {
        accept: 'text/plain',
        ...(cookie ? { cookie } : {}),
        'user-agent': USER_AGENT,
      },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
    })
  } catch (error) {
    throw new McpError('TIMEOUT', 'Socket.IO handshake failed or timed out.', {
      retryable: true,
      cause: error,
    })
  }
  if (response.status === 401 || (response.url && new URL(response.url).pathname.startsWith('/login'))) {
    throw new McpError(
      'AUTH_EXPIRED',
      `Overleaf authentication expired. ${AUTH_LOGIN_INSTRUCTION}`
    )
  }
  if (!response.ok) {
    throw new McpError('REMOTE_ERROR', `Socket.IO handshake returned HTTP ${response.status}.`)
  }
  // SaaS handshakes can set a load-balancer cookie; the WebSocket must use the same route.
  const handshakeCookieUrl = response.url || handshakeUrl
  for (const value of responseSetCookies(response.headers)) {
    await options.jar.setCookie(value, handshakeCookieUrl)
  }
  const websocketCookie = await options.jar.getCookieString(handshakeUrl)
  const handshake = parseHandshake(await response.text())
  if (!handshake.transports.includes('websocket')) {
    throw new McpError('PROTOCOL_UNSUPPORTED', 'Overleaf did not offer the websocket transport.')
  }

  const websocketUrl = new URL(baseUrl)
  websocketUrl.protocol = websocketUrl.protocol === 'https:' ? 'wss:' : 'ws:'
  websocketUrl.pathname = `/socket.io/1/websocket/${handshake.sessionId}`
  websocketUrl.search = ''
  const webSocketFactory = options.webSocketFactory ?? createWebSocketFactory(options.webSocketAgent)
  const socket = webSocketFactory(websocketUrl.href, {
    headers: {
      ...(websocketCookie ? { Cookie: websocketCookie } : {}),
      Origin: baseUrl,
      'User-Agent': USER_AGENT,
    },
  })
  const peer = new SocketIo09Peer(socket)

  const join = await new Promise<JoinProjectData>((resolve, reject) => {
    const timer = setTimeout(() => {
      peer.close()
      reject(new McpError('TIMEOUT', 'Timed out waiting for joinProjectResponse.'))
    }, timeoutMs)
    const finish = (callback: () => void): void => {
      clearTimeout(timer)
      callback()
    }
    peer.once('joinProjectResponse', (value: JoinProjectData) => finish(() => resolve(value)))
    peer.once('connectionRejected', (value: unknown) =>
      finish(() =>
        reject(
          new McpError('AUTH_EXPIRED', `Overleaf rejected the socket connection: ${JSON.stringify(value)}`)
        )
      )
    )
    peer.once('error', error =>
      finish(() =>
        reject(error instanceof Error ? error : new McpError('REMOTE_ERROR', 'Socket failed.'))
      )
    )
    peer.once('disconnect', () =>
      finish(() => reject(new McpError('OUTCOME_UNKNOWN', 'Socket disconnected during project join.')))
    )
  })

  return new ProjectConnection({
    projectId: options.projectId,
    peer,
    join,
    supportedProtocolVersions: options.supportedProtocolVersions,
    ...(options.currentUserId === undefined ? {} : { currentUserId: options.currentUserId }),
    callTimeoutMs: timeoutMs,
    applyTimeoutMs: options.applyTimeoutMs ?? timeoutMs,
  })
}
