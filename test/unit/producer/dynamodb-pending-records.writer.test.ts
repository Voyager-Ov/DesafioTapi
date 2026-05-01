import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDbPendingRecordsWriter } from '../../../src/functions/producer/adapters/dynamodb-pending-records.writer';
import { PendingRecordWriteInput } from '../../../src/shared/types';

function makeRecord(overrides: Partial<PendingRecordWriteInput> = {}): PendingRecordWriteInput {
  return {
    recordId: 'rec-301',
    providerId: 'prov-X',
    endpoint: 'https://api.example.com/provider',
    httpMethod: 'POST',
    payload: { ok: true },
    headers: { authorization: 'Bearer token' },
    scheduledDate: '2026-05-01',
    status: 'PENDING',
    ttl: 1_800_000_000,
    ...overrides,
  };
}

describe('DynamoDbPendingRecordsWriter', () => {
  it('builds pending records with productive dispatch-slot routing metadata', () => {
    const writer = new DynamoDbPendingRecordsWriter('tapi-pending-records');

    const item = writer.buildItem(makeRecord());

    expect(item.PK).toBe('DATE#2026-05-01');
    expect(item.SK).toBe('RECORD#rec-301');
    expect(item.dispatchDate).toBe('2026-05-01');
    expect(item.dispatchSlotPk).toMatch(/^DATE#2026-05-01#SLOT#\d{3}$/);
    expect(item.dispatchSortKey).toBe('PROVIDER#prov-X#RECORD#rec-301');
  });

  it('persists the materialized dispatch-slot metadata to DynamoDB', async () => {
    const send = jest.fn().mockResolvedValue({});
    const docClient = { send } as unknown as DynamoDBDocumentClient;
    const writer = new DynamoDbPendingRecordsWriter('tapi-pending-records', undefined, undefined, docClient);

    const saved = await writer.put(makeRecord());

    expect(saved.dispatchSlotPk).toMatch(/^DATE#2026-05-01#SLOT#\d{3}$/);
    expect(send).toHaveBeenCalledTimes(1);

    const command = send.mock.calls[0][0] as PutCommand;
    expect(command.input).toMatchObject({
      TableName: 'tapi-pending-records',
      Item: expect.objectContaining({
        PK: 'DATE#2026-05-01',
        SK: 'RECORD#rec-301',
        dispatchSortKey: 'PROVIDER#prov-X#RECORD#rec-301',
      }),
    });
  });
});
