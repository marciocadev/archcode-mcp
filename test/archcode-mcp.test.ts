import * as cdk from 'aws-cdk-lib/core'
import { Match, Template } from 'aws-cdk-lib/assertions'
import { ArchcodeMcpStack } from '../lib/archcode-mcp-stack'

test('publishes the MCP as a Lambda behind a REST API', () => {
  const app = new cdk.App()
  const stack = new ArchcodeMcpStack(app, 'TestStack')
  const template = Template.fromStack(stack)
  const json = JSON.stringify(template.toJSON())

  template.hasResourceProperties('AWS::Lambda::Function', {
    Runtime: 'nodejs22.x',
    Timeout: 10,
    MemorySize: 256,
    Handler: 'index.handler',
    Environment: {
      Variables: {
        MCP_TOKEN_PARAMETER_NAME: '/archcode-mcp/bearer-token',
      },
    },
  })
  template.hasResourceProperties('AWS::ApiGateway::RestApi', { Name: 'archcode-mcp' })
  template.hasResourceProperties('AWS::ApiGateway::Method', { HttpMethod: 'POST' })
  template.hasResourceProperties('AWS::ApiGateway::Method', { HttpMethod: 'GET' })
  template.hasResourceProperties('AWS::ApiGateway::Method', { HttpMethod: 'DELETE' })
  template.resourceCountIs('AWS::CloudFormation::CustomResource', 1)
  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({ Action: 'ssm:GetParameter' }),
      ]),
    },
  })
  template.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 7 })
  template.hasOutput('McpEndpoint', { Value: Match.anyValue() })
  template.hasOutput('TokenParameterName', { Value: '/archcode-mcp/bearer-token' })
  expect(json).not.toContain('MCP_AUTH_TOKEN')
  expect(json).not.toContain('AWS::SecretsManager::Secret')
  expect(json).not.toContain('AWS::ApiGatewayV2::Api')
})
