import * as path from 'path'
import * as cdk from 'aws-cdk-lib/core'
import * as apigateway from 'aws-cdk-lib/aws-apigateway'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as logs from 'aws-cdk-lib/aws-logs'
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs'
import * as cr from 'aws-cdk-lib/custom-resources'
import { Construct } from 'constructs'

const TOKEN_PARAMETER_NAME = '/archcode-mcp/bearer-token'

export class ArchcodeMcpStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, {
      ...props,
      description: props?.description ?? 'MCP server that builds Archcode serverless diagrams.',
    })

    const parameterArn = this.formatArn({
      service: 'ssm',
      resource: 'parameter',
      resourceName: TOKEN_PARAMETER_NAME.replace(/^\//, ''),
    })
    const kmsViaSsm = new iam.PolicyStatement({
      actions: ['kms:Decrypt', 'kms:Encrypt', 'kms:GenerateDataKey'],
      resources: ['*'],
      conditions: {
        StringEquals: { 'kms:ViaService': `ssm.${this.region}.amazonaws.com` },
      },
    })

    const tokenFunction = new NodejsFunction(this, 'TokenParameterFunction', {
      entry: path.join(__dirname, '../src/token-parameter.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(30),
      description: 'Creates the MCP token SecureString once.',
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'node22',
      },
    })
    tokenFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:PutParameter', 'ssm:DeleteParameter'],
      resources: [parameterArn],
    }))
    tokenFunction.addToRolePolicy(kmsViaSsm)

    const provider = new cr.Provider(this, 'TokenParameterProvider', {
      onEventHandler: tokenFunction,
      logGroup: new logs.LogGroup(this, 'TokenParameterLogs', {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    })
    const token = new cdk.CustomResource(this, 'McpBearerToken', {
      serviceToken: provider.serviceToken,
      properties: { ParameterName: TOKEN_PARAMETER_NAME },
    })

    const logGroup = new logs.LogGroup(this, 'McpLogs', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    })
    const mcp = new NodejsFunction(this, 'McpFunction', {
      entry: path.join(__dirname, '../src/handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      memorySize: 256,
      timeout: cdk.Duration.seconds(10),
      logGroup,
      description: 'Stateless MCP server that builds diagram.archcode from text.',
      environment: {
        MCP_TOKEN_PARAMETER_NAME: TOKEN_PARAMETER_NAME,
      },
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'node22',
      },
    })
    mcp.node.addDependency(token)
    mcp.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [parameterArn],
    }))
    mcp.addToRolePolicy(new iam.PolicyStatement({
      actions: ['kms:Decrypt'],
      resources: ['*'],
      conditions: {
        StringEquals: { 'kms:ViaService': `ssm.${this.region}.amazonaws.com` },
      },
    }))

    const integration = new apigateway.LambdaIntegration(mcp)
    const api = new apigateway.RestApi(this, 'McpRestApi', {
      restApiName: 'archcode-mcp',
      description: 'REST endpoint of the Archcode MCP server.',
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
        allowHeaders: [
          'Authorization',
          'Content-Type',
          'Accept',
          'mcp-protocol-version',
          'mcp-session-id',
        ],
      },
    })
    const mcpResource = api.root.addResource('mcp')
    for (const method of ['POST', 'GET', 'DELETE']) {
      mcpResource.addMethod(method, integration)
    }
    api.root.addResource('health').addMethod('GET', integration)

    new cdk.CfnOutput(this, 'McpEndpoint', {
      value: `${api.url}mcp`,
      description: 'MCP server URL, including the prod stage. Use it as the client url with Authorization: Bearer <token>.',
    })
    new cdk.CfnOutput(this, 'TokenParameterName', {
      value: TOKEN_PARAMETER_NAME,
      description: 'Name of the SecureString that holds the bearer token. Read it with aws ssm get-parameter --with-decryption.',
    })
  }
}
