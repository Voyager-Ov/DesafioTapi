import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDbResultRepository } from '../../../src/functions/consumer/adapters/dynamodb-result.repository';
import { ProviderApiResult, ProviderRecord } from '../../../src/shared/types';

function makeRecord(overrides: Partial<ProviderRecord> = {}): ProviderRecord {
  return {
    recordId: 'rec-001',
    providerId: 'prov-A',
    endpoint: 'https://api.example.com/resource',
    httpMethod: 'GET',
    scheduledDate: '2025-01-15',
    status: 'PENDING',
    ...overrides,
  };
}

function makeResult(overrides: Partial<ProviderApiResult> = {}): ProviderApiResult {
  return {
    recordId: 'rec-001',
    providerId: 'prov-A',
    statusCode: 200,
    responseBody: '{"ok":true}',
    durationMs: 120,
    processedAt: '2025-01-15T10:00:00.000Z',
    ...overrides,
  };
}

describe('DynamoDbResultRepository', () => {
  it('persiste resultados exitosos en la tabla', async () => {
    const send = jest.fn().mockResolvedValue({});
    const docClient = { send } as unknown as DynamoDBDocumentClient;
    const repository = new DynamoDbResultRepository('results-table', undefined, docClient);

    await repository.save(makeResult());

    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0][0] as PutCommand;
    expect(command.input.TableName).toBe('results-table');
    expect(command.input.Item).toMatchObject({
      PK: 'PROVIDER#prov-A',
      recordId: 'rec-001',
      providerId: 'prov-A',
      statusCode: 200,
    });
  });

  it('persiste fallos terminales con metadata de error', async () => {
    const send = jest.fn().mockResolvedValue({});
    const docClient = { send } as unknown as DynamoDBDocumentClient;
    const repository = new DynamoDbResultRepository('results-table', undefined, docClient);

    await repository.saveFailure(makeRecord(), {
      statusCode: 401,
      message: 'Unauthorized',
    });

    const command = send.mock.calls[0][0] as PutCommand;
    expect(command.input.Item).toMatchObject({
      PK: 'PROVIDER#prov-A',
      recordId: 'rec-001',
      providerId: 'prov-A',
      statusCode: 401,
      responseBody: '{"error":"Unauthorized","status":401}',
    });
  });
});
