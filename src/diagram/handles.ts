import { serviceDefinition } from './catalog'
import { HTTP_VERBS, type HttpVerb, type RouteInput, type ServiceName } from './types'

export type HandleChoice = {
  handle: string
  s3Event?: 'created' | 'removed'
  singleTarget: boolean
}

export type HandleResolution =
  | { ok: true; choice: HandleChoice; warning?: string }
  | { ok: false; message: string }

/**
 * Picks the source output the catalog allows to reach the target.
 * `dlq` only reaches a DLQ, a queue `source` only reaches a Lambda,
 * `stream` leaves a table, `event` leaves a bucket, and each route leaves the API.
 */
export function resolveConnectionHandle(input: {
  source: ServiceName
  sourceName: string
  target: ServiceName
  targetName: string
  via?: string
  s3Event?: 'created' | 'removed'
  routes?: RouteInput[]
}): HandleResolution {
  const choices = handlesBetween(input.source, input.target, input.routes)
  if (choices.length === 0) {
    return {
      ok: false,
      message: `${input.sourceName} cannot connect to ${input.targetName}. ${describeHandles(input.source)}`,
    }
  }

  const requested = interpretVia(input.via, input.s3Event)
  if (requested.kind === 'choice') {
    const match = choices.find((choice) => choice.handle === requested.handle)
    if (match) return { ok: true, choice: applyEvent(match, requested.s3Event) }
  }

  const unique = uniqueChoice(choices)
  if (requested.kind === 'omitted' && unique) return { ok: true, choice: unique }
  if (requested.kind !== 'omitted' && unique) {
    const via = requested.kind === 'unknown' ? requested.via : requested.handle
    return {
      ok: true,
      choice: applyEvent(unique, requested.kind === 'choice' ? requested.s3Event : undefined),
      warning: `The "${via}" output of ${input.sourceName} does not reach ${input.targetName}. The connection uses "${unique.handle}". ${describeHandles(input.source)}`,
    }
  }

  const via = requested.kind === 'omitted' ? '' : requested.kind === 'unknown' ? requested.via : requested.handle
  const options = choices.map((choice) => choice.handle).join(', ')
  const prefix = via
    ? `The "${via}" output of ${input.sourceName} does not reach ${input.targetName}.`
    : `${input.sourceName} has more than one output that reaches ${input.targetName}.`
  return { ok: false, message: `${prefix} Choose one: ${options}. ${describeHandles(input.source)}` }
}

export function describeHandles(service: ServiceName): string {
  const definition = serviceDefinition(service)
  if (definition.handles.length === 0) return `${definition.label} does not start connections.`
  const lines = definition.handles.map((handle) => {
    const targets = handle.targets.map((target) => serviceDefinition(target).label).join(', ')
    return `${handle.id} → ${targets}`
  })
  return `${definition.label} connects through: ${lines.join('; ')}.`
}

function handlesBetween(source: ServiceName, target: ServiceName, routes: RouteInput[] | undefined): HandleChoice[] {
  const definition = serviceDefinition(source)
  const receiver = serviceDefinition(target)
  if (!receiver.canReceiveFrom.includes(source)) return []
  const choices: HandleChoice[] = []
  for (const handle of definition.handles) {
    if (!handle.targets.includes(target)) continue
    if (handle.id.startsWith('route:')) {
      for (const route of routes ?? []) {
        choices.push({ handle: `route:${route.verb}:${route.path}`, singleTarget: true })
      }
      continue
    }
    choices.push({
      handle: handle.id,
      s3Event: handle.id === 'event' ? 'created' : undefined,
      singleTarget: Boolean(handle.singleTarget),
    })
  }
  return choices
}

function uniqueChoice(choices: HandleChoice[]): HandleChoice | undefined {
  const ids = new Set(choices.map((choice) => choice.handle))
  if (ids.size !== 1) return undefined
  return choices[0]
}

function applyEvent(choice: HandleChoice, s3Event: 'created' | 'removed' | undefined): HandleChoice {
  if (choice.handle !== 'event') return choice
  return { ...choice, s3Event: s3Event ?? choice.s3Event ?? 'created' }
}

type ViaRequest =
  | { kind: 'omitted' }
  | { kind: 'choice'; handle: string; s3Event?: 'created' | 'removed' }
  | { kind: 'unknown'; via: string }

function interpretVia(via: string | undefined, s3Event: 'created' | 'removed' | undefined): ViaRequest {
  const value = via?.trim() ?? ''
  if (!value) {
    if (s3Event) return { kind: 'choice', handle: 'event', s3Event }
    return { kind: 'omitted' }
  }
  const folded = value.toLowerCase()
  if (folded === 'source') return { kind: 'choice', handle: 'source' }
  if (folded === 'dlq') return { kind: 'choice', handle: 'dlq' }
  if (folded === 'stream') return { kind: 'choice', handle: 'stream' }
  if (folded === 'event') return { kind: 'choice', handle: 'event', s3Event: s3Event ?? 'created' }
  if (folded === 'created' || folded === 'criado') return { kind: 'choice', handle: 'event', s3Event: 'created' }
  if (folded === 'removed' || folded === 'removido') return { kind: 'choice', handle: 'event', s3Event: 'removed' }
  const route = parseRoute(value)
  if (route) return { kind: 'choice', handle: `route:${route.verb}:${route.path}` }
  return { kind: 'unknown', via: value }
}

function parseRoute(via: string): RouteInput | undefined {
  const match = /^(?:route:)?(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|ANY)\s*:?\s*(\/\S*)$/i.exec(via.trim())
  if (!match || !HTTP_VERBS.includes(match[1]!.toUpperCase() as HttpVerb)) return undefined
  const path = normalizePath(match[2]!)
  return { verb: match[1]!.toUpperCase() as HttpVerb, path }
}

function normalizePath(path: string): string {
  const trimmed = path.trim()
  if (!trimmed || trimmed === '/') return '/'
  return (trimmed.startsWith('/') ? trimmed : `/${trimmed}`).replace(/\/{2,}/g, '/')
}
