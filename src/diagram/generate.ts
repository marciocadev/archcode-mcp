import { isServiceName } from './catalog'
import { resolveConnectionHandle } from './handles'
import { parseArchitectureText } from './parseText'
import {
  DiagramProblem,
  HTTP_VERBS,
  type ConnectionInput,
  type DiagramDocument,
  type DiagramEdge,
  type DiagramNode,
  type GeneratedDiagram,
  type HttpVerb,
  type ResourceInput,
  type RouteInput,
  type ServiceName,
} from './types'

const NODE_WIDTH = 320
const NODE_HEIGHT = 108
const COLUMN_GAP = 80
const ROW_GAP = 48
const ORIGIN_X = 80
const ORIGIN_Y = 80
const MAX_RESOURCES = 40
const STREAM_EVENTS = ['INSERT', 'MODIFY', 'REMOVE'] as const

const ALIASES: Record<string, ServiceName> = {
  lambda: 'aws-lambda',
  function: 'aws-lambda',
  'aws-lambda': 'aws-lambda',
  dynamodb: 'dynamodb-table',
  table: 'dynamodb-table',
  'dynamodb-table': 'dynamodb-table',
  api: 'api-gateway-rest',
  'api-gateway': 'api-gateway-rest',
  'api-gateway-rest': 'api-gateway-rest',
  sqs: 'sqs-queue',
  queue: 'sqs-queue',
  'sqs-queue': 'sqs-queue',
  dlq: 'sqs-dlq',
  'sqs-dlq': 'sqs-dlq',
  sns: 'sns-topic',
  topic: 'sns-topic',
  'sns-topic': 'sns-topic',
  s3: 's3-bucket',
  bucket: 's3-bucket',
  's3-bucket': 's3-bucket',
  scheduler: 'eventbridge-scheduler',
  schedule: 'eventbridge-scheduler',
  'eventbridge-scheduler': 'eventbridge-scheduler',
  event: 'eventbridge-event',
  rule: 'eventbridge-event',
  'eventbridge-event': 'eventbridge-event',
  ssm: 'ssm-parameter',
  parameter: 'ssm-parameter',
  'ssm-parameter': 'ssm-parameter',
  secret: 'secrets-manager',
  'secrets-manager': 'secrets-manager',
}

const RUNTIME_BY_LANGUAGE = {
  typescript: 'nodejs24.x',
  python: 'python3.14',
  go: 'provided.al2023',
} as const

const LANGUAGE_BY_RUNTIME = {
  'nodejs24.x': 'typescript',
  'python3.14': 'python',
  'provided.al2023': 'go',
} as const

type ResolvedLink = {
  from: ResourceInput
  to: ResourceInput
  handle: string
  singleTarget: boolean
  s3Event?: 'created' | 'removed'
  grant?: ConnectionInput['grant']
  label?: string
}

export function generateDiagram(input: {
  text?: string
  title?: string
  resources?: ResourceInput[]
  connections?: ConnectionInput[]
}): GeneratedDiagram {
  const warnings: string[] = []
  let resources: ResourceInput[]
  let connections: ConnectionInput[]

  if (input.resources && input.resources.length > 0) {
    resources = input.resources.map(normalizeResource)
    connections = (input.connections ?? []).map(normalizeConnection)
  } else {
    const text = input.text?.trim() ?? ''
    if (!text) {
      throw new DiagramProblem('Provide the architecture text or the resources list.')
    }
    if (text.length > 20_000) {
      throw new DiagramProblem('O texto passa de 20 mil caracteres.')
    }
    const parsed = parseArchitectureText(text)
    resources = parsed.resources
    connections = parsed.connections
    warnings.push(...parsed.warnings)
  }

  if (resources.length === 0) {
    throw new DiagramProblem(
      'No components found in the text. Name the services, for example a Lambda, an SQS queue, a DynamoDB table, or a REST API.',
    )
  }
  if (resources.length > MAX_RESOURCES) {
    throw new DiagramProblem(`A diagram accepts at most ${MAX_RESOURCES} components.`)
  }

  const errors: string[] = []
  ensureUniqueIds(resources, errors)
  absorbRouteLinks(resources, connections, errors)
  completeRequiredLinks(resources, connections, warnings, errors)
  prepareSettings(resources, connections, warnings, errors)
  const links = resolveLinks(resources, connections, warnings, errors)
  enforceHandleLimits(links, errors)
  if (errors.length > 0) throw new DiagramProblem(errors.join('\n'))

  const title = (input.title?.trim() || resources[0]?.name || 'Arquitetura').slice(0, 120)
  const document = layoutDocument(title, resources, links)
  const archcode = `${JSON.stringify(document, null, 2)}\n`
  const summary = `Diagram "${title}" with ${document.nodes.length} components and ${document.edges.length} connections.`
  return { title, document, archcode, summary, warnings }
}

function normalizeResource(raw: ResourceInput): ResourceInput {
  const alias = ALIASES[String(raw?.service ?? '').trim().toLowerCase()]
  if (!alias) {
    throw new DiagramProblem(`Unknown service: ${String(raw?.service ?? '')}.`)
  }
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  if (!name) throw new DiagramProblem(`Service ${alias} is missing a name.`)
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : `${alias}:${name}`
  const routes = normalizeRoutes(raw.routes)
  return { ...raw, id, service: alias, name, routes }
}

function normalizeRoutes(routes: ResourceInput['routes']): RouteInput[] | undefined {
  if (!routes) return undefined
  if (!Array.isArray(routes)) throw new DiagramProblem('routes must be a list.')
  return routes.map((route) => {
    const verb = String(route.verb ?? '').toUpperCase()
    if (!HTTP_VERBS.includes(verb as HttpVerb)) {
      throw new DiagramProblem(`Invalid HTTP verb: ${route.verb}.`)
    }
    return { verb: verb as HttpVerb, path: normalizePath(route.path) }
  })
}

function normalizeConnection(raw: ConnectionInput): ConnectionInput {
  if (!raw || typeof raw.from !== 'string' || typeof raw.to !== 'string') {
    throw new DiagramProblem('Each connection needs from and to.')
  }
  return {
    from: raw.from.trim(),
    to: raw.to.trim(),
    via: raw.via?.trim() || undefined,
    grant: raw.grant,
    s3Event: raw.s3Event,
    label: raw.label?.trim() || undefined,
  }
}

function ensureUniqueIds(resources: ResourceInput[], errors: string[]): void {
  const seen = new Set<string>()
  for (const resource of resources) {
    if (seen.has(resource.id)) errors.push(`Id repetido: ${resource.id}.`)
    seen.add(resource.id)
  }
}

function absorbRouteLinks(resources: ResourceInput[], connections: ConnectionInput[], errors: string[]): void {
  for (const connection of connections) {
    const source = findResource(resources, connection.from)
    if (!source || source.service !== 'api-gateway-rest' || !connection.via) continue
    const route = parseViaRoute(connection.via)
    if (!route) continue
    source.routes ??= []
    if (!source.routes.some((item) => item.verb === route.verb && item.path === route.path)) {
      source.routes.push(route)
    }
    connection.via = `${route.verb} ${route.path}`
  }
}

function completeRequiredLinks(
  resources: ResourceInput[],
  connections: ConnectionInput[],
  warnings: string[],
  errors: string[],
): void {
  const lambdas = resources.filter((item) => item.service === 'aws-lambda')
  for (const api of resources.filter((item) => item.service === 'api-gateway-rest')) {
    if (!api.routes || api.routes.length === 0) {
      errors.push(`${api.name} has no routes. Provide a verb and a path, for example POST /orders.`)
      continue
    }
    for (const route of api.routes) {
      const via = `${route.verb} ${route.path}`
      const linked = connections.some((item) => item.from === api.id && item.via === via)
      if (linked) continue
      if (lambdas.length === 1) {
        connections.push({ from: api.id, to: lambdas[0]!.id, via })
        warnings.push(`Route ${via} of ${api.name} connected to ${lambdas[0]!.name}.`)
      } else {
        errors.push(`Route ${via} of ${api.name} has no Lambda. Provide the connection with via "${via}".`)
      }
    }
  }

  const eventTargets = resources.filter((item) =>
    item.service === 'aws-lambda' || item.service === 'sqs-queue' || item.service === 'sns-topic',
  )
  for (const source of resources.filter((item) => item.service === 'eventbridge-scheduler' || item.service === 'eventbridge-event')) {
    if (connections.some((item) => item.from === source.id)) continue
    if (eventTargets.length === 1) {
      connections.push({ from: source.id, to: eventTargets[0]!.id })
      warnings.push(`${source.name} connected to ${eventTargets[0]!.name}.`)
    } else {
      errors.push(`${source.name} needs a target: a Lambda, a queue, or a topic.`)
    }
  }

  const queues = resources.filter((item) => item.service === 'sqs-queue')
  for (const dlq of resources.filter((item) => item.service === 'sqs-dlq')) {
    if (connections.some((item) => item.to === dlq.id)) continue
    const related = queues.filter((queue) => namesRelated(queue.name, dlq.name))
    const chosen = queues.length === 1 ? queues[0] : related.length === 1 ? related[0] : undefined
    if (chosen) {
      connections.push({ from: chosen.id, to: dlq.id, via: 'dlq' })
      warnings.push(`Dead-letter queue ${chosen.name} → ${dlq.name}.`)
    } else {
      errors.push(`${dlq.name} must receive the dlq output of a queue.`)
    }
  }
}

function prepareSettings(
  resources: ResourceInput[],
  connections: ConnectionInput[],
  warnings: string[],
  errors: string[],
): void {
  for (const resource of resources) {
    if (resource.service === 'eventbridge-event') {
      const sources = resource.eventSources?.filter(Boolean) ?? []
      const details = resource.detailTypes?.filter(Boolean) ?? []
      if (sources.length === 0 && details.length === 0) {
        resource.detailTypes = [sanitizeIdentifier(resource.name, 64) || 'Event']
        warnings.push(`${resource.name} has no filter; using detail type "${resource.detailTypes[0]}".`)
      }
    }
    if (resource.service === 'eventbridge-scheduler') {
      if (resource.scheduleKind === 'once') {
        const onceAt = resource.onceAt?.trim() ?? ''
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(onceAt)) {
          errors.push(`${resource.name} needs a date in the form 2026-11-17T08:00.`)
        } else {
          resource.onceAt = onceAt
        }
      } else if (resource.scheduleKind !== 'cron' && resource.scheduleKind !== 'rate') {
        resource.scheduleKind = 'rate'
        resource.rateValue ??= 5
        resource.rateUnit ??= 'minutes'
        warnings.push(`${resource.name} has no frequency; using every ${resource.rateValue} ${resource.rateUnit}.`)
      }
      if (resource.scheduleKind === 'rate' && (!Number.isInteger(resource.rateValue) || (resource.rateValue ?? 0) < 1)) {
        errors.push(`${resource.name} needs an integer frequency greater than zero.`)
      }
      if (resource.scheduleKind === 'cron' && cronFields(resource.cronExpression).length !== 6) {
        errors.push(`${resource.name} needs a cron expression with 6 fields, for example 0 12 * * ? *.`)
      }
    }
  }
}

function resolveLinks(
  resources: ResourceInput[],
  connections: ConnectionInput[],
  warnings: string[],
  errors: string[],
): ResolvedLink[] {
  const links: ResolvedLink[] = []
  const seen = new Set<string>()
  for (const connection of connections) {
    const from = findResource(resources, connection.from)
    const to = findResource(resources, connection.to)
    if (!from || !to) {
      errors.push(`Unknown connection: ${connection.from} → ${connection.to}.`)
      continue
    }
    const resolved = resolveConnectionHandle({
      source: from.service,
      sourceName: from.name,
      target: to.service,
      targetName: to.name,
      via: connection.via,
      s3Event: connection.s3Event,
      routes: from.routes,
    })
    if (!resolved.ok) {
      errors.push(resolved.message)
      continue
    }
    if (resolved.warning) warnings.push(resolved.warning)
    if (resolved.choice.handle === 'stream' && (!from.stream || from.stream === 'none')) {
      from.stream = 'new'
      warnings.push(`Stream of ${from.name} enabled as new image.`)
    }
    const key = `${from.id}:${to.id}:${resolved.choice.handle}`
    if (seen.has(key)) continue
    seen.add(key)
    const kind = edgeKind(from.service, to.service)
    links.push({
      from,
      to,
      handle: resolved.choice.handle,
      singleTarget: resolved.choice.singleTarget,
      s3Event: resolved.choice.s3Event,
      grant: kind === 'dynamo' || kind === 's3' ? connection.grant : undefined,
      label: connection.label,
    })
  }
  return links
}

function enforceHandleLimits(links: ResolvedLink[], errors: string[]): void {
  const counts = new Map<string, number>()
  for (const link of links) {
    const key = `${link.from.id}:${link.handle}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
    if (link.singleTarget && (counts.get(key) ?? 0) > 1) {
      errors.push(`${link.from.name} already uses the ${link.handle} output. It accepts a single target.`)
    }
  }
}

function layoutDocument(title: string, resources: ResourceInput[], links: ResolvedLink[]): DiagramDocument {
  const positions = place(resources, links)
  const hashes = new Set<string>()
  const nodes: DiagramNode[] = resources.map((resource) => {
    const hash = stableHash(`${resource.service}:${resource.name}`, hashes)
    const dlq = links.some((link) => link.to.id === resource.id && link.handle === 'dlq')
    return {
      id: `${resource.service}-${hash}`,
      type: resource.service,
      position: positions.get(resource.id) ?? { x: ORIGIN_X, y: ORIGIN_Y },
      data: nodeData(resource, hash, links, dlq),
    }
  })
  const byResource = new Map(resources.map((resource, index) => [resource.id, nodes[index]!]))
  const usedEdgeIds = new Set<string>()
  const edges: DiagramEdge[] = links.map((link) => {
    const source = byResource.get(link.from.id)!
    const target = byResource.get(link.to.id)!
    const id = uniqueEdgeId(link.from.name, link.to.name, link.handle, usedEdgeIds)
    return {
      id,
      type: 'aws',
      source: source.id,
      target: target.id,
      sourceHandle: link.handle,
      data: edgeData(link),
    }
  })
  return { version: 1, title, nodes, edges }
}

function nodeData(resource: ResourceInput, hash: string, links: ResolvedLink[], isDlqTarget: boolean): Record<string, unknown> {
  const name = displayName(resource)
  const data: Record<string, unknown> = {
    componentKey: resource.service,
    hash,
    name,
  }
  if (resource.service === 'aws-lambda') data.lambda = lambdaSettings(resource, name)
  if (resource.service === 'dynamodb-table') data.dynamodbTable = tableSettings(resource, name)
  if (resource.service === 'api-gateway-rest') data.apiGateway = apiSettings(resource, name)
  if (resource.service === 'sqs-queue' || resource.service === 'sqs-dlq') {
    data.sqsQueue = queueSettings(resource, name, isDlqTarget, links)
  }
  if (resource.service === 'sns-topic') data.snsTopic = topicSettings(resource, name)
  if (resource.service === 's3-bucket') data.s3Bucket = bucketSettings(name, bucketEvents(resource, links))
  if (resource.service === 'eventbridge-scheduler' || resource.service === 'eventbridge-event') {
    data.eventBridge = eventSettings(resource, name)
  }
  if (resource.service === 'ssm-parameter') data.ssmParameter = parameterSettings(resource, name)
  if (resource.service === 'secrets-manager') data.secretsManager = secretSettings(resource, name)
  return data
}

function lambdaSettings(resource: ResourceInput, name: string): Record<string, unknown> {
  const language = resource.language ?? (resource.runtime ? LANGUAGE_BY_RUNTIME[resource.runtime] : 'typescript')
  const runtime = resource.runtime ?? RUNTIME_BY_LANGUAGE[language]
  if (resource.language && resource.runtime && RUNTIME_BY_LANGUAGE[resource.language] !== resource.runtime) {
    throw new DiagramProblem(`${name} mixes language ${resource.language} with runtime ${resource.runtime}.`)
  }
  const memory = clamp(resource.memoryMb ?? 128, 128, 10240)
  const timeout = clamp(resource.timeoutSeconds ?? 3, 1, 900)
  return {
    functionName: requirePattern(name, /^[A-Za-z0-9_-]{1,64}$/, `${resource.name} is not a valid Lambda name. Use letters, numbers, hyphens, or underscores.`),
    runtime,
    language,
    architecture: resource.architecture === 'arm64' ? 'arm64' : 'x86_64',
    memoryMb: memory,
    ephemeralStorageMb: 512,
    timeoutSeconds: timeout,
    timeoutUnit: 'seconds',
    observability: { structuredLog: false, trace: false, metric: false, metricNamespace: '' },
  }
}

function tableSettings(resource: ResourceInput, name: string): Record<string, unknown> {
  const tableName = requirePattern(name, /^[A-Za-z0-9_.-]{3,255}$/, `${resource.name} is not a valid table name. Use 3 to 255 letters, numbers, periods, hyphens, or underscores.`)
  const partition = sanitizeIdentifier(resource.partitionKey || 'id', 255)
  const sort = resource.sortKey ? sanitizeIdentifier(resource.sortKey, 255) : ''
  if (!/^[A-Za-z0-9_.-]{1,255}$/.test(partition)) {
    throw new DiagramProblem(`The partition key of ${name} is invalid.`)
  }
  if (sort && sort === partition) throw new DiagramProblem(`The sort key of ${name} must differ from the partition key.`)
  const stream = resource.stream ?? 'none'
  const view = stream === 'keys' || stream === 'new' || stream === 'old' || stream === 'both' ? stream : 'none'
  return {
    tableName,
    partitionKey: { name: partition, type: 'S' },
    sortKey: sort ? { name: sort, type: 'S' } : null,
    removalPolicy: 'destroy',
    stream: view,
    streamEvents: view === 'none' ? [] : [...STREAM_EVENTS],
  }
}

function apiSettings(resource: ResourceInput, name: string): Record<string, unknown> {
  return {
    gatewayName: requirePattern(name, /^[A-Za-z0-9_-]{1,128}$/, `${resource.name} is not a valid API name.`),
    routes: (resource.routes ?? []).map((route) => ({
      verb: route.verb,
      path: route.path,
      filterEnabled: false,
      filterJson: '',
    })),
  }
}

function queueSettings(resource: ResourceInput, name: string, isDlqTarget: boolean, links: ResolvedLink[]): Record<string, unknown> {
  const fifo = Boolean(resource.fifo) || name.endsWith('.fifo')
  const queueName = fifo && !name.endsWith('.fifo') ? `${name}.fifo` : name
  const pattern = fifo ? /^[A-Za-z0-9_-]{1,75}\.fifo$/ : /^[A-Za-z0-9_-]{1,80}$/
  const linked = links.some((link) => link.from.id === resource.id && link.handle === 'dlq')
  return {
    queueName: requirePattern(queueName, pattern, `${resource.name} is not a valid${fifo ? ' FIFO' : ''} queue name.`),
    queueType: fifo ? 'fifo' : 'standard',
    useDeadLetterQueue: isDlqTarget ? false : linked,
    visibilityTimeoutSeconds: 30,
    visibilityTimeoutUnit: 'seconds',
    deliveryDelaySeconds: 0,
    deliveryDelayUnit: 'seconds',
    receiveMessageWaitTimeSeconds: 0,
    messageRetentionPeriodSeconds: 4 * 86400,
    messageRetentionPeriodUnit: 'days',
    maximumMessageSizeKib: 1024,
  }
}

function topicSettings(resource: ResourceInput, name: string): Record<string, unknown> {
  const fifo = Boolean(resource.fifo) || name.endsWith('.fifo')
  const topicName = fifo && !name.endsWith('.fifo') ? `${name}.fifo` : name
  const pattern = fifo ? /^[A-Za-z0-9_-]{1,251}\.fifo$/ : /^[A-Za-z0-9_-]{1,256}$/
  return {
    topicName: requirePattern(topicName, pattern, `${resource.name} is not a valid topic name.`),
    displayName: '',
    fifo,
    contentBasedDeduplication: fifo,
  }
}

function bucketSettings(name: string, events: Array<'created' | 'removed'>): Record<string, unknown> {
  const bucketName = name.trim().toLowerCase().replace(/[^a-z0-9.-]/g, '-').replace(/-+/g, '-').replace(/^[.-]+|[.-]+$/g, '').slice(0, 63)
  return {
    bucketName: requirePattern(bucketName, /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, `${name} is not a valid bucket name. Use 3 to 63 lowercase letters, numbers, periods, or hyphens.`),
    removalPolicy: 'destroy',
    autoDeleteObjects: false,
    eventsEnabled: events.length > 0,
    events,
  }
}

function bucketEvents(resource: ResourceInput, links: ResolvedLink[]): Array<'created' | 'removed'> {
  const selected = new Set<'created' | 'removed'>()
  for (const link of links) {
    if (link.from.id !== resource.id || link.handle !== 'event') continue
    selected.add(link.s3Event === 'removed' ? 'removed' : 'created')
  }
  return (['created', 'removed'] as const).filter((event) => selected.has(event))
}

function eventSettings(resource: ResourceInput, name: string): Record<string, unknown> {
  const ruleName = requirePattern(
    sanitizeIdentifier(name, 64),
    /^[A-Za-z0-9_.-]{1,64}$/,
    `${resource.name} is not a valid EventBridge rule name.`,
  )
  const scheduleKind = resource.scheduleKind === 'cron' ? 'cron' : resource.scheduleKind === 'once' ? 'once' : 'rate'
  const rateValue = resource.rateValue && resource.rateValue > 0 ? Math.floor(resource.rateValue) : 5
  const rateUnit = resource.rateUnit === 'hours' || resource.rateUnit === 'days' ? resource.rateUnit : 'minutes'
  const cronExpression = resource.cronExpression?.trim() || '0 12 * * ? *'
  const onceAt = resource.onceAt?.trim() ?? ''
  const schedule = scheduleKind === 'cron'
    ? `cron(${cronExpression})`
    : scheduleKind === 'once'
      ? `at(${onceAt}:00)`
      : rateExpression(rateValue, rateUnit)
  return {
    ruleName,
    scheduleKind,
    rateValue,
    rateUnit,
    cronExpression,
    onceAt,
    timeZone: 'UTC',
    schedule,
    sources: resource.eventSources ?? [],
    detailTypes: resource.detailTypes ?? [],
    detail: '',
    enabled: true,
  }
}

function parameterSettings(resource: ResourceInput, name: string): Record<string, unknown> {
  const parameterName = name.startsWith('/') ? name : `/${name.replace(/^\/+/, '')}`
  return {
    parameterName: requirePattern(parameterName, /^(?!.*\/\/)[A-Za-z0-9_./-]{1,2048}$/, `${resource.name} is not a valid parameter name.`),
    parameterType: resource.parameterType === 'StringList' ? 'StringList' : 'String',
    defaultValue: '',
    ownership: resource.ownership === 'create' ? 'create' : 'reference',
  }
}

function secretSettings(resource: ResourceInput, name: string): Record<string, unknown> {
  const jsonKey = resource.jsonKey?.trim() ?? ''
  if (jsonKey && !/^[A-Za-z0-9_.-]{1,256}$/.test(jsonKey)) {
    throw new DiagramProblem(`The jsonKey of ${name} is invalid.`)
  }
  return {
    secretName: requirePattern(name, /^[A-Za-z0-9/_+=.@-]{1,512}$/, `${resource.name} is not a valid secret name.`),
    jsonKey,
    ownership: resource.ownership === 'create' ? 'create' : 'reference',
  }
}

function edgeData(link: ResolvedLink): Record<string, unknown> {
  const data: Record<string, unknown> = { labelText: link.label ?? '', pathKind: 'bezier', labelOffset: 0.5 }
  const kind = edgeKind(link.from.service, link.to.service)
  if (link.handle === 'dlq') {
    data.maxReceiveCount = 5
    data.showConfiguration = false
  } else if (link.from.service === 'sqs-queue' && link.to.service === 'aws-lambda') {
    Object.assign(data, {
      batchSize: 10,
      reportBatchItemFailure: false,
      maxBatchingWindowMinutes: 0,
      maxBatchingWindowSeconds: 0,
      filterJson: '',
      filterEnabled: false,
      showConfiguration: false,
    })
  } else if (link.from.service === 'sns-topic') {
    data.filterJson = ''
    data.filterEnabled = false
  } else if (kind === 'dynamo') {
    data.dynamodbGrant = link.grant ?? 'read-write'
  } else if (kind === 's3') {
    data.s3Grant = link.grant === 'read' || link.grant === 'write' ? link.grant : 'read-write'
  } else if (link.handle === 'event') {
    data.s3Event = link.s3Event ?? 'created'
  } else if (link.handle === 'stream') {
    data.dynamodbStreamEvents = ['INSERT', 'MODIFY', 'REMOVE']
  }
  return data
}

function edgeKind(source: ServiceName, target: ServiceName): string {
  if (source === 'sqs-queue' && target === 'aws-lambda') return 'sqs'
  if (source === 'sns-topic') return 'sns'
  if (source === 'aws-lambda' && target === 'dynamodb-table') return 'dynamo'
  if (source === 'aws-lambda' && target === 's3-bucket') return 's3'
  return 'default'
}

function place(resources: ResourceInput[], links: ResolvedLink[]): Map<string, { x: number; y: number }> {
  const depth = new Map<string, number>()
  for (const resource of resources) depth.set(resource.id, 0)
  for (let pass = 0; pass < resources.length; pass += 1) {
    let changed = false
    for (const link of links) {
      const next = (depth.get(link.from.id) ?? 0) + 1
      if (next > (depth.get(link.to.id) ?? 0)) {
        depth.set(link.to.id, next)
        changed = true
      }
    }
    if (!changed) break
  }

  const columns = new Map<number, string[]>()
  for (const resource of resources) {
    const column = depth.get(resource.id) ?? 0
    columns.set(column, [...(columns.get(column) ?? []), resource.id])
  }

  const positions = new Map<string, { x: number; y: number }>()
  for (const [column, ids] of [...columns.entries()].sort((left, right) => left[0] - right[0])) {
    ids.forEach((id, row) => {
      positions.set(id, {
        x: ORIGIN_X + column * (NODE_WIDTH + COLUMN_GAP),
        y: ORIGIN_Y + row * (NODE_HEIGHT + ROW_GAP),
      })
    })
  }
  return positions
}

function displayName(resource: ResourceInput): string {
  if (resource.service === 's3-bucket') {
    return resource.name.trim().toLowerCase().replace(/[^a-z0-9.-]/g, '-').replace(/-+/g, '-').replace(/^[.-]+|[.-]+$/g, '').slice(0, 63)
  }
  if (resource.service === 'ssm-parameter') {
    return resource.name.startsWith('/') ? resource.name : `/${resource.name.replace(/^\/+/, '')}`
  }
  return sanitizeIdentifier(resource.name, resource.service === 'sqs-queue' || resource.service === 'sqs-dlq' ? 80 : 128)
}

function sanitizeIdentifier(name: string, max: number): string {
  return name.trim().replace(/\s+/g, '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, max)
}

function requirePattern(value: string, pattern: RegExp, message: string): string {
  if (!pattern.test(value)) throw new DiagramProblem(message)
  return value
}

function findResource(resources: ResourceInput[], ref: string): ResourceInput | undefined {
  const byId = resources.find((item) => item.id === ref)
  if (byId) return byId
  const byName = resources.filter((item) => item.name.toLowerCase() === ref.toLowerCase())
  if (byName.length === 1) return byName[0]
  if (byName.length > 1 && isServiceName(ref)) return undefined
  return undefined
}

function parseViaRoute(via: string): RouteInput | undefined {
  const match = /^(?:route:)?(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|ANY)\s*:?\s*(\/\S*)$/i.exec(via.trim())
  if (!match) return undefined
  return { verb: match[1]!.toUpperCase() as HttpVerb, path: normalizePath(match[2]!) }
}

function normalizePath(path: string): string {
  const trimmed = (path ?? '').trim()
  if (!trimmed || trimmed === '/') return '/'
  return (trimmed.startsWith('/') ? trimmed : `/${trimmed}`).replace(/\/{2,}/g, '/')
}

function namesRelated(queueName: string, dlqName: string): boolean {
  const queue = queueName.toLowerCase().replace(/[^a-z0-9]/g, '')
  const dlq = dlqName.toLowerCase().replace(/[^a-z0-9]/g, '')
  return dlq.startsWith(queue) || queue.startsWith(dlq.replace(/dlq$/, ''))
}

function cronFields(expression: string | undefined): string[] {
  return (expression ?? '').trim().split(/\s+/).filter(Boolean)
}

function rateExpression(value: number, unit: 'minutes' | 'hours' | 'days'): string {
  const singular = { minutes: 'minute', hours: 'hour', days: 'day' }[unit]
  const plural = { minutes: 'minutes', hours: 'hours', days: 'days' }[unit]
  return `rate(${value} ${value === 1 ? singular : plural})`
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.round(value)))
}

function stableHash(seed: string, used: Set<string>): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let hash = 2166136261
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  for (let salt = 0; salt < 64; salt += 1) {
    let value = hash ^ Math.imul(salt + 1, 0x9e3779b9)
    let token = ''
    for (let index = 0; index < 6; index += 1) {
      token += alphabet[(value >>> 0) % alphabet.length]
      value = Math.imul(value, 16777619) ^ (value >>> 13)
    }
    if (!used.has(token)) {
      used.add(token)
      return token
    }
  }
  throw new DiagramProblem('Could not generate a unique identifier for the diagram.')
}

function uniqueEdgeId(from: string, to: string, handle: string, used: Set<string>): string {
  const base = `${from}-${to}-${handle}`.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 72) || 'edge'
  let id = base
  let n = 2
  while (used.has(id)) {
    id = `${base}-${n}`
    n += 1
  }
  used.add(id)
  return id
}
