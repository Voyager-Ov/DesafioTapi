import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  QueryCommand,
  QueryCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { DispatchSlotQuery, IRecordRepositoryPort } from '../ports/out-ports';
import { PendingDispatchRecord } from '../../../shared/types';
import { formatDispatchSlotPk } from '../domain/dispatch-slot-routing';

// ---------------------------------------------------------------------------
// DynamoDbRecordsAdapter
//
// Secondary Adapter — reads ProviderRecord items from the
// `tapi-pending-records` DynamoDB table.
//
// Table access pattern used here:
//   GSI PK = DATE#<YYYY-MM-DD>#SLOT#<slot> → Query one dispatch slot partition
//   GSI SK = PROVIDER#<providerId>#RECORD#<recordId>
//
// Handles DynamoDB pagination automatically via the `LastEvaluatedKey` loop.
// ---------------------------------------------------------------------------
export class DynamoDbRecordsAdapter implements IRecordRepositoryPort {
  private readonly docClient: DynamoDBDocumentClient;

  constructor(
    private readonly tableName: string,
    dynamoClient?: DynamoDBClient,
  ) {
    const client = dynamoClient ?? new DynamoDBClient({});
    this.docClient = DynamoDBDocumentClient.from(client, {
      marshallOptions: {
        removeUndefinedValues: true,
        convertClassInstanceToMap: true,
      },
    });
  }

  async getPendingRecordsForSlot(query: DispatchSlotQuery): Promise<PendingDispatchRecord[]> {
    const allRecords: PendingDispatchRecord[] = [];
    let lastEvaluatedKey: Record<string, unknown> | undefined;
    const dispatchSlotPk = formatDispatchSlotPk(
      query.targetDate,
      query.slotId,
      query.slotsPerDay,
    );

    do {
      const params: QueryCommandInput = {
        TableName: this.tableName,
        IndexName: 'dispatch-slot-index',
        KeyConditionExpression: 'dispatchSlotPk = :dispatchSlotPk',
        ExpressionAttributeValues: {
          ':dispatchSlotPk': dispatchSlotPk,
        },
        ...(lastEvaluatedKey && { ExclusiveStartKey: lastEvaluatedKey }),
      };

      const response = await this.docClient.send(new QueryCommand(params));

      const items = (response.Items ?? []) as PendingDispatchRecord[];
      allRecords.push(...items);

      lastEvaluatedKey = response.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (lastEvaluatedKey !== undefined);

    return allRecords;
  }
}
