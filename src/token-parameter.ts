import { randomBytes } from 'node:crypto'
import {
  DeleteParameterCommand,
  PutParameterCommand,
  SSMClient,
} from '@aws-sdk/client-ssm'

type TokenParameterEvent = {
  RequestType: 'Create' | 'Update' | 'Delete'
  PhysicalResourceId?: string
  ResourceProperties?: { ParameterName?: string }
}

const client = new SSMClient({})

export async function handler(event: TokenParameterEvent): Promise<{ PhysicalResourceId?: string }> {
  const name = event.ResourceProperties?.ParameterName
  if (event.RequestType === 'Create') {
    if (!name) throw new Error('ParameterName is required.')
    await createParameter(name)
    return { PhysicalResourceId: name }
  }
  if (event.RequestType === 'Update') {
    return { PhysicalResourceId: event.PhysicalResourceId ?? name }
  }
  await deleteParameter(event.PhysicalResourceId)
  return { PhysicalResourceId: event.PhysicalResourceId }
}

async function createParameter(name: string): Promise<void> {
  try {
    await client.send(new PutParameterCommand({
      Name: name,
      Description: 'Bearer token for the Archcode MCP endpoint.',
      Value: randomBytes(32).toString('hex'),
      Type: 'SecureString',
      Overwrite: false,
    }))
  } catch (error) {
    if (errorName(error) !== 'ParameterAlreadyExists') throw error
  }
}

async function deleteParameter(physicalId: string | undefined): Promise<void> {
  if (!physicalId?.startsWith('/')) return
  try {
    await client.send(new DeleteParameterCommand({ Name: physicalId }))
  } catch (error) {
    if (errorName(error) !== 'ParameterNotFound') throw error
  }
}

function errorName(error: unknown): string {
  if (!error || typeof error !== 'object' || !('name' in error)) return ''
  return String(error.name)
}
