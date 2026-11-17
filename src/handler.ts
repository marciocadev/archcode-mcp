import { createHash, timingSafeEqual } from 'node:crypto'
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm'
import { PROTOCOL_VERSIONS, dispatchMcp, type DispatchResult } from './mcp/dispatch'

const MAX_BODY_BYTES = 1_000_000

export type HttpRequest = {
  method: string
  path: string
  headers: Record<string, string | undefined>
  body?: string
}

export type HttpResponse = {
  statusCode: number
  headers: Record<string, string>
  body: string
}

type ApiEvent = {
  headers?: Record<string, string | undefined>
  body?: string | null
  isBase64Encoded?: boolean
  rawPath?: string
  path?: string
  httpMethod?: string
  requestContext?: { http?: { method?: string; path?: string } }
}

let cachedToken: Promise<string> | undefined

export async function handler(event: ApiEvent): Promise<HttpResponse> {
  return handleRequest(toRequest(event), { authToken: await authToken() })
}

async function authToken(): Promise<string> {
  if (process.env.MCP_AUTH_TOKEN) return process.env.MCP_AUTH_TOKEN
  const name = process.env.MCP_TOKEN_PARAMETER_NAME
  if (!name) return ''
  cachedToken ??= loadToken(name).catch((error: unknown) => {
    cachedToken = undefined
    throw error
  })
  return cachedToken
}

async function loadToken(name: string): Promise<string> {
  const result = await new SSMClient({}).send(new GetParameterCommand({
    Name: name,
    WithDecryption: true,
  }))
  return result.Parameter?.Value ?? ''
}

export function handleRequest(request: HttpRequest, options: { authToken: string }): HttpResponse {
  const method = request.method.toUpperCase()
  const path = request.path
  if (method === 'GET' && (path === '/' || path === '/health' || path.endsWith('/health'))) {
    return json(200, { status: 'ok', name: 'archcode-mcp' })
  }
  if (!isMcpPath(path)) return json(404, { message: 'Not found.' })
  if (!authorized(request.headers.authorization, options.authToken)) {
    return {
      statusCode: 401,
      headers: {
        'content-type': 'application/json',
        'www-authenticate': 'Bearer',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32001, message: 'Missing or invalid bearer token.' },
      }),
    }
  }
  if (method === 'GET') {
    return {
      statusCode: 405,
      headers: { 'content-type': 'application/json', allow: 'POST, DELETE' },
      body: JSON.stringify({ message: 'This MCP server is stateless. Send POST with the JSON-RPC message.' }),
    }
  }
  if (method === 'DELETE') return json(200, { ok: true })
  if (method !== 'POST') return json(405, { message: 'Method not allowed.' })
  if ((request.body?.length ?? 0) > MAX_BODY_BYTES) {
    return json(413, { message: 'The request body is too large.' })
  }
  const accept = request.headers.accept
  if (accept && !accept.includes('application/json') && !accept.includes('text/event-stream') && !accept.includes('*/*')) {
    return json(406, { message: 'The client must accept application/json or text/event-stream.' })
  }

  let message: unknown
  try {
    message = request.body ? JSON.parse(request.body) : null
  } catch {
    return respond(accept, { kind: 'response', status: 200, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON.' } } })
  }
  return respond(accept, dispatchMcp(message))
}

function respond(accept: string | undefined, result: DispatchResult): HttpResponse {
  if (result.kind === 'accepted') return { statusCode: 202, headers: {}, body: '' }
  const protocol = PROTOCOL_VERSIONS[0]
  if (accept && !accept.includes('application/json') && !accept.includes('*/*') && accept.includes('text/event-stream')) {
    return {
      statusCode: result.status,
      headers: {
        'content-type': 'text/event-stream',
        'mcp-protocol-version': protocol,
        'cache-control': 'no-cache',
      },
      body: `event: message\ndata: ${JSON.stringify(result.body)}\n\n`,
    }
  }
  return {
    statusCode: result.status,
    headers: {
      'content-type': 'application/json',
      'mcp-protocol-version': protocol,
    },
    body: JSON.stringify(result.body),
  }
}

function authorized(header: string | undefined, expected: string): boolean {
  if (!expected || !header) return false
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header)
  if (!match) return false
  const provided = createHash('sha256').update(match[1]!).digest()
  const actual = createHash('sha256').update(expected).digest()
  return timingSafeEqual(provided, actual)
}

function isMcpPath(path: string): boolean {
  return path === '/mcp' || (path.endsWith('/mcp') && path[path.length - 5] === '/')
}

function toRequest(event: ApiEvent): HttpRequest {
  const headers: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(event.headers ?? {})) headers[key.toLowerCase()] = value
  let body = event.body ?? undefined
  if (event.isBase64Encoded && body) body = Buffer.from(body, 'base64').toString('utf8')
  return {
    method: event.requestContext?.http?.method ?? event.httpMethod ?? 'GET',
    path: event.rawPath ?? event.requestContext?.http?.path ?? event.path ?? '/',
    headers,
    body,
  }
}

function json(statusCode: number, body: unknown): HttpResponse {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }
}
