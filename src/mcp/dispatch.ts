import { SERVICE_CATALOG } from '../diagram/catalog'
import { generateDiagram } from '../diagram/generate'
import { DiagramProblem, type ConnectionInput, type ResourceInput } from '../diagram/types'

export const SERVER_NAME = 'archcode'
export const SERVER_VERSION = '0.1.0'
export const PROTOCOL_VERSIONS = ['2025-03-26', '2024-11-05'] as const

const INSTRUCTIONS = [
  'This server builds Archcode diagrams, the diagram.archcode file (JSON version 1) opened on the serverless canvas.',
  'Use list_services to see the services and the connections the canvas allows.',
  'Use generate_diagram with the user text. When the architecture has specific routes, names, or connections, also fill resources and connections.',
  'Save the returned JSON, unchanged, as diagram.archcode.',
  'Never ask for or store a secret value. The diagram keeps only the name.',
].join(' ')

type JsonRpcId = string | number | null

type JsonRpcRequest = {
  jsonrpc?: unknown
  id?: unknown
  method?: unknown
  params?: unknown
}

export type DispatchResult =
  | { kind: 'response'; status: number; body: unknown }
  | { kind: 'accepted' }

export function dispatchMcp(message: unknown): DispatchResult {
  if (Array.isArray(message)) {
    return rpcError(null, -32600, 'This server does not accept JSON-RPC batches.')
  }
  if (!message || typeof message !== 'object') {
    return rpcError(null, -32600, 'The JSON-RPC message is invalid.')
  }
  const request = message as JsonRpcRequest
  if (request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
    return rpcError(idOf(request.id), -32600, 'The JSON-RPC message is invalid.')
  }
  const id = idOf(request.id)
  const method = request.method
  if (method.startsWith('notifications/')) return { kind: 'accepted' }

  try {
    if (method === 'initialize') return { kind: 'response', status: 200, body: result(id, initialize(request.params)) }
    if (method === 'ping') return { kind: 'response', status: 200, body: result(id, {}) }
    if (method === 'tools/list') return { kind: 'response', status: 200, body: result(id, { tools: TOOLS }) }
    if (method === 'tools/call') return { kind: 'response', status: 200, body: result(id, callTool(request.params)) }
    return rpcError(id, -32601, `Method not found: ${method}.`)
  } catch (error) {
    const messageText = error instanceof Error ? error.message : 'Internal failure.'
    return rpcError(id, -32603, messageText)
  }
}

function initialize(params: unknown): Record<string, unknown> {
  const requested = params && typeof params === 'object' ? (params as { protocolVersion?: unknown }).protocolVersion : undefined
  const protocolVersion = typeof requested === 'string' && PROTOCOL_VERSIONS.includes(requested as (typeof PROTOCOL_VERSIONS)[number])
    ? requested
    : PROTOCOL_VERSIONS[0]
  return {
    protocolVersion,
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    instructions: INSTRUCTIONS,
  }
}

function callTool(params: unknown): Record<string, unknown> {
  const name = params && typeof params === 'object' ? (params as { name?: unknown }).name : undefined
  const args = params && typeof params === 'object' ? (params as { arguments?: unknown }).arguments : undefined
  if (name === 'list_services') return textResult(JSON.stringify(SERVICE_CATALOG, null, 2))
  if (name === 'generate_diagram') return generateFromArguments(args)
  return {
    content: [{ type: 'text', text: `Unknown tool: ${String(name ?? '')}.` }],
    isError: true,
  }
}

function generateFromArguments(args: unknown): Record<string, unknown> {
  const record = asRecord(args)
  if (record.text != null && typeof record.text !== 'string') {
    return textResult('The text field must be a string.', true)
  }
  if (record.title != null && typeof record.title !== 'string') {
    return textResult('The title field must be a string.', true)
  }
  if (record.resources != null && !Array.isArray(record.resources)) {
    return textResult('The resources field must be a list.', true)
  }
  if (record.connections != null && !Array.isArray(record.connections)) {
    return textResult('The connections field must be a list.', true)
  }
  try {
    const generated = generateDiagram({
      text: typeof record.text === 'string' ? record.text : undefined,
      title: typeof record.title === 'string' ? record.title : undefined,
      resources: record.resources as ResourceInput[] | undefined,
      connections: record.connections as ConnectionInput[] | undefined,
    })
    const warningText = generated.warnings.length > 0 ? `\n\nWarnings:\n${generated.warnings.map((item) => `- ${item}`).join('\n')}` : ''
    return {
      content: [
        {
          type: 'text',
          text: `${generated.summary}${warningText}\n\nSave the JSON below as diagram.archcode.\n\n${generated.archcode}`,
        },
        {
          type: 'resource',
          resource: {
            uri: 'archcode://diagram.archcode',
            mimeType: 'application/json',
            text: generated.archcode,
          },
        },
      ],
      isError: false,
    }
  } catch (error) {
    if (error instanceof DiagramProblem) return textResult(error.message, true)
    throw error
  }
}

const TOOLS = [
  {
    name: 'list_services',
    description: 'Lists the Archcode serverless services and the connections the canvas accepts.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'generate_diagram',
    description: 'Builds a diagram.archcode file from text. Fill resources and connections to fix names, HTTP routes, schedules, and links. A secret value must not appear.',
    inputSchema: {
      type: 'object',
      required: ['text'],
      properties: {
        text: {
          type: 'string',
          description: 'Architecture description.',
        },
        title: { type: 'string', description: 'Diagram title.' },
        resources: {
          type: 'array',
          description: 'Components. When present, they replace the reading of the text.',
          items: {
            type: 'object',
            required: ['service', 'name'],
            properties: {
              id: { type: 'string' },
              service: {
                type: 'string',
                enum: SERVICE_CATALOG.map((item) => item.service),
              },
              name: { type: 'string' },
              routes: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['verb', 'path'],
                  properties: {
                    verb: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'ANY'] },
                    path: { type: 'string' },
                  },
                },
              },
              language: { type: 'string', enum: ['typescript', 'python', 'go'] },
              runtime: { type: 'string', enum: ['nodejs24.x', 'python3.14', 'provided.al2023'] },
              architecture: { type: 'string', enum: ['x86_64', 'arm64'] },
              memoryMb: { type: 'number' },
              timeoutSeconds: { type: 'number' },
              partitionKey: { type: 'string' },
              sortKey: { type: 'string' },
              stream: { type: 'string', enum: ['none', 'keys', 'new', 'old', 'both'] },
              scheduleKind: { type: 'string', enum: ['rate', 'cron', 'once'] },
              rateValue: { type: 'number' },
              rateUnit: { type: 'string', enum: ['minutes', 'hours', 'days'] },
              cronExpression: { type: 'string' },
              onceAt: { type: 'string', description: 'Local date of a one-time schedule, in the form 2026-11-17T08:00.' },
              eventSources: { type: 'array', items: { type: 'string' } },
              detailTypes: { type: 'array', items: { type: 'string' } },
              fifo: { type: 'boolean' },
              jsonKey: { type: 'string' },
              parameterType: { type: 'string', enum: ['String', 'StringList'] },
              ownership: { type: 'string', enum: ['reference', 'create'] },
            },
          },
        },
        connections: {
          type: 'array',
          items: {
            type: 'object',
            required: ['from', 'to'],
            properties: {
              from: { type: 'string' },
              to: { type: 'string' },
              via: {
                type: 'string',
                description: 'Output of the source component. Queue: source only reaches a Lambda, dlq only reaches a DLQ. Table: stream. Bucket: event, created, or removed. API: a route such as POST /orders. When omitted, the only output that reaches the target is used.',
              },
              grant: { type: 'string', enum: ['read', 'write', 'read-write'] },
              s3Event: { type: 'string', enum: ['created', 'removed'] },
              label: { type: 'string' },
            },
          },
        },
      },
    },
  },
]

function textResult(text: string, isError = false): Record<string, unknown> {
  return { content: [{ type: 'text', text }], isError }
}

function result(id: JsonRpcId, value: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result: value }
}

function rpcError(id: JsonRpcId, code: number, message: string): DispatchResult {
  return {
    kind: 'response',
    status: 200,
    body: { jsonrpc: '2.0', id, error: { code, message } },
  }
}

function idOf(id: unknown): JsonRpcId {
  if (typeof id === 'string' || typeof id === 'number' || id === null) return id
  return null
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}
