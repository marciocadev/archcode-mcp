import { isServiceName } from './catalog'
import {
  HTTP_VERBS,
  type ConnectionInput,
  type HttpVerb,
  type ResourceInput,
  type ServiceName,
} from './types'

export type ParsedArchitecture = {
  resources: ResourceInput[]
  connections: ConnectionInput[]
  warnings: string[]
}

type Draft = ResourceInput & { at: number }

type Detector = {
  service: ServiceName
  pattern: RegExp
}

const DETECTORS: Detector[] = [
  { service: 'sqs-dlq', pattern: /\b(?:dead[- ]letter(?:\s+queue)?|fila\s+de\s+letras\s+mortas|dlq)\b/gi },
  { service: 'api-gateway-rest', pattern: /\b(?:api\s+gateway(?:\s+rest)?|apigateway|rest\s+api|api\s+rest|\bapi)\b/gi },
  { service: 'eventbridge-scheduler', pattern: /\b(?:eventbridge\s+scheduler|agendador|agendamento|scheduler|schedule)\b/gi },
  { service: 'eventbridge-event', pattern: /\b(?:eventbridge(?:\s+event|\s+rule)?|regra\s+de\s+evento|evento)\b/gi },
  { service: 'dynamodb-table', pattern: /\b(?:dynamodb|dynamo\s*db|dynamo|tabela|table)\b/gi },
  { service: 'sqs-queue', pattern: /\b(?:sqs|fila|queue)\b/gi },
  { service: 'sns-topic', pattern: /\b(?:sns|t[oó]pico|topic)\b/gi },
  { service: 's3-bucket', pattern: /\b(?:s3|bucket)\b/gi },
  { service: 'ssm-parameter', pattern: /\b(?:ssm|parameter\s+store|par[aâ]metro)\b/gi },
  { service: 'secrets-manager', pattern: /\b(?:secrets?\s+manager|segredo|secret)\b/gi },
  { service: 'aws-lambda', pattern: /\b(?:lambda|fun[cç][aã]o|function)\b/gi },
]

const FILLER = new Set([
  'de', 'do', 'da', 'dos', 'das', 'em', 'no', 'na', 'nos', 'nas', 'para', 'com', 'que',
  'um', 'uma', 'o', 'a', 'os', 'as', 'the', 'of', 'for', 'to', 'and', 'e', 'with', 'from',
  'rest', 'gateway', 'queue', 'topic', 'table', 'function', 'chamada', 'chamado', 'named',
  'nome', 'funcao', 'função', 'store', 'manager', 'created', 'criado', 'removed', 'removido',
  'letter', 'dead',
  'upload', 'objeto', 'object', 'deleted', 'delete', 'arquivo', 'file', 'event',
  'ligado', 'ligada', 'ligados', 'ligadas', 'conectado', 'conectada', 'conectados', 'conectadas',
  'processado', 'processada', 'processados', 'processadas', 'pela', 'pelo', 'pelos', 'pelas',
])

const SERVICE_WORD = new Set([
  'api', 'apigateway', 'lambda', 'function', 'dynamodb', 'dynamo', 'table', 'sqs', 'queue', 'sns', 'topic', 's3', 'bucket',
  'dlq', 'ssm', 'eventbridge', 'scheduler', 'schedule', 'secret', 'secrets', 'segredo',
  'evento', 'event', 'fila', 'tabela', 'topico', 'tópico', 'funcao', 'função',
])

const GENERICS: Array<{ service: ServiceName; pattern: RegExp }> = [
  { service: 'sqs-dlq', pattern: /\b(?:dlq|dead[- ]letter)\b/gi },
  { service: 'api-gateway-rest', pattern: /\bapi\b/gi },
  { service: 'eventbridge-scheduler', pattern: /\b(?:agendamento|agendador|scheduler|schedule)\b/gi },
  { service: 'eventbridge-event', pattern: /\b(?:evento|regra)\b/gi },
  { service: 'dynamodb-table', pattern: /\b(?:tabela|table|dynamodb|dynamo)\b/gi },
  { service: 'sqs-queue', pattern: /\b(?:fila|queue)\b/gi },
  { service: 'sns-topic', pattern: /\b(?:t[oó]pico|topic)\b/gi },
  { service: 's3-bucket', pattern: /\b(?:bucket|s3)\b/gi },
  { service: 'ssm-parameter', pattern: /\b(?:par[aâ]metro|parameter)\b/gi },
  { service: 'secrets-manager', pattern: /\b(?:segredo|secret)\b/gi },
  { service: 'aws-lambda', pattern: /\b(?:lambda|fun[cç][aã]o|function)\b/gi },
]

const CONSUME = ['consome', 'consomem', 'processa', 'processam', 'consume', 'consumes', 'processes', 'process']
const READ = ['le', 'consulta', 'consultam', 'reads', 'read', 'queries']
const WRITE = ['grava', 'gravam', 'salva', 'salvam', 'escreve', 'escrevem', 'armazena', 'armazenam', 'stores', 'writes', 'write', 'publica', 'publicam', 'publishes']
const TRIGGER = ['chama', 'chamam', 'invoca', 'invocam', 'aciona', 'acionam', 'dispara', 'disparam', 'executa', 'executam', 'envia', 'enviam', 'calls', 'invokes', 'triggers', 'runs', 'sends', 'conecta', 'conectado', 'conectada', 'connected', 'liga', 'ligado', 'ligada', 'connects']

const DATA_SERVICES = new Set<ServiceName>(['dynamodb-table', 's3-bucket', 'ssm-parameter', 'secrets-manager'])
const EVENT_TARGETS = new Set<ServiceName>(['aws-lambda', 'sqs-queue', 'sns-topic'])

type Mention = { resource: Draft; index: number }

export function parseArchitectureText(text: string): ParsedArchitecture {
  const drafts = collectResources(text)
  const warnings: string[] = []
  attachRoutes(text, drafts, warnings)
  attachSchedules(text, drafts, warnings)
  attachEventFilters(text, drafts)
  attachJsonKeys(text, drafts)
  attachLanguages(text, drafts)

  const connections: ConnectionInput[] = []
  collectArrows(text, drafts, connections, warnings)
  inferFromSentences(text, drafts, connections, warnings)
  inferDefaults(text, drafts, connections, warnings)

  return {
    resources: drafts.map(({ at: _at, ...resource }) => resource),
    connections,
    warnings,
  }
}

function collectResources(text: string): Draft[] {
  type Hit = { service: ServiceName; start: number; name: string; nameEnd: number }
  const hits: Hit[] = []
  for (const detector of DETECTORS) {
    const pattern = new RegExp(detector.pattern.source, 'gi')
    let match: RegExpExecArray | null
    while ((match = pattern.exec(text))) {
      const name = readName(text, match.index + match[0].length)
      if (!name) continue
      hits.push({
        service: detector.service,
        start: match.index,
        name: name.name,
        nameEnd: name.end,
      })
    }
  }
  hits.sort((a, b) => a.start - b.start || (b.nameEnd - b.start) - (a.nameEnd - a.start))
  const accepted: Hit[] = []
  for (const hit of hits) {
    const overlaps = accepted.some((item) => rangesOverlap(item.start, item.nameEnd, hit.start, hit.nameEnd))
    if (!overlaps) accepted.push(hit)
  }
  const present = new Set(accepted.map((hit) => hit.service))
  for (const detector of DETECTORS) {
    if (present.has(detector.service) || detector.service === 'eventbridge-event') continue
    const pattern = new RegExp(detector.pattern.source, 'gi')
    let match: RegExpExecArray | null
    while ((match = pattern.exec(text))) {
      const end = match.index + match[0].length
      const covered = accepted.some((item) => match!.index >= item.start && end <= item.nameEnd)
      if (covered || readName(text, end) || sameServiceFollows(text, end, detector.service)) continue
      accepted.push({ service: detector.service, start: match.index, name: defaultName(detector.service), nameEnd: end })
      present.add(detector.service)
      break
    }
  }

  const drafts: Draft[] = []
  const usedIds = new Set<string>()
  for (const hit of accepted) {
    const base = `${hit.service}:${hit.name}`
    let id = base
    let n = 2
    while (usedIds.has(id)) {
      id = `${base}:${n}`
      n += 1
    }
    usedIds.add(id)
    drafts.push({ id, service: hit.service, name: hit.name, at: hit.start })
  }
  return drafts
}

const WORD_SERVICE: Record<string, ServiceName> = {
  api: 'api-gateway-rest',
  apigateway: 'api-gateway-rest',
  lambda: 'aws-lambda',
  funcao: 'aws-lambda',
  function: 'aws-lambda',
  dynamodb: 'dynamodb-table',
  dynamo: 'dynamodb-table',
  tabela: 'dynamodb-table',
  table: 'dynamodb-table',
  sqs: 'sqs-queue',
  fila: 'sqs-queue',
  queue: 'sqs-queue',
  dlq: 'sqs-dlq',
  sns: 'sns-topic',
  topico: 'sns-topic',
  topic: 'sns-topic',
  s3: 's3-bucket',
  bucket: 's3-bucket',
  ssm: 'ssm-parameter',
  scheduler: 'eventbridge-scheduler',
  schedule: 'eventbridge-scheduler',
  secret: 'secrets-manager',
  secrets: 'secrets-manager',
  segredo: 'secrets-manager',
}

const DEFAULT_NAME: Record<ServiceName, string> = {
  'aws-lambda': 'Lambda',
  'sqs-queue': 'Queue',
  'sqs-dlq': 'Dlq',
  'dynamodb-table': 'Table',
  'api-gateway-rest': 'Api',
  'sns-topic': 'Topic',
  's3-bucket': 'bucket',
  'eventbridge-scheduler': 'Schedule',
  'eventbridge-event': 'Event',
  'ssm-parameter': 'parameter',
  'secrets-manager': 'Secret',
}

function defaultName(service: ServiceName): string {
  return DEFAULT_NAME[service]
}

function sameServiceFollows(text: string, from: number, service: ServiceName): boolean {
  let index = from
  while (index < text.length) {
    while (index < text.length && /[\s,:-]/.test(text[index] ?? '')) index += 1
    if (index >= text.length) return false
    const match = /^[A-Za-z][A-Za-z0-9_-]*/.exec(text.slice(index))
    if (!match) return false
    const folded = fold(match[0])
    if (FILLER.has(folded) || HTTP_VERBS.includes(match[0].toUpperCase() as HttpVerb)) {
      index += match[0].length
      continue
    }
    return WORD_SERVICE[folded] === service
  }
  return false
}

function readName(text: string, from: number): { name: string; end: number } | null {
  let index = from
  while (index < text.length) {
    while (index < text.length && /[\s,:-]/.test(text[index] ?? '')) index += 1
    if (index >= text.length) return null
    const quote = text[index]
    if (quote === '"' || quote === "'") {
      const end = text.indexOf(quote, index + 1)
      if (end < 0) return null
      const name = text.slice(index + 1, end).trim()
      return name ? { name, end: end + 1 } : null
    }
    if (text[index] === '/') {
      const path = /^\/[A-Za-z0-9_./-]+/.exec(text.slice(index))
      if (!path) return null
      return { name: path[0].replace(/[./-]+$/, ''), end: index + path[0].length }
    }
    const match = /^[A-Za-z][A-Za-z0-9_-]*/.exec(text.slice(index))
    if (!match) return null
    const word = match[0]
    const folded = fold(word)
    if (FILLER.has(folded) || HTTP_VERBS.includes(word.toUpperCase() as HttpVerb)) {
      index += word.length
      continue
    }
    if (SERVICE_WORD.has(folded)) return null
    return { name: word, end: index + word.length }
  }
  return null
}

function attachRoutes(text: string, drafts: Draft[], warnings: string[]): void {
  const apis = drafts.filter((item) => item.service === 'api-gateway-rest')
  const pattern = /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|ANY)\s+(\/[A-Za-z0-9_{}.\/+-]*)/gi
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text))) {
    const verb = match[1]!.toUpperCase() as HttpVerb
    const path = normalizePath(match[2]!)
    const api = nearest(apis, match.index) ?? apis[0]
    if (!api) {
      warnings.push(`Route ${verb} ${path} ignored because the text has no API Gateway.`)
      continue
    }
    api.routes ??= []
    if (!api.routes.some((route) => route.verb === verb && route.path === path)) {
      api.routes.push({ verb, path })
    }
  }
}

function attachSchedules(text: string, drafts: Draft[], warnings: string[]): void {
  const rate = /\b(?:a\s+cada|every|rate)\s*\(?\s*(\d+)\s*(minutos|minuto|minutes|minute|horas|hora|hours|hour|dias|dia|days|day)\b/gi
  let match: RegExpExecArray | null
  while ((match = rate.exec(text))) {
    const scheduler = ensureScheduler(drafts, match.index, warnings)
    scheduler.scheduleKind = 'rate'
    scheduler.rateValue = Number(match[1])
    scheduler.rateUnit = rateUnit(match[2]!)
  }
  const cron = /\bcron\(\s*([^)]+?)\s*\)/gi
  while ((match = cron.exec(text))) {
    const scheduler = ensureScheduler(drafts, match.index, warnings)
    scheduler.scheduleKind = 'cron'
    scheduler.cronExpression = match[1]!.trim()
  }
}

function ensureScheduler(drafts: Draft[], index: number, warnings: string[]): Draft {
  const existing = drafts.filter((item) => item.service === 'eventbridge-scheduler')
  const nearestScheduler = nearest(existing, index)
  if (nearestScheduler) return nearestScheduler
  const created: Draft = {
    id: 'eventbridge-scheduler:Schedule',
    service: 'eventbridge-scheduler',
    name: 'Schedule',
    at: index,
  }
  drafts.push(created)
  warnings.push('Created a schedule named Schedule because the text gives a frequency without naming the scheduler.')
  return created
}

function attachEventFilters(text: string, drafts: Draft[]): void {
  const events = drafts.filter((item) => item.service === 'eventbridge-event')
  if (events.length === 0) return
  const source = /(?:event\s*)?source\s*[:=]\s*([A-Za-z0-9._-]+)/i.exec(text)
  const detail = /detail(?:\s|-)?type\s*[:=]\s*([A-Za-z0-9._-]+)/i.exec(text)
  for (const event of events) {
    if (source) event.eventSources = [source[1]!]
    if (detail) event.detailTypes = [detail[1]!]
  }
}

function attachJsonKeys(text: string, drafts: Draft[]): void {
  const secrets = drafts.filter((item) => item.service === 'secrets-manager')
  if (secrets.length !== 1) return
  const match = /\b(?:json\s*key|chave)\s+([A-Za-z0-9_.-]+)/i.exec(text)
  if (match) secrets[0]!.jsonKey = match[1]
}

function attachLanguages(text: string, drafts: Draft[]): void {
  const lambdas = drafts.filter((item) => item.service === 'aws-lambda')
  const match = /\b(?:em|in|usando|using)\s+(python|typescript|go)\b/i.exec(text)
  if (!match || lambdas.length !== 1) return
  const language = match[1]!.toLowerCase() as 'python' | 'typescript' | 'go'
  lambdas[0]!.language = language
}

function collectArrows(text: string, drafts: Draft[], connections: ConnectionInput[], warnings: string[]): void {
  const pattern = /([A-Za-z][A-Za-z0-9_-]*)\s*(?:-\s*([^>\n]+?)\s*->|→|->)\s*([A-Za-z][A-Za-z0-9_-]*)/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text))) {
    const from = resolveName(drafts, match[1]!)
    const to = resolveName(drafts, match[3]!)
    if (!from || !to) {
      warnings.push(`Connection ${match[1]} -> ${match[3]} ignored because one of the names is not a component.`)
      continue
    }
    addConnection(connections, {
      from: from.id,
      to: to.id,
      via: match[2]?.trim() || undefined,
    })
  }
}

function inferFromSentences(text: string, drafts: Draft[], connections: ConnectionInput[], warnings: string[]): void {
  for (const sentence of splitSentences(text)) {
    const mentioned = mentions(sentence, drafts)
    if (mentioned.length < 2) continue
    const folded = fold(sentence.text)
    const consume = hasWord(folded, CONSUME)
    const write = hasWord(folded, WRITE)
    const read = hasWord(folded, READ)
    const trigger = hasWord(folded, TRIGGER)
    const eventWords = /\b(evento|event|upload|arquivo|objeto|object|criado|created|removido|removed|deleted|delete)\b/.test(folded)
    const streamWords = /\bstream\b/.test(folded)
    const removed = /\b(removed|removido|deleted|delete)\b/.test(folded) && !/\b(created|criado)\b/.test(folded)

    const queues = mentioned.filter((item) => item.resource.service === 'sqs-queue')
    const dlqs = mentioned.filter((item) => item.resource.service === 'sqs-dlq')
    for (const queue of queues) {
      for (const dlq of dlqs) {
        link(connections, warnings, queue.resource, dlq.resource, 'dlq', `DLQ ${queue.resource.name} → ${dlq.resource.name}.`)
      }
    }

    if (consume) {
      for (const source of mentioned) {
        if (source.resource.service !== 'sqs-queue' && source.resource.service !== 'sns-topic') continue
        for (const target of mentioned) {
          if (target.resource.service !== 'aws-lambda') continue
          link(connections, warnings, source.resource, target.resource, undefined, `${source.resource.name} → ${target.resource.name}.`)
        }
      }
    }

    if (streamWords) {
      for (const table of mentioned.filter((item) => item.resource.service === 'dynamodb-table')) {
        for (const lambda of mentioned.filter((item) => item.resource.service === 'aws-lambda')) {
          link(connections, warnings, table.resource, lambda.resource, 'stream', `Stream ${table.resource.name} → ${lambda.resource.name}.`)
        }
      }
    }

    for (let index = 0; index < mentioned.length - 1; index += 1) {
      const left = mentioned[index]!.resource
      const right = mentioned[index + 1]!.resource
      if (eventWords && left.service === 's3-bucket' && EVENT_TARGETS.has(right.service)) {
        link(connections, warnings, left, right, removed ? 'removed' : 'created', `Event from ${left.name} → ${right.name}.`)
        continue
      }
      if ((write || read) && left.service === 'aws-lambda' && DATA_SERVICES.has(right.service)) {
        const grant = right.service === 'dynamodb-table' || right.service === 's3-bucket'
          ? (write ? 'read-write' : 'read')
          : undefined
        link(connections, warnings, left, right, undefined, `${left.name} → ${right.name}.`, grant)
        continue
      }
      if (left.service === 'dynamodb-table' || right.service === 'sqs-dlq') continue
      if (trigger && left.service === 'api-gateway-rest' && right.service === 'aws-lambda') {
        const routes = left.routes ?? []
        if (routes.length === 1) {
          const via = `${routes[0]!.verb} ${routes[0]!.path}`
          link(connections, warnings, left, right, via, `${via} of ${left.name} → ${right.name}.`)
        }
        continue
      }
      if (trigger && canTry(left.service, right.service)) {
        link(connections, warnings, left, right, undefined, `${left.name} → ${right.name}.`)
      }
    }
  }
}

function inferDefaults(text: string, drafts: Draft[], connections: ConnectionInput[], warnings: string[]): void {
  const ofType = (service: ServiceName) => drafts.filter((item) => item.service === service)
  const lambdas = ofType('aws-lambda')
  const queues = ofType('sqs-queue')
  const topics = ofType('sns-topic')
  const buckets = ofType('s3-bucket')
  const tables = ofType('dynamodb-table')
  const folded = fold(text)
  const eventWords = /\b(evento|event|upload|arquivo|objeto|object|criado|created|removido|removed)\b/.test(folded)

  if (lambdas.length === 1) {
    for (const api of ofType('api-gateway-rest')) {
      for (const route of api.routes ?? []) {
        const via = `${route.verb} ${route.path}`
        link(connections, warnings, api, lambdas[0]!, via, `Route ${via} of ${api.name} → ${lambdas[0]!.name}.`)
      }
    }
    if (
      queues.length === 1 &&
      ofType('api-gateway-rest').length === 0 &&
      !connections.some((item) => item.from === queues[0]!.id && item.via !== 'dlq')
    ) {
      link(connections, warnings, queues[0]!, lambdas[0]!, undefined, `${queues[0]!.name} → ${lambdas[0]!.name}.`)
    }
    if (topics.length === 1 && !connections.some((item) => item.from === topics[0]!.id)) {
      link(connections, warnings, topics[0]!, lambdas[0]!, undefined, `${topics[0]!.name} → ${lambdas[0]!.name}.`)
    }
    if (tables.length === 1) {
      link(connections, warnings, lambdas[0]!, tables[0]!, undefined, `${lambdas[0]!.name} → ${tables[0]!.name}.`)
    }
    for (const secret of ofType('secrets-manager')) {
      link(connections, warnings, lambdas[0]!, secret, undefined, `${lambdas[0]!.name} → ${secret.name}.`)
    }
    for (const parameter of ofType('ssm-parameter')) {
      link(connections, warnings, lambdas[0]!, parameter, undefined, `${lambdas[0]!.name} → ${parameter.name}.`)
    }
    if (buckets.length === 1 && !eventWords && queues.length === 0 && topics.length === 0) {
      link(connections, warnings, lambdas[0]!, buckets[0]!, undefined, `${lambdas[0]!.name} → ${buckets[0]!.name}.`)
    }
  }

  const targets = [...lambdas, ...queues, ...topics]
  if (targets.length === 1) {
    for (const source of [...ofType('eventbridge-scheduler'), ...ofType('eventbridge-event')]) {
      link(connections, warnings, source, targets[0]!, undefined, `${source.name} → ${targets[0]!.name}.`)
    }
  }

  if (buckets.length === 1 && eventWords) {
    const destination = queues[0] ?? topics[0] ?? (lambdas.length === 1 ? lambdas[0] : undefined)
    if (destination && (queues.length + topics.length + (lambdas.length === 1 ? 1 : 0) === 1 || queues.length === 1)) {
      const removed = /\b(removed|removido)\b/.test(folded) && !/\b(created|criado)\b/.test(folded)
      link(connections, warnings, buckets[0]!, destination, removed ? 'removed' : 'created', `Event from ${buckets[0]!.name} → ${destination.name}.`)
    }
  }

  if (queues.length === 1) {
    for (const dlq of ofType('sqs-dlq')) {
      link(connections, warnings, queues[0]!, dlq, 'dlq', `DLQ ${queues[0]!.name} → ${dlq.name}.`)
    }
  } else {
    for (const dlq of ofType('sqs-dlq')) {
      const match = queues.filter((queue) => namesRelated(queue.name, dlq.name))
      if (match.length === 1) {
        link(connections, warnings, match[0]!, dlq, 'dlq', `DLQ ${match[0]!.name} → ${dlq.name}.`)
      }
    }
  }
}

function link(
  connections: ConnectionInput[],
  warnings: string[],
  from: Draft,
  to: Draft,
  via: string | undefined,
  warning: string,
  grant?: ConnectionInput['grant'],
): void {
  if (from.id === to.id) return
  if (connections.some((item) => item.from === from.id && item.to === to.id && (item.via ?? '') === (via ?? ''))) return
  connections.push({ from: from.id, to: to.id, via, grant })
  warnings.push(`Inferred connection: ${warning}`)
}

function addConnection(connections: ConnectionInput[], connection: ConnectionInput): void {
  if (connections.some((item) => item.from === connection.from && item.to === connection.to && (item.via ?? '') === (connection.via ?? ''))) return
  connections.push(connection)
}

function mentions(sentence: { start: number; text: string }, drafts: Draft[]): Mention[] {
  const found: Mention[] = []
  for (const resource of drafts) {
    const sameName = drafts.filter((item) => fold(item.name) === fold(resource.name))
    const flags = sameName.length === 1 ? 'gi' : 'g'
    const pattern = new RegExp(`(?<!/)\\b${escapeRegExp(resource.name)}\\b`, flags)
    let match: RegExpExecArray | null
    while ((match = pattern.exec(sentence.text))) {
      found.push({ resource, index: sentence.start + match.index })
    }
  }
  for (const generic of GENERICS) {
    const pattern = new RegExp(generic.pattern.source, 'gi')
    const ofType = drafts.filter((item) => item.service === generic.service)
    if (ofType.length !== 1) continue
    let match: RegExpExecArray | null
    while ((match = pattern.exec(sentence.text))) {
      const index = sentence.start + match.index
      const resource = ofType[0]!
      const overlapsName = found.some((item) => item.resource.id === resource.id && Math.abs(item.index - index) < resource.name.length + 1)
      if (!overlapsName) found.push({ resource, index })
    }
  }
  found.sort((a, b) => a.index - b.index || a.resource.id.localeCompare(b.resource.id))
  const seen = new Set<string>()
  return found.filter((item) => {
    if (seen.has(item.resource.id)) return false
    seen.add(item.resource.id)
    return true
  })
}

function splitSentences(text: string): Array<{ start: number; text: string }> {
  const sentences: Array<{ start: number; text: string }> = []
  const pattern = /[^\n.;]+/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text))) {
    const value = match[0].trim()
    if (value) sentences.push({ start: match.index, text: match[0] })
  }
  return sentences
}

function resolveName(drafts: Draft[], name: string): Draft | undefined {
  const matches = drafts.filter((item) => item.name === name || (fold(item.name) === fold(name) && drafts.filter((other) => fold(other.name) === fold(name)).length === 1))
  const unique = new Map(matches.map((item) => [item.id, item]))
  if (unique.size !== 1) return undefined
  return [...unique.values()][0]
}

function nearest<T extends { at: number }>(items: T[], index: number): T | undefined {
  let best: T | undefined
  let distance = Number.POSITIVE_INFINITY
  for (const item of items) {
    const delta = Math.abs(item.at - index)
    if (delta < distance) {
      best = item
      distance = delta
    }
  }
  return best
}

function canTry(source: ServiceName, target: ServiceName): boolean {
  if (!isServiceName(source) || !isServiceName(target)) return false
  if (source === 's3-bucket') return EVENT_TARGETS.has(target)
  if (source === 'dynamodb-table') return target === 'aws-lambda'
  if (source === 'sqs-queue') return target === 'aws-lambda' || target === 'sqs-dlq'
  if (source === 'api-gateway-rest') return target === 'aws-lambda'
  if (source === 'eventbridge-scheduler' || source === 'eventbridge-event') return EVENT_TARGETS.has(target)
  if (source === 'sns-topic') return target === 'aws-lambda' || target === 'sqs-queue'
  if (source === 'aws-lambda') return DATA_SERVICES.has(target) || target === 'sqs-queue' || target === 'sns-topic'
  return false
}

function namesRelated(queueName: string, dlqName: string): boolean {
  const queue = fold(queueName).replace(/[^a-z0-9]/g, '')
  const dlq = fold(dlqName).replace(/[^a-z0-9]/g, '')
  return dlq.startsWith(queue) || queue.startsWith(dlq.replace(/dlq$/, ''))
}

function rateUnit(word: string): 'minutes' | 'hours' | 'days' {
  const folded = fold(word)
  if (folded.startsWith('h')) return 'hours'
  if (folded.startsWith('d')) return 'days'
  return 'minutes'
}

function normalizePath(path: string): string {
  const trimmed = path.trim()
  if (!trimmed || trimmed === '/') return '/'
  return (trimmed.startsWith('/') ? trimmed : `/${trimmed}`).replace(/\/{2,}/g, '/')
}

function hasWord(text: string, words: string[]): boolean {
  return words.some((word) => new RegExp(`\\b${word}\\b`).test(text))
}

function rangesOverlap(start: number, end: number, otherStart: number, otherEnd: number): boolean {
  return start < otherEnd && otherStart < end
}

function fold(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
