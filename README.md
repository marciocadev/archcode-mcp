# Archcode MCP

MCP server that builds Archcode diagrams from text. The result is a `diagram.archcode` file (JSON version 1) ready to open on the serverless canvas.

The server runs as a Lambda function behind a REST API and speaks the MCP Streamable HTTP transport. Generation is local: the Lambda checks the services and connections the canvas accepts and returns the file. It does not call a model.

## Tools

- `list_services` — canvas services and the connections they allow (Lambda, DynamoDB, API Gateway REST, EventBridge, SQS, DLQ, SNS, S3, SSM Parameter, and Secrets Manager).
- `generate_diagram` — takes the architecture text. The client can also send `resources` and `connections` to fix names, routes, schedules, and links. A connection Archcode cannot draw is rejected.

A secret value is not stored in the diagram. Only the name and, when present, the `jsonKey`.

## Deploy

Deploy changes the AWS account configured in the CLI. Run it when you want to publish:

```bash
npm install
npx cdk deploy
```

After deploy, the `McpEndpoint` and `TokenParameterName` outputs appear in the terminal. The URL includes the `prod` stage. The token is a Parameter Store SecureString, created once and read by the function:

```bash
aws ssm get-parameter \
  --name <TokenParameterName> \
  --with-decryption \
  --query Parameter.Value \
  --output text
```

`npx cdk diff` compares the stack with what is already published. `npx cdk destroy` removes the stack, including the parameter and the logs.

## Client

In Cursor, under MCP, add a remote server:

```json
{
  "mcpServers": {
    "archcode": {
      "url": "https://<api-id>.execute-api.<region>.amazonaws.com/prod/mcp",
      "headers": {
        "Authorization": "Bearer <token>"
      }
    }
  }
}
```

Ask for the diagram in text. Save the returned JSON, unchanged, as `diagram.archcode` in the Archcode project folder.

`GET /health` returns `{ "status": "ok" }` and does not use the token. `POST /mcp` requires `Authorization: Bearer`.

## Development

```bash
npm install
npm test
npm run build
npx cdk synth
```

`npm test` covers text parsing, the diagram JSON, the MCP protocol, and the stack. `npm run build` only type-checks.
