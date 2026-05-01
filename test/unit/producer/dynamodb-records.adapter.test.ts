const sendMock = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(),
}));

jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: {
    from: jest.fn(() => ({
      send: sendMock,
    })),
  },
  QueryCommand: class QueryCommand {
    public readonly input: unknown;

    constructor(input: unknown) {
      this.input = input;
    }
  },
}));

import { DynamoDbRecordsAdapter } from '../../../src/functions/producer/adapters/dynamodb-records.adapter';
import { buildDispatchSlotMetadata, DEFAULT_DISPATCH_SLOTS_PER_DAY } from '../../../src/functions/producer/domain/dispatch-slot-routing';
import { PendingDispatchRecord, ProviderRecord } from '../../../src/shared/types';

function makeRecord(overrides: Partial<ProviderRecord> = {}): PendingDispatchRecord {
  const baseRecord: ProviderRecord = {
    recordId: 'rec-201',
    providerId: 'prov-A',
    endpoint: 'https://httpbin.org/status/200',
    httpMethod: 'GET',
    scheduledDate: '2026-04-30',
    status: 'PENDING',
    ...overrides,
  };

  return {
    ...baseRecord,
    ...buildDispatchSlotMetadata(baseRecord, DEFAULT_DISPATCH_SLOTS_PER_DAY),
  };
}

describe('DynamoDbRecordsAdapter', () => {
  beforeEach(() => {
    sendMock.mockReset();
  });

  it('queries only one dispatch-slot partition through the dispatch-slot-index', async () => {
    const adapter = new DynamoDbRecordsAdapter('tapi-pending-records');
    const record = makeRecord({ recordId: 'rec-203', providerId: 'prov-B' });

    sendMock.mockResolvedValueOnce({
      Items: [record],
    });

    const result = await adapter.getPendingRecordsForSlot({
      targetDate: '2026-04-30',
      slotId: 17,
      slotsPerDay: DEFAULT_DISPATCH_SLOTS_PER_DAY,
    });

    expect(result).toEqual([record]);
    expect(sendMock).toHaveBeenCalledTimes(1);

    const firstCommand = sendMock.mock.calls[0][0] as { input: Record<string, unknown> };
    expect(firstCommand.input).toMatchObject({
      TableName: 'tapi-pending-records',
      IndexName: 'dispatch-slot-index',
      KeyConditionExpression: 'dispatchSlotPk = :dispatchSlotPk',
      ExpressionAttributeValues: {
        ':dispatchSlotPk': 'DATE#2026-04-30#SLOT#017',
      },
    });
    expect(firstCommand.input).not.toHaveProperty('FilterExpression');
    expect(firstCommand.input).not.toHaveProperty('ScanIndexForward');
  });

  it('paginates until the slot partition is fully drained', async () => {
    const adapter = new DynamoDbRecordsAdapter('tapi-pending-records');
    const firstRecord = makeRecord({ recordId: 'rec-201', providerId: 'prov-A' });
    const secondRecord = makeRecord({ recordId: 'rec-202', providerId: 'prov-A' });

    sendMock
      .mockResolvedValueOnce({
        Items: [firstRecord],
        LastEvaluatedKey: { PK: 'DATE#2026-04-30', SK: 'RECORD#rec-201' },
      })
      .mockResolvedValueOnce({
        Items: [secondRecord],
      });

    const result = await adapter.getPendingRecordsForSlot({
      targetDate: '2026-04-30',
      slotId: 149,
      slotsPerDay: DEFAULT_DISPATCH_SLOTS_PER_DAY,
    });

    expect(result).toEqual([firstRecord, secondRecord]);
    expect(sendMock).toHaveBeenCalledTimes(2);

    const secondCommand = sendMock.mock.calls[1][0] as { input: Record<string, unknown> };
    expect(secondCommand.input).toMatchObject({
      TableName: 'tapi-pending-records',
      IndexName: 'dispatch-slot-index',
      ExclusiveStartKey: { PK: 'DATE#2026-04-30', SK: 'RECORD#rec-201' },
    });
  });
});
