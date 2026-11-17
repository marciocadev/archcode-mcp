import { handleRequest, handler } from '../src/handler'

const TOKEN = 'test-token'

function post(body: unknown, token = TOKEN, accept = 'application/json, text/event-stream') {
  return handleRequest({
    method: 'POST',
    path: '/mcp',
    headers: {
      authorization: `Bearer ${token}`,
      accept,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  }, { authToken: TOKEN })
}

test('health does not require a token', () => {
  const response = handleRequest({
    method: 'GET',
    path: '/health',
    headers: {},
  }, { authToken: TOKEN })
  expect(response.statusCode).toBe(200)
  expect(JSON.parse(response.body)).toMatchObject({ status: 'ok' })
})

test('rejects a call without the token', () => {
  const response = post({ jsonrpc: '2.0', id: 1, method: 'ping' }, 'wrong')
  expect(response.statusCode).toBe(401)
})

test('initialize, tools/list e generate_diagram', () => {
  const initialized = post({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
  })
  expect(JSON.parse(initialized.body).result.serverInfo).toEqual({ name: 'archcode', version: '0.1.0' })

  const notification = handleRequest({
    method: 'POST',
    path: '/mcp',
    headers: { authorization: `Bearer ${TOKEN}`, accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  }, { authToken: TOKEN })
  expect(notification.statusCode).toBe(202)

  const tools = post({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  const names = JSON.parse(tools.body).result.tools.map((tool: { name: string }) => tool.name)
  expect(names).toEqual(['list_services', 'generate_diagram'])

  const generated = post({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'generate_diagram',
      arguments: { text: 'Every 1 hour the schedule HourlyWorker runs the Lambda HourlyWorker.', title: 'Schedule' },
    },
  })
  const payload = JSON.parse(generated.body).result
  expect(payload.isError).toBe(false)
  expect(payload.content[0].text).toContain('"version": 1')
  expect(payload.content[1].resource.mimeType).toBe('application/json')
  expect(JSON.parse(payload.content[1].resource.text).title).toBe('Schedule')
})

test('the handler accepts the REST API event', async () => {
  process.env.MCP_AUTH_TOKEN = TOKEN
  const response = await handler({
    path: '/mcp',
    httpMethod: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    isBase64Encoded: false,
  })
  expect(response.statusCode).toBe(200)
  expect(JSON.parse(response.body).result).toEqual({})
})

test('the Lambda handler reads the API Gateway event', async () => {
  process.env.MCP_AUTH_TOKEN = TOKEN
  const response = await handler({
    rawPath: '/mcp',
    headers: { authorization: `Bearer ${TOKEN}`, accept: 'application/json' },
    isBase64Encoded: false,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    requestContext: { http: { method: 'POST', path: '/mcp' } },
  })
  expect(response.statusCode).toBe(200)
  expect(JSON.parse(response.body).result).toEqual({})
})
