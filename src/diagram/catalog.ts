import type { ServiceName } from './types'

/**
 * Connection rules of the Archcode canvas.
 * Each handle lists the services it can reach. The `dlq` output only reaches a DLQ;
 * a queue's `source` output only reaches a Lambda.
 */
export type ServiceDefinition = {
  service: ServiceName
  label: string
  summary: string
  canConnectTo: ServiceName[]
  canReceiveFrom: ServiceName[]
  handles: Array<{
    id: string
    targets: ServiceName[]
    singleTarget?: boolean
    optional?: boolean
    note: string
  }>
}

export const SERVICE_CATALOG: ServiceDefinition[] = [
  {
    service: 'aws-lambda',
    label: 'Lambda Function',
    summary: 'Function that processes events and accesses the other resources.',
    canConnectTo: ['sns-topic', 'sqs-queue', 'api-gateway-rest', 'dynamodb-table', 's3-bucket', 'ssm-parameter', 'secrets-manager'],
    canReceiveFrom: ['sns-topic', 'sqs-queue', 'api-gateway-rest', 's3-bucket', 'dynamodb-table', 'eventbridge-scheduler', 'eventbridge-event'],
    handles: [{ id: 'source', targets: ['sns-topic', 'sqs-queue', 'api-gateway-rest', 'dynamodb-table', 's3-bucket', 'ssm-parameter', 'secrets-manager'], note: 'Default output of the function.' }],
  },
  {
    service: 'dynamodb-table',
    label: 'DynamoDB Table',
    summary: 'Table. The stream exists only when stream is not none.',
    canConnectTo: ['aws-lambda'],
    canReceiveFrom: ['aws-lambda'],
    handles: [{ id: 'stream', targets: ['aws-lambda'], singleTarget: true, optional: true, note: 'Shown when the table stream is enabled. Event types are stored on the table.' }],
  },
  {
    service: 'api-gateway-rest',
    label: 'API Gateway REST',
    summary: 'Each HTTP route connects to a single Lambda. via example: POST /orders.',
    canConnectTo: ['aws-lambda'],
    canReceiveFrom: ['aws-lambda'],
    handles: [{ id: 'route:{METHOD}:{path}', targets: ['aws-lambda'], singleTarget: true, note: 'One output per route.' }],
  },
  {
    service: 'eventbridge-event',
    label: 'EventBridge Event',
    summary: 'Event rule. It needs eventSources or detailTypes, and a target.',
    canConnectTo: ['aws-lambda', 'sqs-queue', 'sns-topic'],
    canReceiveFrom: [],
    handles: [{ id: 'source', targets: ['aws-lambda', 'sqs-queue', 'sns-topic'], note: 'Target of the rule.' }],
  },
  {
    service: 'eventbridge-scheduler',
    label: 'EventBridge Scheduler',
    summary: 'Schedule as a rate, a cron, or a single time. It needs a target.',
    canConnectTo: ['aws-lambda', 'sqs-queue', 'sns-topic'],
    canReceiveFrom: [],
    handles: [{ id: 'source', targets: ['aws-lambda', 'sqs-queue', 'sns-topic'], note: 'Target of the schedule.' }],
  },
  {
    service: 'sqs-queue',
    label: 'SQS Queue',
    summary: 'The default output accepts a single target. The dead-letter queue leaves through the dlq handle.',
    canConnectTo: ['aws-lambda', 'sqs-dlq'],
    canReceiveFrom: ['aws-lambda', 'sns-topic', 's3-bucket', 'eventbridge-scheduler', 'eventbridge-event'],
    handles: [
      { id: 'source', targets: ['aws-lambda'], singleTarget: true, note: 'Consumer of the queue.' },
      { id: 'dlq', targets: ['sqs-dlq'], singleTarget: true, optional: true, note: 'Shown when the queue uses a dead-letter queue.' },
    ],
  },
  {
    service: 'sqs-dlq',
    label: 'SQS Dead Letter Queue',
    summary: 'Only receives the dlq output of a queue.',
    canConnectTo: [],
    canReceiveFrom: ['sqs-queue'],
    handles: [],
  },
  {
    service: 'sns-topic',
    label: 'SNS Topic',
    summary: 'Publishes to Lambdas and queues.',
    canConnectTo: ['aws-lambda', 'sqs-queue'],
    canReceiveFrom: ['aws-lambda', 's3-bucket', 'eventbridge-scheduler', 'eventbridge-event'],
    handles: [{ id: 'source', targets: ['aws-lambda', 'sqs-queue'], note: 'Subscribers of the topic.' }],
  },
  {
    service: 's3-bucket',
    label: 'S3 Bucket',
    summary: 'Object events are stored on the bucket. The event output appears only when they are enabled and reaches a Lambda, a queue, or a topic. A Lambda can also access the bucket.',
    canConnectTo: ['aws-lambda', 'sns-topic', 'sqs-queue'],
    canReceiveFrom: ['aws-lambda'],
    handles: [{ id: 'event', targets: ['aws-lambda', 'sns-topic', 'sqs-queue'], optional: true, note: 'Shown when the bucket has events. via: created or removed.' }],
  },
  {
    service: 'ssm-parameter',
    label: 'SSM Parameter',
    summary: 'Parameter read by a Lambda. The value is not stored in the diagram. ownership is reference or create.',
    canConnectTo: [],
    canReceiveFrom: ['aws-lambda'],
    handles: [],
  },
  {
    service: 'secrets-manager',
    label: 'Secrets Manager',
    summary: 'Secret read by a Lambda. Only the name and the optional jsonKey. The value is never stored in the diagram.',
    canConnectTo: [],
    canReceiveFrom: ['aws-lambda'],
    handles: [],
  },
]

const BY_SERVICE = new Map(SERVICE_CATALOG.map((item) => [item.service, item]))

export function serviceDefinition(service: ServiceName): ServiceDefinition {
  const found = BY_SERVICE.get(service)
  if (!found) throw new Error(`Unknown service: ${service}`)
  return found
}

export function isServiceName(value: string): value is ServiceName {
  return BY_SERVICE.has(value as ServiceName)
}
