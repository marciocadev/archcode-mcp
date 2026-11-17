export const SERVICE_NAMES = [
  'aws-lambda',
  'dynamodb-table',
  'api-gateway-rest',
  'sqs-queue',
  'sqs-dlq',
  'sns-topic',
  's3-bucket',
  'eventbridge-scheduler',
  'eventbridge-event',
  'ssm-parameter',
  'secrets-manager',
] as const

export type ServiceName = (typeof SERVICE_NAMES)[number]

export const HTTP_VERBS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'ANY'] as const

export type HttpVerb = (typeof HTTP_VERBS)[number]

export type RouteInput = {
  verb: HttpVerb
  path: string
}

export type ResourceInput = {
  id: string
  service: ServiceName
  name: string
  routes?: RouteInput[]
  runtime?: 'nodejs24.x' | 'python3.14' | 'provided.al2023'
  language?: 'typescript' | 'python' | 'go'
  architecture?: 'x86_64' | 'arm64'
  memoryMb?: number
  timeoutSeconds?: number
  partitionKey?: string
  sortKey?: string
  stream?: 'none' | 'keys' | 'new' | 'old' | 'both'
  scheduleKind?: 'rate' | 'cron' | 'once'
  rateValue?: number
  rateUnit?: 'minutes' | 'hours' | 'days'
  cronExpression?: string
  onceAt?: string
  eventSources?: string[]
  detailTypes?: string[]
  fifo?: boolean
  jsonKey?: string
  parameterType?: 'String' | 'StringList'
  ownership?: 'reference' | 'create'
}

export type ConnectionInput = {
  from: string
  to: string
  via?: string
  grant?: 'read' | 'write' | 'read-write'
  s3Event?: 'created' | 'removed'
  label?: string
}

export type DiagramNode = {
  id: string
  type: ServiceName
  position: { x: number; y: number }
  data: Record<string, unknown>
}

export type DiagramEdge = {
  id: string
  type: 'aws'
  source: string
  target: string
  sourceHandle: string
  data: Record<string, unknown>
}

export type DiagramDocument = {
  version: 1
  title?: string
  nodes: DiagramNode[]
  edges: DiagramEdge[]
}

export type GeneratedDiagram = {
  title: string
  document: DiagramDocument
  archcode: string
  summary: string
  warnings: string[]
}

export class DiagramProblem extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DiagramProblem'
  }
}
