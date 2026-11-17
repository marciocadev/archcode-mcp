import { generateDiagram } from '../src/diagram/generate'

const ORDERS = 'REST API OrdersApi with POST /orders calls the Lambda OrdersHandler that writes to the DynamoDB table Orders.'
const UPLOAD = 'S3 bucket uploads sends a created event to the SQS queue Uploads with DLQ UploadsDlq. The Lambda ProcessUpload consumes the queue.'
const SCHEDULE = 'Every 1 hour the schedule HourlyWorker runs the Lambda HourlyWorker.'

test('builds a REST API with Lambda and DynamoDB from text', () => {
  const diagram = generateDiagram({ text: ORDERS, title: 'Orders API' })
  expect(diagram.document.version).toBe(1)
  expect(diagram.document.title).toBe('Orders API')
  expect(diagram.document.nodes.map((node) => node.type)).toEqual([
    'api-gateway-rest',
    'aws-lambda',
    'dynamodb-table',
  ])
  const api = diagram.document.nodes[0]!
  expect(api.data.apiGateway).toMatchObject({
    gatewayName: 'OrdersApi',
    routes: [{ verb: 'POST', path: '/orders' }],
  })
  expect(diagram.document.edges.map((edge) => edge.sourceHandle)).toEqual([
    'route:POST:/orders',
    'source',
  ])
  expect(diagram.document.edges[1]!.data.dynamodbGrant).toBe('read-write')
  expect(diagram.archcode.endsWith('\n')).toBe(true)
  expect(JSON.parse(diagram.archcode).version).toBe(1)
})

test('builds a bucket, queue, DLQ, and Lambda from text', () => {
  const diagram = generateDiagram({ text: UPLOAD })
  const byType = Object.fromEntries(diagram.document.nodes.map((node) => [node.type, node]))
  expect(byType['s3-bucket']!.data.s3Bucket).toMatchObject({
    bucketName: 'uploads',
    eventsEnabled: true,
    events: ['created'],
  })
  expect(byType['sqs-queue']!.data.sqsQueue).toMatchObject({
    queueName: 'Uploads',
    useDeadLetterQueue: true,
  })
  expect(byType['sqs-dlq']!.data.sqsQueue).toMatchObject({
    queueName: 'UploadsDlq',
    useDeadLetterQueue: false,
  })
  const event = diagram.document.edges.find((edge) => edge.sourceHandle === 'event')
  const dlq = diagram.document.edges.find((edge) => edge.sourceHandle === 'dlq')
  const worker = diagram.document.edges.find((edge) => edge.sourceHandle === 'source')
  expect(event?.data.s3Event).toBe('created')
  expect(dlq?.data.maxReceiveCount).toBe(5)
  expect(worker?.data.batchSize).toBe(10)
  expect(byType['s3-bucket']!.position).toEqual({ x: 80, y: 80 })
  expect(byType['sqs-queue']!.position).toEqual({ x: 480, y: 80 })
  expect(byType['sqs-dlq']!.position).toEqual({ x: 880, y: 80 })
  expect(byType['aws-lambda']!.position).toEqual({ x: 880, y: 236 })
})

test('builds a worker scheduled every hour', () => {
  const diagram = generateDiagram({ text: SCHEDULE })
  const schedule = diagram.document.nodes.find((node) => node.type === 'eventbridge-scheduler')
  const lambda = diagram.document.nodes.find((node) => node.type === 'aws-lambda')
  expect(schedule?.data.eventBridge).toMatchObject({
    ruleName: 'HourlyWorker',
    scheduleKind: 'rate',
    rateValue: 1,
    rateUnit: 'hours',
    schedule: 'rate(1 hour)',
  })
  expect(diagram.document.edges).toEqual([
    expect.objectContaining({
      source: schedule?.id,
      target: lambda?.id,
      sourceHandle: 'source',
    }),
  ])
})

test('accepts a structured spec with two routes', () => {
  const diagram = generateDiagram({
    text: 'API de pedidos',
    title: 'Pedidos',
    resources: [
      {
        id: 'api',
        service: 'api-gateway-rest',
        name: 'OrdersApi',
        routes: [
          { verb: 'POST', path: '/orders' },
          { verb: 'GET', path: '/orders' },
        ],
      },
      { id: 'create', service: 'aws-lambda', name: 'CreateOrder', language: 'python' },
      { id: 'read', service: 'aws-lambda', name: 'GetOrder' },
    ],
    connections: [
      { from: 'api', to: 'create', via: 'POST /orders' },
      { from: 'api', to: 'read', via: 'GET /orders' },
    ],
  })
  const create = diagram.document.nodes.find((node) => node.type === 'aws-lambda' && (node.data.lambda as { functionName: string }).functionName === 'CreateOrder')
  expect((create?.data.lambda as { runtime: string }).runtime).toBe('python3.14')
  expect(diagram.document.edges.map((edge) => edge.sourceHandle).sort()).toEqual([
    'route:GET:/orders',
    'route:POST:/orders',
  ])
})

test('connects a queue to a Lambda through the source output when no name is given', () => {
  const diagram = generateDiagram({ text: 'an sqs connected to a lambda' })
  expect(diagram.document.nodes.map((node) => node.type).sort()).toEqual(['aws-lambda', 'sqs-queue'])
  expect(diagram.document.edges).toEqual([
    expect.objectContaining({ sourceHandle: 'source' }),
  ])
  expect(diagram.document.edges[0]!.data.batchSize).toBe(10)
  expect(diagram.document.edges.some((edge) => edge.sourceHandle === 'dlq')).toBe(false)
  const queue = diagram.document.nodes.find((node) => node.type === 'sqs-queue')
  expect(queue?.data.sqsQueue).toMatchObject({ useDeadLetterQueue: false })
})

test('does not use the dlq output when the target is a Lambda', () => {
  const diagram = generateDiagram({
    text: 'queue and function',
    resources: [
      { id: 'queue', service: 'sqs-queue', name: 'Orders' },
      { id: 'worker', service: 'aws-lambda', name: 'Worker' },
    ],
    connections: [{ from: 'queue', to: 'worker', via: 'dlq' }],
  })
  expect(diagram.document.edges).toEqual([
    expect.objectContaining({ sourceHandle: 'source' }),
  ])
  expect(diagram.document.edges[0]!.data).toMatchObject({ batchSize: 10 })
  expect(diagram.document.edges[0]!.data.maxReceiveCount).toBeUndefined()
  expect(diagram.warnings.some((warning) => warning.includes('dlq') && warning.includes('"source"'))).toBe(true)
})

test('reserves the dlq output for the dead-letter queue', () => {
  const diagram = generateDiagram({
    text: 'queue with dlq',
    resources: [
      { id: 'queue', service: 'sqs-queue', name: 'Orders' },
      { id: 'dead', service: 'sqs-dlq', name: 'OrdersDlq' },
      { id: 'worker', service: 'aws-lambda', name: 'Worker' },
    ],
    connections: [
      { from: 'queue', to: 'worker' },
      { from: 'queue', to: 'dead' },
    ],
  })
  const byHandle = Object.fromEntries(diagram.document.edges.map((edge) => [edge.sourceHandle, edge]))
  expect(byHandle.source!.data.batchSize).toBe(10)
  expect(byHandle.dlq!.data.maxReceiveCount).toBe(5)
  const queue = diagram.document.nodes.find((node) => node.type === 'sqs-queue')
  expect(queue?.data.sqsQueue).toMatchObject({ useDeadLetterQueue: true })
})

test('picks stream, event, and route from the target', () => {
  const diagram = generateDiagram({
    text: 'stream and event',
    resources: [
      { id: 'table', service: 'dynamodb-table', name: 'Orders' },
      { id: 'bucket', service: 's3-bucket', name: 'uploads' },
      { id: 'worker', service: 'aws-lambda', name: 'Worker' },
    ],
    connections: [
      { from: 'table', to: 'worker' },
      { from: 'bucket', to: 'worker', via: 'removed' },
    ],
  })
  const stream = diagram.document.edges.find((edge) => edge.sourceHandle === 'stream')
  const event = diagram.document.edges.find((edge) => edge.sourceHandle === 'event')
  expect(stream?.data.dynamodbStreamEvents).toEqual(['INSERT', 'MODIFY', 'REMOVE'])
  expect(event?.data.s3Event).toBe('removed')
  const table = diagram.document.nodes.find((node) => node.type === 'dynamodb-table')
  const bucket = diagram.document.nodes.find((node) => node.type === 's3-bucket')
  expect(table?.data.dynamodbTable).toMatchObject({
    stream: 'new',
    streamEvents: ['INSERT', 'MODIFY', 'REMOVE'],
  })
  expect(bucket?.data.s3Bucket).toMatchObject({ eventsEnabled: true, events: ['removed'] })
})

test('stores a one-time schedule in the canvas format', () => {
  const diagram = generateDiagram({
    text: 'one-time schedule',
    resources: [
      { id: 'clock', service: 'eventbridge-scheduler', name: 'Once', scheduleKind: 'once', onceAt: '2026-11-17T08:00' },
      { id: 'worker', service: 'aws-lambda', name: 'Worker' },
    ],
    connections: [{ from: 'clock', to: 'worker' }],
  })
  expect(diagram.document.nodes[0]?.data.eventBridge).toMatchObject({
    scheduleKind: 'once',
    onceAt: '2026-11-17T08:00',
    schedule: 'at(2026-11-17T08:00:00)',
  })
})

test('rejects a connection the canvas does not allow', () => {
  expect(() => generateDiagram({
    text: 'bucket to table',
    resources: [
      { id: 'bucket', service: 's3-bucket', name: 'uploads' },
      { id: 'table', service: 'dynamodb-table', name: 'Orders' },
    ],
    connections: [{ from: 'bucket', to: 'table' }],
  })).toThrow(/event →/)
})

test('a queue accepts a single Lambda on the source output', () => {
  expect(() => generateDiagram({
    text: 'two lambdas',
    resources: [
      { id: 'queue', service: 'sqs-queue', name: 'Orders' },
      { id: 'first', service: 'aws-lambda', name: 'First' },
      { id: 'second', service: 'aws-lambda', name: 'Second' },
    ],
    connections: [
      { from: 'queue', to: 'first' },
      { from: 'queue', to: 'second' },
    ],
  })).toThrow(/source output/)
})

test('does not store a secret value in the diagram', () => {
  const diagram = generateDiagram({
    text: 'The Lambda App reads the secret DbPassword with json key password and value hunter2.',
  })
  const secret = diagram.document.nodes.find((node) => node.type === 'secrets-manager')
  expect(secret?.data.secretsManager).toEqual({
    secretName: 'DbPassword',
    jsonKey: 'password',
    ownership: 'reference',
  })
  expect(diagram.archcode).not.toContain('hunter2')
  expect(diagram.archcode).not.toContain('secretString')
})
